// 入口の守り(lib/auth-gate.js)のテスト。Web 標準の Request を作って gate() に渡すだけで、
// ページ・API・DB には触れない。
// いまはログインの守りを外している(middleware.js が無い)。lib/auth-gate.js は戻すときのために残し、
// このテストで動きを確かめ続ける。戻し方は末尾のテストのコメントを見る
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { gate, createSessionValue, verifySessionValue, safeNextPath, COOKIE_NAME } = require("../lib/auth-gate");

const BASE = "https://gunma-form-eigyo.vercel.app";
const ENV = { APP_PASSWORD: "correct horse battery", AUTH_SECRET: "s".repeat(40), CRON_SECRET: "cron-key-123" };

function req(pathAndQuery, init = {}) {
  return new Request(BASE + pathAndQuery, init);
}

async function loginCookie(env = ENV) {
  return `${COOKIE_NAME}=${await createSessionValue(env)}`;
}

function loginPost(password, next = "/") {
  return req("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password, next }).toString(),
  });
}

// ---- cron ----

test("鍵付きの cron は通る(送信・返信チェック)", async () => {
  const auth = { headers: { Authorization: "Bearer cron-key-123" } };
  assert.equal(await gate(req("/api/crm?action=run-scheduled-sends", auth), ENV), null);
  assert.equal(await gate(req("/api/crm?action=run-send-queue", auth), ENV), null, "送信だけの処理(外から1日に何回か呼ぶ)");
  assert.equal(await gate(req("/api/analytics?action=check-replies", auth), ENV), null);
  // 鍵が無ければ送信だけの処理も 401
  assert.equal((await gate(req("/api/crm?action=run-send-queue"), ENV)).status, 401);
  assert.equal((await gate(req("/api/crm?action=run-send-queue&action=send-queue", auth), ENV)).status, 401);
});

test("鍵なし・鍵違いの cron は 401", async () => {
  for (const headers of [{}, { Authorization: "Bearer wrong" }, { Authorization: "cron-key-123" }, { Authorization: "Bearer cron-key-1234" }]) {
    for (const p of ["/api/crm?action=run-scheduled-sends", "/api/analytics?action=check-replies"]) {
      const res = await gate(req(p, { headers }), ENV);
      assert.equal(res.status, 401, `${p} ${JSON.stringify(headers)}`);
    }
  }
});

test("CRON_SECRET が未登録なら、Bearer を付けても通らない", async () => {
  const env = { ...ENV, CRON_SECRET: "" };
  const res = await gate(req("/api/crm?action=run-scheduled-sends", { headers: { Authorization: "Bearer " } }), env);
  assert.equal(res.status, 401);
});

test("cron の鍵は cron の2つの入口でしか使えない(他の API・重ね指定・debug-gmail は 401)", async () => {
  const auth = { headers: { Authorization: "Bearer cron-key-123" } };
  for (const p of [
    "/api/crm?action=send-queue",
    "/api/submit-form",
    "/api/analytics?action=debug-gmail",
    "/api/crm?action=run-scheduled-sends&action=send-queue",
    "/api/analytics?action=check-replies&Action=debug-gmail",
    "/home.html",
  ]) {
    const res = await gate(req(p, auth), ENV);
    assert.ok(res, p);
    assert.notEqual(res.status, 200, p);
  }
});

// ---- 未ログイン ----

test("未ログインのページはログイン画面へ(戻り先付き)", async () => {
  for (const p of ["/", "/home.html", "/send.html?project=locle", "/nav-menu.js", "/ozukanzukan-logo.png", "/work-report.html"]) {
    const res = await gate(req(p), ENV);
    assert.equal(res.status, 303, p);
    const loc = new URL(res.headers.get("location"), BASE);
    assert.equal(loc.pathname, "/login.html", p);
    assert.equal(loc.searchParams.get("next"), p, p);
  }
});

test("未ログインの API は 401(check-replies・debug-gmail・送信系も)", async () => {
  for (const [p, method] of [
    ["/api/companies", "GET"],
    ["/api/crm?action=later-list&project=locle", "GET"],
    ["/api/analytics?action=check-replies", "GET"],
    ["/api/analytics?action=debug-gmail", "GET"],
    ["/api/submit-form", "POST"],
    ["/api/send-email", "POST"],
    ["/api/crm?action=send-queue", "POST"],
  ]) {
    const res = await gate(req(p, { method }), ENV);
    assert.equal(res.status, 401, p);
    assert.match(res.headers.get("content-type"), /application\/json/);
    assert.ok((await res.json()).error);
  }
});

test("ログイン画面・ロゴ・リンクの案内ページだけは未ログインでも通る", async () => {
  assert.equal(await gate(req("/login.html"), ENV), null);
  assert.equal(await gate(req("/login.html?next=%2Fhome.html&error=1"), ENV), null);
  assert.equal(await gate(req("/logo.jpg"), ENV), null);
  assert.equal(await gate(req("/link-invalid.html"), ENV), null);
});

test("偽物・期限切れ・別の鍵で作った Cookie では通らない", async () => {
  const expired = await createSessionValue(ENV, Date.now() - 31 * 24 * 60 * 60 * 1000);
  const otherKey = await createSessionValue({ ...ENV, AUTH_SECRET: "x".repeat(40) });
  const oldPassword = await createSessionValue({ ...ENV, APP_PASSWORD: "old password" });
  const valid = await createSessionValue(ENV);
  const tampered = valid.replace(/^\d+/, String(Date.now() + 365 * 24 * 60 * 60 * 1000));
  for (const value of [expired, otherKey, oldPassword, tampered, "1", "", "abc.def"]) {
    const res = await gate(req("/api/companies", { headers: { Cookie: `${COOKIE_NAME}=${value}` } }), ENV);
    assert.equal(res.status, 401, value);
  }
});

