const { filterResultsWithAI } = require("../lib/discover-ai-filter");
const { searchPlacesAPI } = require("../lib/places-search");

const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

const EXCLUDE_DOMAINS = [
  "indeed.com", "mynavi.jp", "rikunabi.com", "doda.jp", "en-gage.net",
  "townpage.ntt.co.jp", "itp.ne.jp", "facebook.com", "twitter.com",
  "x.com", "instagram.com", "wikipedia.org", "prtimes.jp", "baitoru.com",
  "hellowork.careers", "hakenlist.com", "job-j.net", "baseconnect.in",
  "salesnow.jp", "compalyze.co.jp", "citydo.com", "hurex.jp", "data-max.co.jp",
  "aceweb.jp", "pref.gunma.jp", "froma.jp", "jobhopper.jp", "townwork.net",
  "shigotoaruwa.com", "hatarako.net", "workin.jp", "indeedjapan.com",
  "careercross.com", "type.jp", "nikkei.com", "nikkan.co.jp",
];

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POSTメソッドのみ対応しています" });
  }

  const body = req.body || {};
  const params = {
    industry:     String(body.industry     || "").trim(),
    prefecture:   String(body.prefecture   || "").trim(),
    city:         String(body.city         || "").trim(),
    keyword:      String(body.keyword      || "").trim(),
    size:         String(body.size         || "").trim(),
    listing:      String(body.listing      || "").trim(),
    founding_age: String(body.founding_age || "").trim(),
    revenue:      String(body.revenue      || "").trim(),
    hiring:       String(body.hiring       || "").trim(),
  };

  const hasAnyParam = params.industry || params.prefecture || params.city || params.keyword ||
    params.size || params.listing || params.founding_age || params.revenue || params.hiring;
  if (!hasAnyParam) {
    return res.status(400).json({ error: "industry, prefecture, city, keyword, size, listing, founding_age, revenue, hiring のいずれかが必要です" });
  }

  const braveKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!braveKey) {
    return res.status(200).json({
      configured: false,
      message: "検索機能はまだ設定されていません(Brave Search APIキー未設定)",
    });
  }

  // AI判定フィルタ・Places検索向けの補助的な地域/キーワード文字列
  const locationStr = [params.prefecture, params.city].filter(Boolean).join("");
  const descStr = [params.industry, params.size, params.listing, params.founding_age, params.revenue, params.hiring, params.keyword]
    .filter(Boolean).join(" ");

  try {
    // 1. Brave検索 → ブラックリスト除外 → ホスト名重複除去
    const webResults = await searchViaBrave(params, braveKey);

    // 2. AI判定フィルタ (ANTHROPIC_API_KEY未設定なら素通り)
    const filteredResults = await filterResultsWithAI(webResults, locationStr, descStr);

    // 3. Places API (GOOGLE_PLACES_API_KEY未設定なら空配列)
    const placesResults = await searchPlacesAPI(locationStr, descStr);

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

// Brave Search APIのクエリ文字数制限(400文字程度)対策。
// クエリには最小限の除外のみ含め、EXCLUDE_DOMAINS全体でのフィルタリングは
// isExcluded()によるコード側の後処理(searchViaBrave内)で行う。
const QUERY_MAX_LENGTH = 200;
const QUERY_EXCLUDE_WORDS = ["-求人", "-採用", "-転職", "-一覧", "-ランキング"];
const QUERY_EXCLUDE_DOMAINS = EXCLUDE_DOMAINS.slice(0, 15);

function buildQuery(params) {
  const parts = [];
  if (params.prefecture) parts.push(params.prefecture);
  if (params.city) parts.push(params.city);
  if (params.industry) parts.push(params.industry);
  if (params.size) parts.push(params.size);
  if (params.listing) parts.push(params.listing);
  if (params.founding_age) parts.push(params.founding_age);
  if (params.revenue) parts.push(params.revenue);
  if (params.hiring) parts.push(params.hiring);
  if (params.keyword) parts.push(params.keyword);
  parts.push("公式サイト");

  const base = parts.join(" ");
  const wordExcludes = QUERY_EXCLUDE_WORDS.join(" ");

  // 200文字に収まる範囲でsite:除外を追加。収まりきらない分はコード側フィルタに任せる
  const siteExcludes = [];
  for (const d of QUERY_EXCLUDE_DOMAINS) {
    const candidate = [base, wordExcludes, ...siteExcludes, `-site:${d}`].join(" ");
    if (candidate.length > QUERY_MAX_LENGTH) break;
    siteExcludes.push(`-site:${d}`);
  }

  return [base, wordExcludes, ...siteExcludes].join(" ");
}

async function searchViaBrave(params, apiKey) {
  const query = buildQuery(params);
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
