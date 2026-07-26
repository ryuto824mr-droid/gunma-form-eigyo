const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

async function getAccessToken() {
  const clientId     = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    return null;
  }

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id:     clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type:    "refresh_token",
    }),
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    throw new Error(`アクセストークン取得失敗: ${JSON.stringify(tokenData)}`);
  }
  return tokenData.access_token;
}

async function sendEmail({ to, subject, body, attachment }) {
  const accessToken = await getAccessToken();
  if (!accessToken) return { configured: false };

  const from = process.env.SENDER_EMAIL || "me";
  const subjectHeader = `Subject: =?UTF-8?B?${Buffer.from(subject || "").toString("base64")}?=`;
  const bodyB64 = Buffer.from(body || "").toString("base64");

  let rawMail;
  if (attachment && attachment.filename && attachment.content_type && attachment.file_data) {
    const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    rawMail = [
      `From: ${from}`,
      `To: ${to}`,
      subjectHeader,
      "MIME-Version: 1.0",
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      bodyB64,
      "",
      `--${boundary}`,
      `Content-Type: ${attachment.content_type}; name="${attachment.filename}"`,
      `Content-Disposition: attachment; filename="${attachment.filename}"`,
      "Content-Transfer-Encoding: base64",
      "",
      attachment.file_data,
      "",
      `--${boundary}--`,
    ].join("\r\n");
  } else {
    rawMail = [
      `From: ${from}`,
      `To: ${to}`,
      subjectHeader,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      bodyB64,
    ].join("\r\n");
  }

  const encoded = Buffer.from(rawMail)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const sendRes = await fetch(`${GMAIL_API_BASE}/messages/send`, {
    method: "POST",
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw: encoded }),
  });
  const sendData = await sendRes.json();
  if (!sendRes.ok) {
    throw new Error(`Gmail送信失敗: ${JSON.stringify(sendData)}`);
  }

  return { configured: true, messageId: sendData.id };
}

// labelNameが存在すればそのID、存在しなければ作成してIDを返す。未設定環境ではnull
async function ensureLabel(labelName) {
  const accessToken = await getAccessToken();
  if (!accessToken) return null;

  const listRes = await fetch(`${GMAIL_API_BASE}/labels`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const listData = await listRes.json();
  if (!listRes.ok) {
    throw new Error(`ラベル一覧取得失敗: ${JSON.stringify(listData)}`);
  }

  const existing = (listData.labels || []).find(l => l.name === labelName);
  if (existing) return existing.id;

  const createRes = await fetch(`${GMAIL_API_BASE}/labels`, {
    method: "POST",
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: labelName,
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
    }),
  });
  const createData = await createRes.json();
  if (!createRes.ok) {
    throw new Error(`ラベル作成失敗: ${JSON.stringify(createData)}`);
  }
  return createData.id;
}

async function addLabelToMessage(messageId, labelId) {
  const accessToken = await getAccessToken();
  if (!accessToken || !labelId) return;

  const res = await fetch(`${GMAIL_API_BASE}/messages/${messageId}/modify`, {
    method: "POST",
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ addLabelIds: [labelId] }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`ラベル付与失敗: ${JSON.stringify(data)}`);
  }
}

module.exports = { sendEmail, ensureLabel, addLabelToMessage };
