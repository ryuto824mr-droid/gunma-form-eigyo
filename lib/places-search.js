const PLACES_URL = "https://places.googleapis.com/v1/places:searchText";

// 業種を問わず常に除外するノイズワード(人材派遣・求人系、公的機関はどの業種を検索していても不要)
const NOISE_KEYWORDS_ALWAYS = [
  "派遣", "求人", "転職",
  "スタッフサービス", "スタッフ株式会社", "人材", "キャリアオプション",
  "ハローワーク", "hellowork", "job", "採用サポート", "就労移行支援",
  "ワークス", "はたらく", "hatarakunavi", "求人ワーク",
  "教育センター", "教育委員会", "特別支援学校", "生涯学習センター",
  "市役所", "県庁", "保健所", "児童相談所",
];

// "IT・情報通信"を検索している場合のみ厳しめに適用する除外ワード
// (教育機関・福祉業界は他業種を検索している場合は正当なヒットになりうるため)
const NOISE_KEYWORDS_IT_STRICT = ["専門学校", "大学校", "スクール", "保育", "介護"];

// 家電量販店系のキーワードは社名の一部にたまたま含まれる可能性を考慮し、
// 単純な部分一致ではなく「社名がほぼその単語のみで構成されている」場合に限定して除外する
const NEAR_EXACT_NOISE_KEYWORDS_IT_STRICT = ["家電", "でんき", "カメラ"];
const NEAR_EXACT_MATCH_SLACK = 15; // 店舗名等の接尾辞を許容する文字数の目安

function isNearExactMatch(name, term) {
  if (!name.includes(term)) return false;
  return name.trim().length <= term.length + NEAR_EXACT_MATCH_SLACK;
}

function isNoisyPlaceName(rawName, industry) {
  if (!rawName) return false;
  const name = rawName.toLowerCase();
  if (NOISE_KEYWORDS_ALWAYS.some(k => name.includes(k.toLowerCase()))) return true;

  const isItSearch = industry === "IT・情報通信";
  if (!isItSearch) return false;

  if (NOISE_KEYWORDS_IT_STRICT.some(k => name.includes(k.toLowerCase()))) return true;
  if (NEAR_EXACT_NOISE_KEYWORDS_IT_STRICT.some(k => isNearExactMatch(name, k.toLowerCase()))) return true;

  return false;
}

function getHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// api/discover.jsのEXCLUDE_DOMAINSと同じ末尾一致ロジックで判定する
function isDomainExcluded(url, excludeDomains) {
  if (!excludeDomains || excludeDomains.length === 0) return false;
  const host = getHostname(url);
  return excludeDomains.some(d => host === d || host.endsWith(`.${d}`));
}

// results: 通常の呼び出し互換のため配列そのまま
// debug: has_key/key_length/status/error等の診断情報(APIキーの値自体は含めない)
// pageSize: 取得件数(Text Search (New)の上限は20)
// industry: 検索している業種。"IT・情報通信"の場合のみノイズ除外を厳しめに適用する
// excludeDomains: api/discover.jsのEXCLUDE_DOMAINS(呼び出し元から渡す。Brave側と同じ
//   ブロックリストをGoogle Placesの結果(websiteUri)にも適用するため)
async function searchPlacesAPI(region, keyword, pageSize = 20, industry = "", excludeDomains = []) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  const debug = { has_key: !!apiKey, key_length: apiKey ? apiKey.length : 0 };

  if (!apiKey) {
    return Object.assign([], { debug });
  }

  try {
    const textQuery = `${region} ${keyword}`.trim();
    const res = await fetch(PLACES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "places.displayName,places.websiteUri",
      },
      body: JSON.stringify({ textQuery, pageSize }),
    });

    debug.status = res.status;
    debug.text_query = textQuery;

    if (!res.ok) {
      debug.error = (await res.text()).slice(0, 300);
      return Object.assign([], { debug });
    }

    const data = await res.json();
    const places = data.places || [];
    debug.places_returned = places.length;
    debug.places_with_website = places.filter(p => p.websiteUri).length;

    let noiseExcludedCount = 0;
    let domainExcludedCount = 0;
    const results = places
      .filter(p => p.websiteUri)
      .filter(p => {
        if (isDomainExcluded(p.websiteUri, excludeDomains)) {
          domainExcludedCount++;
          return false;
        }
        const name = p.displayName?.text || "";
        if (isNoisyPlaceName(name, industry)) {
          noiseExcludedCount++;
          return false;
        }
        return true;
      })
      .map(p => ({
        name: p.displayName?.text || p.websiteUri,
        url: p.websiteUri,
        source: "places",
      }));
    debug.noise_excluded_count = noiseExcludedCount;
    debug.domain_excluded_count = domainExcludedCount;

    return Object.assign(results, { debug });
  } catch (err) {
    debug.error = err.message;
    return Object.assign([], { debug });
  }
}

module.exports = { searchPlacesAPI };