test("APP_PASSWORD・AUTH_SECRET が未登録なら、誰も通さない(守りを外さない)", async () => {
  const env = { CRON_SECRET: ENV.CRON_SECRET };
  const res = await gate(req("/api/companies", { headers: { Cookie: await loginCookie() } }), env);
  assert.equal(res.status, 401);
  assert.equal(await verifySessionValue(env, await createSessionValue(ENV)), false);
  const login = await gate(loginPost(""), env);
  assert.equal(new URL(login.headers.get("location"), BASE).searchParams.get("error"), "config");
  assert.equal(login.headers.get("set-cookie"), null);
});

// ---- ログイン ----

test("正しいパスワードでログインすると Cookie が付き、以後ページも API も通る", async () => {
  const res = await gate(loginPost("correct horse battery", "/send.html?project=locle"), ENV);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/send.html?project=locle");
  const setCookie = res.headers.get("set-cookie");
  assert.match(setCookie, new RegExp(`^${COOKIE_NAME}=\\d{13}\\.[0-9a-f]{64};`));
  for (const flag of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]) assert.ok(setCookie.includes(flag), flag);

  const cookie = setCookie.split(";")[0];
  for (const [p, method] of [
    ["/home.html", "GET"],
    ["/", "GET"],
    ["/api/companies", "GET"],
    ["/api/analytics?action=check-replies", "GET"],
    ["/api/analytics?action=debug-gmail", "GET"],
    ["/api/submit-form", "POST"],
  ]) {
    assert.equal(await gate(req(p, { method, headers: { Cookie: `other=1; ${cookie}` } }), ENV), null, p);
  }
});

test("パスワード違いではログインできず、ログイン画面にエラー付きで戻る", async () => {
  for (const pw of ["wrong", "", "correct horse batter", "correct horse battery "]) {
    const res = await gate(loginPost(pw, "/home.html"), ENV);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("set-cookie"), null, pw);
    const loc = new URL(res.headers.get("location"), BASE);
    assert.equal(loc.pathname, "/login.html");
    assert.equal(loc.searchParams.get("error"), "1");
    assert.equal(loc.searchParams.get("next"), "/home.html");
  }
});

test("ログインの GET はログイン画面へ戻すだけ", async () => {
  const res = await gate(req("/auth/login"), ENV);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/login.html");
  assert.equal(res.headers.get("set-cookie"), null);
});

test("ログイン後の戻り先は、このサイトの中のパスだけ", () => {
  assert.equal(safeNextPath("/send.html?x=1"), "/send.html?x=1");
  for (const bad of ["https://evil.example/", "//evil.example/", "/\\evil.example", "evil", "", "/login.html", "/auth/logout"]) {
    assert.equal(safeNextPath(bad), "/", bad);
  }
});

test("ログアウトで Cookie を消してログイン画面へ", async () => {
  const res = await gate(req("/auth/logout", { headers: { Cookie: await loginCookie() } }), ENV);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/login.html");
  assert.match(res.headers.get("set-cookie"), new RegExp(`^${COOKIE_NAME}=;.*Max-Age=0`));
});

// ---- クリック計測 ----

test("クリック計測(GET・action がちょうど1つの track-click)は未ログインでも通る", async () => {
  const url = encodeURIComponent("https://example.com/page?a=1&action=x");
  assert.equal(await gate(req(`/api/crm?action=track-click&send_log_id=12&url=${url}`), ENV), null);
  assert.equal(await gate(req(`/api/crm?send_log_id=12&action=track-click`), ENV), null);
});

test("クリック計測は重ね指定・似た名前・別の入口・GET 以外では抜けられない", async () => {
  for (const [p, method] of [
    ["/api/crm?action=track-click&action=send-queue", "GET"],
    ["/api/crm?action=send-queue&action=track-click", "GET"],
    ["/api/crm?action=track-click&action=track-click", "GET"],
    ["/api/crm?action=track-click&Action=send-queue", "GET"],
    ["/api/crm?action=track-click&ACTION=send-queue", "GET"],
    ["/api/crm?action=track-click&action[]=send-queue", "GET"],
    ["/api/crm?action=track-click&action%20=send-queue", "GET"],
    ["/api/crm?Action=track-click", "GET"],
    ["/api/crm?action=track-click%00", "GET"],
    ["/api/crm?action=TRACK-CLICK", "GET"],
    ["/api/crm?action=track-click", "POST"],
    ["/api/crm?action=track-click", "HEAD"],
    ["/api/crm/?action=track-click", "GET"],
    ["/api/crm.js?action=track-click", "GET"],
    ["/api/analytics?action=track-click", "GET"],
    ["/api/submit-form?action=track-click", "POST"],
  ]) {
    const res = await gate(req(p, { method }), ENV);
    assert.ok(res, `${method} ${p}`);
    assert.equal(res.status, 401, `${method} ${p}`);
  }
});

// ---- middleware.js(いまは外している) ----

// 戻すときは、リポジトリ直下に次の middleware.js を置く(Vercel の関数の数に1つ数えられる):
//   import authGate from "./lib/auth-gate.js";
//   export default async function middleware(request) { return authGate.gate(request, process.env); }
//   export const config = { runtime: "nodejs" };
// 戻すまでは、ログイン画面・ログアウトは使われない
test("ログインの守りは外している: middleware.js は無く、戻すための部品は残っている", () => {
  const root = path.join(__dirname, "..");
  assert.equal(fs.existsSync(path.join(root, "middleware.js")), false);
  assert.equal(typeof gate, "function");
  assert.ok(fs.existsSync(path.join(root, "public", "login.html")));
  assert.ok(fs.existsSync(path.join(root, "public", "link-invalid.html")));
});
