// lib/area.js
//
// 営業の対象の地域(area)。プロジェクトごとに自動パイプラインの設定(auto_pipeline_config.search_params.area)で持つ。
//   { mode: "prefectures", prefectures: ["群馬県"] }  … その県だけ(ozukanzukan。設定が無いときもこれ)
//   { mode: "nationwide" }                            … 全国(locle を全国に広げるとき)
// 設定が無い・形が違うときは群馬県だけとして扱う(今までの動きを変えないため)。
//
// 対象の県だけのとき: 会社概要の住所の県が対象外なら自動送信不可(今までの lib/prefecture.js の判定と同じ)。
// 全国のとき: 県では止めない。そのかわり、次の会社は「要確認」にして、自動では送信待ちに入れない
//   - 住所の県が分からない
//   - 企業探しで見つけた県と、住所の県が違う(同じ名前の市町村の取り違え・本社が別の県の全国企業)
//     2026-10-27 の試験: 三重県明和町で探して群馬県安中市の会社、愛知県豊田市で探して東京都の本社 等
//   - 公共・団体の法人格・施設名(試験: 堺市産業振興センター・高速道路会社の支社 等)
// DB には触らない純粋な関数だけを置く。

const { PREFECTURES } = require("./prefecture");

const DEFAULT_AREA = Object.freeze({ mode: "prefectures", prefectures: Object.freeze(["群馬県"]) });

function normalizeArea(raw) {
  if (!raw || typeof raw !== "object") return DEFAULT_AREA;
  if (raw.mode === "nationwide") return { mode: "nationwide", prefectures: [] };
  if (raw.mode === "prefectures") {
    const prefs = (Array.isArray(raw.prefectures) ? raw.prefectures : []).map((p) => String(p).trim()).filter((p) => PREFECTURES.includes(p));
    if (prefs.length > 0) return { mode: "prefectures", prefectures: [...new Set(prefs)] };
  }
  return DEFAULT_AREA;
}

// 自動パイプラインの設定の行(auto_pipeline_config)から area を作る。行が無ければ群馬県だけ
function areaOf(config) {
  const params = config && config.search_params && typeof config.search_params === "object" ? config.search_params : null;
  return normalizeArea(params && params.area);
}

const isNationwide = (area) => !!area && area.mode === "nationwide";

function isAllowedPrefecture(area, pref) {
  if (isNationwide(area)) return true;
  return (area || DEFAULT_AREA).prefectures.includes(pref);
}

// 会社概要の住所を選ぶときに優先する県(lib/prefecture.js の extractAddress・company-info-extractor の mergeInfo)。
// 対象の県だけなら、その県。全国なら、企業探しで見つけた県(分からなければ優先しない)
function preferredPrefectures(area, foundPrefecture) {
  if (isNationwide(area)) return foundPrefecture && PREFECTURES.includes(foundPrefecture) ? [foundPrefecture] : [];
  return (area || DEFAULT_AREA).prefectures.slice();
}

// 自動送信不可にする理由(対象の県だけのとき、住所の県が対象外)。全国・県が不明・対象の県なら null。
// 文言は今までの lib/prefecture.js の prefectureBlockReason と同じ(群馬県だけのときに変わらないように)
function areaBlockReason(companyInfo, area) {
  if (isNationwide(area)) return null;
  const pref = companyInfo && companyInfo.prefecture;
  if (!pref || isAllowedPrefecture(area, pref)) return null;
  const target = (area || DEFAULT_AREA).prefectures.join("・");
  return `会社概要の住所が${target}ではない(${pref}${companyInfo.address ? `: ${String(companyInfo.address).slice(0, 40)}` : ""})`;
}

// 公共・団体の法人格・施設名(全国のときに要確認にする)。会社(株式会社・有限会社・合同会社等)の名前の一部の
// 「センター」「サービス」等では一致させないよう、法人格・役所・施設を表す語だけにする
const PUBLIC_LEGAL_RE = /(公益社団法人|公益財団法人|一般社団法人|一般財団法人|社団法人|財団法人|社会福祉法人|医療法人|学校法人|宗教法人|特定非営利活動法人|NPO法人|独立行政法人|国立大学法人|協同組合|組合連合会|商工会議所|商工会|高速道路株式会社)/;
// 施設名は語の終わりのときだけ(「株式会社大学堂」の「大学」では一致させない)
const PUBLIC_FACILITY_RE = /(市役所|区役所|町役場|村役場|県庁|都庁|府庁|道庁|役場|振興センター|支援センター|福祉センター|図書館|公民館|保健所|消防署|警察署|小学校|中学校|高等学校|高校|大学|保育園|保育所|幼稚園|こども園|病院|診療所|クリニック)(?=$|[\s　・|｜()（）\-–—:：,、。])/;

function publicOrgReason(name, officialName) {
  for (const text of [name, officialName]) {
    const m = PUBLIC_LEGAL_RE.exec(String(text || "")) || PUBLIC_FACILITY_RE.exec(String(text || ""));
    if (m) return `公共・団体の名前(${m[1]})`;
  }
  return null;
}

// 全国のときに「要確認」にする理由の一覧(対象の県だけのときは空。今までの動きを変えない)
//   company: { name, official_name, company_prefecture(会社概要の住所の県), found_prefecture(見つけた県) }
function areaReviewReasons(company, area) {
  if (!isNationwide(area) || !company) return [];
  const reasons = [];
  const pref = company.company_prefecture || null;
  const found = company.found_prefecture || null;
  if (!pref) reasons.push("住所の県が分からない");
  else if (found && pref !== found) reasons.push(`見つけた県(${found})と住所の県(${pref})が違う`);
  const pub = publicOrgReason(company.name, company.official_name);
  if (pub) reasons.push(pub);
  return reasons;
}

module.exports = {
  DEFAULT_AREA, normalizeArea, areaOf, isNationwide, isAllowedPrefecture, preferredPrefectures,
  areaBlockReason, publicOrgReason, areaReviewReasons,
};
