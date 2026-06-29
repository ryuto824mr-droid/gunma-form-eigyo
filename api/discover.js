const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POSTメソッドのみ対応しています" });
  }

  const { query } = req.body || {};
  if (!query || typeof query !== "string" || !query.trim()) {
    return res.status(400).json({ error: "query（文字列）が必要です" });
  }

  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    return res.status(200).json({
      configured: false,
      message: "検索機能はまだ設定されていません(Brave Search APIキー未設定)",
    });
  }

  try {
    const results = await searchCompaniesViaBrave(query.trim(), apiKey);
    return res.status(200).json({ configured: true, results });
  } catch (err) {
    return res.status(500).json({ error: `検索エラー: ${err.message}` });
  }
};

async function searchCompaniesViaBrave(query, apiKey) {
  const url = `${BRAVE_SEARCH_URL}?q=${encodeURIComponent(query)}&count=10`;
  const res = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": apiKey,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Brave Search APIエラー (${res.status}): ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const webResults = data.web?.results || [];

  return webResults.map(r => ({
    name: r.title || r.url,
    url: r.url,
  }));
}
