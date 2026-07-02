async function getAccessToken() {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id:     process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      refresh_token: process.env.GMAIL_REFRESH_TOKEN,
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

async function fetchReplies() {
  if (
    !process.env.GMAIL_CLIENT_ID ||
    !process.env.GMAIL_CLIENT_SECRET ||
    !process.env.GMAIL_REFRESH_TOKEN
  ) {
    return [];
  }

  const token   = await getAccessToken();
  const headers = { Authorization: `Bearer ${token}` };

  const listRes = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is%3Aunread&maxResults=20",
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

module.exports = { fetchReplies };
