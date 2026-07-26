const { filterResultsWithAI } = require("../lib/discover-ai-filter");
const { searchPlacesAPI } = require("../lib/places-search");
const { sql } = require("../lib/db");

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
  "map.yahoo.co.jp", "fudosan-career.net",
  "maps.google.com", "map.baidu.com", "mapfan.com", "mapion.co.jp",
  "staffservice.co.jp", "carrikatu-it.com", "o-hara.ac.jp", "chuo.ac.jp",
  "yamada-denki.jp", "biccamera.com", "u-phone.net", "asuka-hu.co.jp", "81100.jp",
  "aboutnet.biz", "lifeservice-gunma.jp", "central-s.co.jp", "hatarakunavi.net",
  "ws-gp.com", "sss-gp.com", "sougo-career.jp", "gunso-staff.co.jp",
  "hirayamastaff.co.jp", "jsite.mhlw.go.jp", "lafio.jp",
  "gsn.ed.jp", "ed.jp", // ed.jp: 日本の学校・教育委員会専用ドメイン
  "city.takasaki.gunma.jp", "city.fujioka.gunma.jp", "city.tomioka.lg.jp",
  "sites.google.com",
  "lg.jp", // 地方公共団体専用ドメイン
];

// 業種を問わず常に除外する人材派遣・求人系のキーワード(企業名/タイトルに含まれる場合)
const NOISE_NAME_KEYWORDS = [
  "スタッフサービス", "スタッフ株式会社", "人材", "派遣", "キャリアオプション",
  "ハローワーク", "hellowork", "job", "求人", "採用サポート", "就労移行支援",
  "ワークス", "はたらく", "hatarakunavi", "求人ワーク",
  "教育センター", "教育委員会", "特別支援学校", "生涯学習センター",
  "市役所", "県庁", "保健所", "児童相談所",
];

function isNoisyName(rawName) {
  if (!rawName) return false;
  const name = rawName.toLowerCase();
  return NOISE_NAME_KEYWORDS.some(k => name.includes(k.toLowerCase()));
}

// URLのホスト名やパスにこれらの文字列が含まれる場合も求人ページとみなして除外する
const EXCLUDE_PATH_KEYWORDS = ["job", "recruit", "career", "koyou", "キャリア"];

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

  const resultCount = resolveResultCount(body.result_count);

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
    const { results: webResults, stats: braveStats } = await searchViaBrave(params, braveKey, resultCount);
    await logApiUsage("brave_search", "web_search");

    // 2. AI判定フィルタ (ANTHROPIC_API_KEY未設定なら素通り)
    const filteredResults = await filterResultsWithAI(webResults, locationStr, descStr);

    // 3. Places API (GOOGLE_PLACES_API_KEY未設定なら空配列)
    const placesResults = await searchPlacesAPI(locationStr, descStr, resultCount, params.industry);
    if (placesResults.debug?.has_key) {
      await logApiUsage("google_places", "text_search");
    }

    // 4. マージ・ホスト名重複除去 (web優先、Placesが後ろ)
    let merged = mergeAndDedup([...filteredResults, ...placesResults]);

    // 5. 既に登録済みの企業(companies)を除外
    const knownHostnames = await getKnownHostnames();
    const beforeDuplicateFilterCount = merged.length;
    merged = merged.filter(r => !knownHostnames.has(getHostname(r.url)));
    const excludedDuplicateCount = beforeDuplicateFilterCount - merged.length;

    const payload = { configured: true, results: merged, excluded_duplicate_count: excludedDuplicateCount };
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
        result_count_requested: resultCount,
      };
    }
    return res.status(200).json(payload);
  } catch (err) {
    return res.status(500).json({ error: `検索エラー: ${err.message}` });
  }
};

// Brave/Places (Text Search New) は共に1リクエストあたりの上限が20件
const MAX_RESULT_COUNT = 20;
const DEFAULT_RESULT_COUNT = 20;

function resolveResultCount(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_RESULT_COUNT;
  return Math.min(n, MAX_RESULT_COUNT);
}

async function getKnownHostnames() {
  const companyRows = await sql`SELECT url FROM companies`;
  const known = new Set();
  companyRows.forEach(r => {
    const host = getHostname(r.url);
    if (host) known.add(host);
  });
  return known;
}

async function logApiUsage(provider, endpoint) {
  try {
    await sql`INSERT INTO api_usage_logs (provider, endpoint) VALUES (${provider}, ${endpoint})`;
  } catch {
    // 利用量ログの記録失敗は検索処理に影響させない
  }
}

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
    pathname = new URL(url).pathname;
  } catch {
    pathname = url;
  }
  try {
    // 日本語パス等はパーセントエンコードされているためデコードしてから比較する
    pathname = decodeURIComponent(pathname);
  } catch {
    // 不正なパーセントエンコーディングはデコードせずそのまま使う
  }
  const hostAndPath = `${host.toLowerCase()}${pathname.toLowerCase()}`;
  if (EXCLUDE_PATH_KEYWORDS.some(k => hostAndPath.includes(k))) return "path_match";

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

async function searchViaBrave(params, apiKey, resultCount = DEFAULT_RESULT_COUNT) {
  const query = buildQuery(params);
  const url = `${BRAVE_SEARCH_URL}?q=${encodeURIComponent(query)}&count=${resultCount}`;

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
  const excludedReasons = { domain_match: 0, path_match: 0, punycode_job: 0, name_match: 0, other: 0 };
  const seen = new Set();
  const results = [];
  for (const r of webResults) {
    const reason = getExclusionReason(r.url);
    if (reason) {
      excludedReasons[reason]++;
      continue;
    }
    if (isNoisyName(r.title)) {
      excludedReasons.name_match++;
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
