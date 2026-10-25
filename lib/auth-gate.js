// lib/auth-gate.js
//
// 全ページ・全APIの入口の守り(共通パスワード + 署名付きCookie)。middleware.js(Vercel の Routing
// Middleware)から呼ばれ、要求ごとに「通す(null)」か「返す Response」を決める。Web 標準の
// Request / Response / crypto.subtle だけを使う純粋な関数で、DB には触れない(テストで env を渡せるようにするため)。
//
// 守りの外(ログインなしで通す)のは次だけ:
//   - ログイン画面(/login.html)・ロゴ画像(/logo.jpg)・クリック計測の戻り先(/link-invalid.html)
//   - ログイン・ログアウトの処理(/auth/login, /auth/logout。このファイルで処理し、api/ の関数は増やさない)
//   - 毎日の cron(/api/crm?action=run-scheduled-sends・run-send-queue, /api/analytics?action=check-replies)で、
//     Authorization: Bearer <CRON_SECRET> が一致する要求
//   - メールのクリック計測(GET /api/crm で、action がちょうど1つの track-click の要求)
// それ以外は、ログインの Cookie が無ければ、ページはログイン画面へ、API は 401 にする。
//
// 環境変数:
//   APP_PASSWORD  共通のログインパスワード
//   AUTH_SECRET   Cookie の署名の鍵。APP_PASSWORD と合わせて署名するため、どちらかを変えると全員のログインが切れる
//   CRON_SECRET   Vercel の cron が Authorization: Bearer に付ける鍵
// APP_PASSWORD・AUTH_SECRET が無いときは誰もログインできない(守りを外さない)。

const COOKIE_NAME = "gfe_auth";
const SESSION_DAYS = 30;
const LOGIN_PAGE = "/login.html";
const LINK_INVALID_PAGE = "/link-invalid.html";
const PUBLIC_PATHS = new Set([LOGIN_PAGE, "/logo.jpg", LINK_INVALID_PAGE]);
const CRON_ROUTES = [
  { path: "/api/crm", action: "run-scheduled-sends" },
  // 送信待ちの送信だけ(1日に何回か外から呼ぶ。api/crm.js の run-send-queue)
  { path: "/api/crm", action: "run-send-queue" },
  // 企業探しとリサーチだけ(api/crm.js の run-discover)
  { path: "/api/crm", action: "run-discover" },
  { path: "/api/analytics", action: "check-replies" },
];

const encoder = new TextEncoder();

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacHex(key, message) {
  const cryptoKey = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message)));
}

// 長さの違いも含めて、比べる時間が中身で変わらないようにする
function safeEqual(a, b) {
  const x = String(a);
  const y = String(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function authConfigured(env) {
  return !!(env.APP_PASSWORD && env.AUTH_SECRET);
}

function signingKey(env) {
  return `${env.AUTH_SECRET}\n${env.APP_PASSWORD}`;
}

// Cookie の値は「有効期限(ミリ秒).署名」
async function createSessionValue(env, now = Date.now()) {
  const expires = now + SESSION_DAYS * 24 * 60 * 60 * 1000;
  return `${expires}.${await hmacHex(signingKey(env), `session:${expires}`)}`;
}

async function verifySessionValue(env, value, now = Date.now()) {
  if (!authConfigured(env) || !value) return false;
  const match = /^(\d{13})\.([0-9a-f]{64})$/.exec(value);
  if (!match) return false;
  const expires = Number(match[1]);
  if (!(expires > now)) return false;
  return safeEqual(match[2], await hmacHex(signingKey(env), `session:${expires}`));
}

function readCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function sessionCookie(value, maxAgeSeconds) {
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

// ログイン後の戻り先は、このサイトの中のパスだけ(「//evil.example」や「/\evil」で外へ飛ばさない)
function safeNextPath(next) {
  if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return "/";
  if (next.startsWith(LOGIN_PAGE) || next.startsWith("/auth/")) return "/";
  return next;
}

function redirect(location, extraHeaders = {}) {
  return new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store", ...extraHeaders } });
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// クエリの action が「ちょうど1つで、その値」のときだけ true。名前の大小・action[] などの
// 似た名前も数えるので、「?action=track-click&action=send-queue」「&Action=…」「&action[]=…」では抜けられない
function hasSingleAction(url, expected) {
  let count = 0;
  let value = null;
  for (const [key, v] of url.searchParams) {
    if (key.trim().toLowerCase().startsWith("action")) {
      count++;
      value = key === "action" ? v : null;
    }
  }
  return count === 1 && value === expected;
}

function isTrackClick(request, url) {
  return request.method === "GET" && url.pathname === "/api/crm" && hasSingleAction(url, "track-click");
}

function isCronRequest(request, url, env) {
  if (!env.CRON_SECRET) return false;
  // 同じ入口(/api/crm)に cron の処理が複数ある(run-scheduled-sends・run-send-queue)ため、入口と action の組で探す
  const route = CRON_ROUTES.find((r) => r.path === url.pathname && hasSingleAction(url, r.action));
  if (!route) return false;
  return safeEqual(request.headers.get("authorization") || "", `Bearer ${env.CRON_SECRET}`);
}

async function handleLogin(request, env) {
  if (request.method !== "POST") return redirect(LOGIN_PAGE);
  let password = "";
  let next = "/";
  try {
    const form = await request.formData();
    password = String(form.get("password") || "");
    next = safeNextPath(String(form.get("next") || "/"));
  } catch {
    // 形式が違う送信は、パスワード違いと同じ扱い
  }
  if (!authConfigured(env)) {
    return redirect(`${LOGIN_PAGE}?error=config&next=${encodeURIComponent(next)}`);
  }
  // 長さを揃えて比べるため、どちらも署名してから比べる
  const ok = safeEqual(await hmacHex(env.AUTH_SECRET, password), await hmacHex(env.AUTH_SECRET, env.APP_PASSWORD));
  if (!ok) return redirect(`${LOGIN_PAGE}?error=1&next=${encodeURIComponent(next)}`);
  const value = await createSessionValue(env);
  return redirect(next, {
    "Set-Cookie": sessionCookie(value, SESSION_DAYS * 24 * 60 * 60),
  });
}

// 戻り値: null なら通す。Response ならそれを返す
async function gate(request, env = {}) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/auth/login") return handleLogin(request, env);
  if (path === "/auth/logout") return redirect(LOGIN_PAGE, { "Set-Cookie": sessionCookie("", 0) });
  if (PUBLIC_PATHS.has(path)) return null;
  if (isTrackClick(request, url)) return null;
  if (isCronRequest(request, url, env)) return null;
  if (await verifySessionValue(env, readCookie(request, COOKIE_NAME))) return null;

  if (path === "/api" || path.startsWith("/api/")) {
    return jsonResponse(401, { error: "ログインが必要です。画面を開き直してログインしてください" });
  }
  return redirect(`${LOGIN_PAGE}?next=${encodeURIComponent(path + url.search)}`);
}

module.exports = {
  gate, createSessionValue, verifySessionValue, hasSingleAction, safeNextPath,
  COOKIE_NAME, LOGIN_PAGE, LINK_INVALID_PAGE,
};
