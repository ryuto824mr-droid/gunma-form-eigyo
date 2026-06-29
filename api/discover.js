const { filterResultsWithAI } = require("../lib/discover-ai-filter");
const { searchPlacesAPI } = require("../lib/places-search");

const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

const EXCLUDE_DOMAINS = [
  "indeed.com", "mynavi.jp", "rikunabi.com", "doda.jp", "en-gage.net",
  "townpage.ntt.co.jp", "itp.ne.jp", "facebook.com", "twitter.com",
  "x.com", "instagram.com", "wikipedia.org", "prtimes.jp", "baitoru.com",
];

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POSTメソッドのみ対応しています" });
  }

  const { region = "", keyword = "" } = req.body || {};
  if (!String(region).trim() && !String(keyword).trim()) {
    return res.status(400).json({ error: "regionまたはkeywordが必要です" });
  }

  const braveKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!braveKey) {
    return res.status(200).json({
      configured: false,
      message: "検索機能はまだ設定されていません(Brave Search APIキー未設定)",
    });
  }

  try {
    // 1. Brave検索 → ブラックリスト除外 → ホスト名重複除去
    const webResults = await searchViaBrave(String(region).trim(), String(keyword).trim(), braveKey);

    // 2. AI判定フィルタ (ANTHROPIC_API_KEY未設定なら素通り)
    const filteredResults = await filterResultsWithAI(webResults, String(region).trim(), String(keyword).trim());

    // 3. Places API (GOOGLE_PLACES_API_KEY未設定なら空配列)
    const placesResults = await searchPlacesAPI(String(region).trim(), String(keyword).trim());

    // 4. マージ・ホスト名重複除去 (web優先、Placesが後ろ)
    const merged = mergeAndDedup([...filteredResults, ...placesResults]);

    return res.status(200).json({ configured: true, results: merged });
  } catch (err) {
    return res.status(500).json({ error: `検索エラー: ${err.message}` });
  }
};

function getHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function isExcluded(url) {
  const host = getHostname(url);
  return EXCLUDE_DOMAINS.some(d => host === d || host.endsWith(`.${d}`));
}

async function searchViaBrave(region, keyword, apiKey) {
  const exclusions = EXCLUDE_DOMAINS.map(d => `-site:${d}`).join(" ");
  const query = `${region} ${keyword} 公式サイト ${exclusions}`.trim();
  const url = `${BRAVE_SEARCH_URL}?q=${encodeURIComponent(query)}&count=20`;

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

  // ブラックリスト除外 + ホスト名重複除去
  const seen = new Set();
  const results = [];
  for (const r of webResults) {
    if (isExcluded(r.url)) continue;
    const host = getHostname(r.url);
    if (seen.has(host)) continue;
    seen.add(host);
    results.push({ name: r.title || r.url, url: r.url, source: "web" });
  }
  return results;
}

function mergeAndDedup(results) {
  const seen = new Set();
  const merged = [];
  for (const r of results) {
    const host = getHostname(r.url);
    if (seen.has(host)) continue;
    seen.add(host);
    merged.push(r);
  }
  return merged;
}
