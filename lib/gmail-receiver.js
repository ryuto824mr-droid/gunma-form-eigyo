const { sql } = require("./db");

// senderIdが指定されていればsender_accountsテーブルから有効なアカウントの
// refresh_tokenを取得し、未指定なら環境変数のデフォルトアカウントを使う
// (後方互換性のため。現状これを呼ぶ既存コードはすべてsenderId未指定で、
// 従来通り単一の受信アカウントをチェックする挙動のまま変わらない)。
async function resolveRefreshToken(senderId) {
  if (senderId === undefined || senderId === null) {
    return process.env.GMAIL_REFRESH_TOKEN || null;
  }
  const [account] = await sql`
    SELECT refresh_token FROM sender_accounts WHERE id = ${senderId} AND is_active = TRUE
  `;
  if (!account) {
    throw new Error("指定された送信者アカウントが見つからないか、無効化されています");
  }
  return account.refresh_token;
}

async function getAccessToken(senderId) {
  const refreshToken = await resolveRefreshToken(senderId);
  if (!refreshToken) throw new Error("リフレッシュトークンが設定されていません");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id:     process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type:    "refresh_token",
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`トークン取得失敗: ${JSON.stringify(data)}`);
  return data.access_token;
}

function extractBodyText(payload) {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return Buffer.from(payload.body.data, "base64").toString("utf-8");
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const text = extractBodyText(part);
      if (text) return text;
    }
  }
  return "";
}

