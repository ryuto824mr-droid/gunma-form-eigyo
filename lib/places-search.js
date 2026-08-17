const PLACES_URL = "https://places.googleapis.com/v1/places:searchText";

// 都道府県ごとのおおよその中心座標([緯度, 経度])。locationBiasの円の中心に使う簡易マッピング。
// textQueryだけでは地理的な絞り込みが弱く、Google Places側で無関係な海外の結果(例: アメリカの
// 製造業企業)が混ざることがあったため、regionCode(方法A)に加えて設定する(方法B)
const PREFECTURE_CENTERS = {
  "北海道": [43.2203, 142.8635], "青森県": [40.8244, 140.7400], "岩手県": [39.7036, 141.1527],
  "宮城県": [38.2688, 140.8721], "秋田県": [39.7186, 140.1024], "山形県": [38.2404, 140.3633],
  "福島県": [37.7500, 140.4678], "茨城県": [36.3418, 140.4468], "栃木県": [36.5658, 139.8836],
  "群馬県": [36.3906, 139.0603], "埼玉県": [35.8569, 139.6489], "千葉県": [35.6047, 140.1233],
  "東京都": [35.6895, 139.6917], "神奈川県": [35.4478, 139.6425], "新潟県": [37.9026, 139.0232],
  "富山県": [36.6953, 137.2113], "石川県": [36.5947, 136.6256], "福井県": [36.0652, 136.2216],
  "山梨県": [35.6642, 138.5684], "長野県": [36.6513, 138.1810], "岐阜県": [35.3912, 136.7223],
  "静岡県": [34.9769, 138.3831], "愛知県": [35.1802, 136.9066], "三重県": [34.7303, 136.5086],
  "滋賀県": [35.0045, 135.8686], "京都府": [35.0212, 135.7556], "大阪府": [34.6863, 135.5200],
  "兵庫県": [34.6913, 135.1830], "奈良県": [34.6851, 135.8329], "和歌山県": [34.2261, 135.1675],
  "鳥取県": [35.5039, 134.2378], "島根県": [35.4723, 133.0505], "岡山県": [34.6618, 133.9344],
  "広島県": [34.3966, 132.4596], "山口県": [34.1861, 131.4705], "徳島県": [34.0658, 134.5593],
  "香川県": [34.3401, 134.0434], "愛媛県": [33.8417, 132.7657], "高知県": [33.5597, 133.5311],
  "福岡県": [33.6064, 130.4181], "佐賀県": [33.2494, 130.2988], "長崎県": [32.7448, 129.8737],
  "熊本県": [32.7898, 130.7417], "大分県": [33.2382, 131.6126], "宮崎県": [31.9111, 131.4239],
  "鹿児島県": [31.5602, 130.5581], "沖縄県": [26.2124, 127.6809],
};

// Text Search (New) のlocationBias circleが受け付ける半径の上限は50000m(50km)
const LOCATION_BIAS_RADIUS_METERS = 50000;

// 業種を問わず常に除外するノイズワード(人材派遣・求人系、公的機関はどの業種を検索していても不要)
const NOISE_KEYWORDS_ALWAYS = [
  "派遣", "求人", "転職",
  "スタッフサービス", "スタッフ株式会社", "人材", "キャリアオプション",
  "ハローワーク", "hellowork", "job", "採用サポート", "就労移行支援",
  "ワークス", "はたらく", "hatarakunavi", "求人ワーク",
  "教育センター", "教育委員会", "特別支援学校", "生涯学習センター",
  "市役所", "県庁", "保健所", "児童相談所",
  "社会福祉協議会", "学習塾", "教室", "個別指導",
  "就労継続支援", "障がい者", "税理士法人", "税理士事務所",
  "社会保険労務士", "行政書士", "弁護士法人", "サービスステーション",
  "ガソリンスタンド", "service station",
  "ほけんの窓口", "保険クリニック", "保険相談", "マネードクター",
  "商工会議所", "商工会",
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

// 「銀行」単体では正当な金融法人ヒットもあり誤除外が多いため、
// 支店・出張所単位の結果(例: "〇〇銀行△△支店")に限定して除外する
function isBankBranchName(rawName) {
  if (!rawName) return false;
  return rawName.includes("銀行") && (rawName.endsWith("支店") || rawName.endsWith("出張所"));
}

function isNoisyPlaceName(rawName, industry) {
  if (!rawName) return false;
  if (isBankBranchName(rawName)) return true;
  const name = rawName.toLowerCase();
  if (NOISE_KEYWORDS_ALWAYS.some(k => name.includes(k.toLowerCase()))) return true;

  const isItSearch = industry === "IT・情報通信";
  if (!isItSearch) return false;

  if (NOISE_KEYWORDS_IT_STRICT.some(k => name.includes(k.toLowerCase()))) return true;
  if (NEAR_EXACT_NOISE_KEYWORDS_IT_STRICT.some(k => isNearExactMatch(name, k.toLowerCase()))) return true;

  return false;
}

// 店舗・支店単位の結果(例: "○○支店", "○○西口店")は企業単位の営業リストとして
// 重複・粒度過多になるため除外する。「本店」は本社的な意味合いのため除外しない
function isBranchOrStore(name) {
  if (!name) return false;
  if (name.includes("本店")) return false;
  const branchKeywords = ["支店", "営業所", "出張所"];
  if (branchKeywords.some(k => name.includes(k))) return true;
  if (/[一-龠ぁ-んァ-ヶ]店$/.test(name) && !name.endsWith("本店")) return true;

  // 駅名+方角+店舗系(「駅」という文字を含み、かつ店舗を示す語も含む場合)
  if (name.includes("駅") && (name.includes("前") || name.includes("東口") || name.includes("西口") || name.includes("南口") || name.includes("北口"))) {
    return true;
  }

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
// prefecture: 検索対象の都道府県名(例: "群馬県")。PREFECTURE_CENTERSに存在すれば、その
//   中心座標を使ってlocationBiasを設定する(未指定/マッピングに無い場合はregionCodeのみで絞り込む)
async function searchPlacesAPI(region, keyword, pageSize = 20, industry = "", excludeDomains = [], prefecture = "") {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  const debug = { has_key: !!apiKey, key_length: apiKey ? apiKey.length : 0 };

  if (!apiKey) {
    return Object.assign([], { debug });
  }

  try {
    const textQuery = `${region} ${keyword}`.trim();

    // 方法A: regionCodeで日本国内を優先させる
    const requestBody = { textQuery, pageSize, regionCode: "JP" };

    // 方法B: 都道府県が特定できる場合は、その中心座標を使ったlocationBiasも追加する
    const center = PREFECTURE_CENTERS[prefecture];
    if (center) {
      requestBody.locationBias = {
        circle: {
          center: { latitude: center[0], longitude: center[1] },
          radius: LOCATION_BIAS_RADIUS_METERS,
        },
      };
    }

    const res = await fetch(PLACES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "places.displayName,places.websiteUri",
      },
      body: JSON.stringify(requestBody),
    });

    debug.status = res.status;
    debug.text_query = textQuery;
    debug.region_code = requestBody.regionCode;
    debug.location_bias = requestBody.locationBias || null;

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
    let branchStoreExcludedCount = 0;
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
        if (isBranchOrStore(name)) {
          branchStoreExcludedCount++;
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
    debug.branch_store_excluded_count = branchStoreExcludedCount;

    return Object.assign(results, { debug });
  } catch (err) {
    debug.error = err.message;
    return Object.assign([], { debug });
  }
}

module.exports = { searchPlacesAPI };
