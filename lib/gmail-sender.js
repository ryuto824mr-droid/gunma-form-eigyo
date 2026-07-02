async function sendEmail({ to, subject, body }) {
  const clientId     = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    return { configured: false };
  }

  // 1. アクセストークン取得
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

  // 2. RFC 2822 メール文字列を構築して base64url エンコード
  const from    = process.env.SENDER_EMAIL || "me";
  const rawMail = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject || "").toString("base64")}?=`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(body || "").toString("base64"),
  ].join("\r\n");

  const encoded = Buffer.from(rawMail)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  // 3. Gmail API で送信
  const sendRes = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      headers: {
        Authorization:  `Bearer ${tokenData.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw: encoded }),
    }
  );
  const sendData = await sendRes.json();
  if (!sendRes.ok) {
    throw new Error(`Gmail送信失敗: ${JSON.stringify(sendData)}`);
  }

  return { configured: true, messageId: sendData.id };
}

module.exports = { sendEmail };
