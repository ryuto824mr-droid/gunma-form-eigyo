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

async function fetchReplies(senderId) {
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

  const listRes = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages?q=newer_than%3A7d&maxResults=20",
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

module.exports = { fetchReplies, testGmailAuth };
