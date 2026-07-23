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
  "en-japan.com", "employment.en-japan.com", "04510.jp", "g-boss.my.salesforce-sites.com",
  "jobhouse.jp", "randstad.co.jp", "salesforce-sites.com",
  "xn--pckua2a7gp15o89zb.com", // 求人ボックス
  "stanby.com",
];

// URLのパスにこれらの文字列が含まれる場合も求人ページとみなして除外する
const EXCLUDE_PATH_KEYWORDS = ["job", "recruit", "career", "koyou"];

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

  const debugAuthorized =
    !!process.env.SETUP_SECRET && req.query.debug_key === process.env.SETUP_SECRET;

  try {
    // 1. Brave検索 → ブラックリスト除外 → ホスト名重複除去
    const { results: webResults, stats: braveStats } = await searchViaBrave(params, braveKey);

    // 2. AI判定フィルタ (ANTHROPIC_API_KEY未設定なら素通り)
    const filteredResults = await filterResultsWithAI(webResults, locationStr, descStr);

    // 3. Places API (GOOGLE_PLACES_API_KEY未設定なら空配列)
    const placesResults = await searchPlacesAPI(locationStr, descStr);

    // 4. マージ・ホスト名重複除去 (web優先、Placesが後ろ)
    const merged = mergeAndDedup([...filteredResults, ...placesResults]);

    const payload = { configured: true, results: merged };
    if (debugAuthorized) {
      payload.debug = {
        raw_count: braveStats.raw_count,
        filtered_count: braveStats.filtered_count,
        excluded_reasons: braveStats.excluded_reasons,
        ai_filtered_count: filteredResults.length,
        places_count: placesResults.length,
        merged_count: merged.length,
        query: braveStats.query,
        places_debug: placesResults.debug,
      };
    }
    return res.status(200).json(payload);
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

// Punycode(xn--…)ドメインをデコードし、「求人ボックス」のような日本語の
// 求人系キーワードを含むホスト名を汎用的に検出する
function isJobSiteDomain(hostname) {
  let decoded;
  try {
    decoded = require("url").domainToUnicode(hostname);
  } catch {
    try {
      decoded = require("punycode").toUnicode(hostname);
    } catch {
      return false;
    }
  }
  return /求人|転職|アルバイト|派遣/.test(decoded);
}

// 除外理由を判定する。除外しない場合はnullを返す
function getExclusionReason(url) {
  const host = getHostname(url);
  if (EXCLUDE_DOMAINS.some(d => host === d || host.endsWith(`.${d}`))) return "domain_match";
  if (isJobSiteDomain(host)) return "punycode_job";

  let pathname = "";
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    pathname = url.toLowerCase();
  }
  if (EXCLUDE_PATH_KEYWORDS.some(k => pathname.includes(k))) return "path_match";

  return null;
}

function isExcluded(url) {
  return getExclusionReason(url) !== null;
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
  parts.push("会社概要");

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
  const excludedReasons = { domain_match: 0, path_match: 0, punycode_job: 0, other: 0 };
  const seen = new Set();
  const results = [];
  for (const r of webResults) {
    const reason = getExclusionReason(r.url);
    if (reason) {
      excludedReasons[reason]++;
      continue;
    }
    const host = getHostname(r.url);
    if (seen.has(host)) {
      excludedReasons.other++;
      continue;
    }
    seen.add(host);
    results.push({ name: r.title || r.url, url: r.url, source: "web" });
  }

  return {
    results,
    stats: {
      query,
      raw_count: webResults.length,
      filtered_count: results.length,
      excluded_reasons: excludedReasons,
    },
  };
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