async function fetchReplies(senderId, { days = 7, maxResults = 20 } = {}) {
  if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET) {
    return [];
  }

  let token;
  try {
    token = await getAccessToken(senderId);
  } catch {
    return [];
  }
  const headers = { Authorization: `Bearer ${token}` };

  const q = encodeURIComponent(`newer_than:${days}d`);
  const listRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=${maxResults}`,
    { headers }
  );
  const listData = await listRes.json();
  if (!listData.messages || listData.messages.length === 0) return [];

  const results = [];
  for (const { id } of listData.messages) {
    const msgRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
      { headers }
    );
    const msg  = await msgRes.json();
    const hdrs = (msg.payload?.headers || []).reduce((acc, h) => {
      acc[h.name.toLowerCase()] = h.value;
      return acc;
    }, {});

    results.push({
      messageId: id,
      from:      hdrs["from"]    || "",
      subject:   hdrs["subject"] || "",
      date:      hdrs["date"]    || "",
      body:      extractBodyText(msg.payload),
    });
  }

  return results;
}

async function testGmailAuth(senderId) {
  if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET) {
    return { ok: false, error: "環境変数が未設定です" };
  }
  try {
    await getAccessToken(senderId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// お礼メール/自動返信の検知に使う件名キーワード。必須条件ではなく、判定の確度を
// 上げるための補助情報としてのみ使う(ドメイン一致のみでも「送信成功の可能性が高い」
// とみなしてstatusを更新する)
const FORM_CONFIRMATION_SUBJECT_KEYWORDS = [
  "お問い合わせ", "お問合せ", "お問合わせ", "受付", "受け付け", "ありがとう", "確認",
];

function extractEmailAddress(from) {
  const m = (from || "").match(/<([^>]+)>/);
  return (m ? m[1] : from || "").toLowerCase().trim();
}

function extractDomainFromEmail(email) {
  return (email || "").split("@")[1] || "";
}

// api/discover.js等と同じ「www.を取り除いたホスト名」抽出ロジック
function getHostnameFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function hasConfirmationKeyword(subject) {
  const s = (subject || "").toLowerCase();
  return FORM_CONFIRMATION_SUBJECT_KEYWORDS.some(k => s.includes(k.toLowerCase()));
}

// send_logsでstatus='uncertain' AND channel='form'の記録について、送信先企業のドメインから
// 送信日時より後に届いたメールが無いか確認する。見つかればお礼メール・自動返信を受信できた
// (=実際にはフォームが送信できていた)とみなし、statusを'sent'に更新する。
// (lib/form-submitter.jsの完了判定バグにより、実際には届いていたのにuncertainのまま
// 残ってしまった記録を、後から正しい状態に是正するための機能)
async function checkFormConfirmationEmails(senderId, { days, maxResults, companyIds } = {}) {
  const emails = await fetchReplies(senderId, { days, maxResults });
  const checked = emails.length;

  const uncertainLogs = Array.isArray(companyIds) && companyIds.length > 0
    ? await sql`
        SELECT sl.id, sl.company_id, sl.sent_at, c.url AS company_url, c.name AS company_name
        FROM send_logs sl
        JOIN companies c ON c.id = sl.company_id
        WHERE sl.status = 'uncertain' AND sl.channel = 'form' AND sl.company_id = ANY(${companyIds})
      `
    : await sql`
        SELECT sl.id, sl.company_id, sl.sent_at, c.url AS company_url, c.name AS company_name
        FROM send_logs sl
        JOIN companies c ON c.id = sl.company_id
        WHERE sl.status = 'uncertain' AND sl.channel = 'form'
      `;

  // 各ログにドメイン・送信日時(ms)を付与しておく(ドメインが解決できないログは対象外)
  const logsWithDomain = uncertainLogs
    .map(log => ({
      ...log,
      companyDomain: getHostnameFromUrl(log.company_url),
      sentAtMs: new Date(log.sent_at).getTime(),
    }))
    .filter(log => log.companyDomain);

  // 各メールに送信元ドメイン・日時(ms)を付与しておく
  const emailsWithDomain = emails.map((email, index) => ({
    index,
    email,
    fromDomain: extractDomainFromEmail(extractEmailAddress(email.from)),
    dateMs: new Date(email.date).getTime(),
  }));

  // ログ×メールの候補ペアを全て列挙する(ドメイン一致 かつ メール日時が送信日時以降)。
  // 1通のメールが複数のログにまたがって誤って'sent'にしてしまわないよう、
  // 「メール日時と送信日時の差が最小(=最も近い)」組み合わせから優先的に確定させ、
  // 一度使ったログ・メールはそれぞれ以降の割り当て候補から除外する(貪欲法によるマッチング)
  const candidatePairs = [];
  for (const log of logsWithDomain) {
    for (const item of emailsWithDomain) {
      if (!item.fromDomain || item.fromDomain !== log.companyDomain) continue;
      if (!Number.isFinite(item.dateMs) || item.dateMs < log.sentAtMs) continue;
      candidatePairs.push({ log, item, diffMs: item.dateMs - log.sentAtMs });
    }
  }
  candidatePairs.sort((a, b) => a.diffMs - b.diffMs);

  const usedLogIds = new Set();
  const usedEmailIndexes = new Set();
  let confirmed = 0;
  const matches = [];

  for (const pair of candidatePairs) {
    // 既にこのログ、またはこのメールが別の組み合わせで確定済みならスキップする
    // (1通のメールは1件のログにしか対応させない/1件のログも1通のメールにしか使わない)
    if (usedLogIds.has(pair.log.id) || usedEmailIndexes.has(pair.item.index)) continue;

    // WHERE句にstatus='uncertain'も含めて対象を絞ることで、既に他の経路で状態が
    // 変わっていた場合に誤って上書きしないようにする(0件更新ならスキップ)
    const updated = await sql`
      UPDATE send_logs SET status = 'sent' WHERE id = ${pair.log.id} AND status = 'uncertain' RETURNING id
    `;
    if (updated.length === 0) continue;

    usedLogIds.add(pair.log.id);
    usedEmailIndexes.add(pair.item.index);
    confirmed++;
    matches.push({
      send_log_id:     pair.log.id,
      company_name:    pair.log.company_name,
      matched_subject: pair.item.email.subject,
      keyword_matched: hasConfirmationKeyword(pair.item.email.subject),
    });
  }

  return { checked, confirmed, uncertain_count: uncertainLogs.length, matches };
}

module.exports = { fetchReplies, testGmailAuth, checkFormConfirmationEmails };
