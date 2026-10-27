// 営業の対象の地域(lib/area.js)と、住所の選び方・リサーチへの渡し方のテスト。
// ozukanzukan(設定なし=群馬県だけ)の動きが変わらないことと、全国(locle)のときの判定を確かめる。
// リサーチ(api/companies/[id]/research.js)は lib/db・lib/form-analyzer を require キャッシュで偽物に差し替える
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const {
  DEFAULT_AREA, normalizeArea, areaOf, isAllowedPrefecture, preferredPrefectures, areaBlockReason, publicOrgReason, areaReviewReasons,
} = require("../lib/area");
const { extractAddress, prefectureBlockReason } = require("../lib/prefecture");
const { extractInfoFromText, mergeInfo } = require("../lib/company-info-extractor");

const NATIONWIDE = { mode: "nationwide" };

test("設定が無い・形が違うときは群馬県だけ(ozukanzukan の今の動き)", () => {
  for (const raw of [undefined, null, {}, { mode: "x" }, { mode: "prefectures", prefectures: [] }, { mode: "prefectures", prefectures: ["群馬"] }]) {
    assert.deepEqual(normalizeArea(raw), DEFAULT_AREA, JSON.stringify(raw));
  }
  assert.deepEqual(areaOf(null), DEFAULT_AREA);
  assert.deepEqual(areaOf({ search_params: { industry: "製造業", rotation: {} } }), DEFAULT_AREA, "今の本番の ozukanzukan の設定");
  assert.deepEqual(areaOf({ search_params: { area: NATIONWIDE } }).mode, "nationwide");
  assert.deepEqual(areaOf({ search_params: { area: { mode: "prefectures", prefectures: ["群馬県", "栃木県", "群馬県"] } } }).prefectures, ["群馬県", "栃木県"]);
});

test("群馬県だけのとき: 県外は自動送信不可で、文言も今までと同じ。県が不明・群馬県なら止めない", () => {
  for (const info of [
    { prefecture: "長野県", address: "長野県長野市1-1" }, { prefecture: "三重県", address: null },
    { prefecture: "群馬県", address: "群馬県高崎市1-1" }, { prefecture: null, address: null }, null,
  ]) {
    assert.equal(areaBlockReason(info, DEFAULT_AREA), prefectureBlockReason(info), JSON.stringify(info));
  }
  assert.equal(isAllowedPrefecture(DEFAULT_AREA, "群馬県"), true);
  assert.equal(isAllowedPrefecture(DEFAULT_AREA, "東京都"), false);
  assert.deepEqual(areaReviewReasons({ name: "堺市産業振興センター", company_prefecture: null }, DEFAULT_AREA), [], "群馬県だけのときは要確認を足さない");
});

test("全国のとき: 県では止めない。見つけた県と違う・県が不明・公共団体は要確認", () => {
  assert.equal(areaBlockReason({ prefecture: "大阪府", address: "大阪府堺市1-1" }, NATIONWIDE), null);
  assert.equal(isAllowedPrefecture(NATIONWIDE, "沖縄県"), true);
  const r = (c) => areaReviewReasons(c, NATIONWIDE);
  assert.deepEqual(r({ name: "株式会社A", company_prefecture: "大阪府", found_prefecture: "大阪府" }), []);
  assert.deepEqual(r({ name: "株式会社A", company_prefecture: "大阪府", found_prefecture: null }), [], "見つけた県が無い(手で登録)なら県の違いは見ない");
  assert.deepEqual(r({ name: "株式会社A", company_prefecture: null, found_prefecture: "大阪府" }), ["住所の県が分からない"]);
  // 試験で見つかった同じ名前の町の取り違え(三重県明和町で探して群馬県安中市の会社)
  assert.deepEqual(r({ name: "松阪興産株式会社", company_prefecture: "群馬県", found_prefecture: "三重県" }), ["見つけた県(三重県)と住所の県(群馬県)が違う"]);
  assert.match(r({ name: "堺市産業振興センター", company_prefecture: "大阪府", found_prefecture: "大阪府" })[0], /公共・団体の名前\(振興センター\)/);
  assert.match(r({ name: "中日本高速道路株式会社 東京支社 八王子", company_prefecture: "東京都", found_prefecture: "東京都" })[0], /公共・団体/);
});

test("公共・団体の判定は、会社の名前の一部の語では一致させない", () => {
  for (const name of ["一般社団法人高崎学童", "医療法人ゆかり たかまえ病院", "群馬漁業協同組合", "太田市役所", "富岡市立図書館", "NPO法人つながりサポート群馬"]) {
    assert.ok(publicOrgReason(name), name);
  }
  for (const name of ["株式会社農業支援サービス", "株式会社サービスセンター東海", "株式会社大学堂", "株式会社センター商事", "協和工業株式会社"]) {
    assert.equal(publicOrgReason(name), null, name);
  }
});

test("住所の選び方: 群馬県だけなら群馬の拠点、全国なら見つけた県の拠点、見つけた県が無ければ最初の住所", () => {
  const text = "本社 〒100-0001 東京都千代田区1-1\n大阪工場 〒590-0001 大阪府堺市堺区1-1\n群馬工場 〒370-0001 群馬県高崎市1-1";
  assert.equal(extractAddress(text).prefecture, "群馬県", "省略時は今までどおり");
  assert.equal(extractAddress(text, preferredPrefectures(DEFAULT_AREA)).prefecture, "群馬県");
  assert.equal(extractAddress(text, preferredPrefectures(NATIONWIDE, "大阪府")).prefecture, "大阪府");
  assert.equal(extractAddress(text, preferredPrefectures(NATIONWIDE, null)).prefecture, "東京都");
  assert.deepEqual(preferredPrefectures(NATIONWIDE, "架空県"), []);
  // トップと会社概要の住所を混ぜるとき: 優先する県の住所に置き換える
  const info = { address: null, prefecture: null };
  mergeInfo(info, extractInfoFromText("本社所在地 東京都港区1-1", ["大阪府"]), ["大阪府"]);
  mergeInfo(info, extractInfoFromText("堺工場 大阪府堺市1-1", ["大阪府"]), ["大阪府"]);
  assert.equal(info.prefecture, "大阪府");
  const def = { address: null, prefecture: null };
  mergeInfo(def, extractInfoFromText("本社所在地 東京都港区1-1"));
  mergeInfo(def, extractInfoFromText("堺工場 大阪府堺市1-1"));
  assert.equal(def.prefecture, "東京都", "省略時(群馬県が優先)は、大阪の住所には置き換えない");
});

// ---- リサーチに area を渡す ----
let company, config;
const analyzeCalls = [];
function fakeSql(strings, ...v) {
  const text = strings.join("?").replace(/\s+/g, " ").trim();
  if (text.startsWith("SELECT * FROM companies WHERE id")) return Promise.resolve([company]);
  if (text.startsWith("SELECT search_params FROM auto_pipeline_config")) return Promise.resolve(config ? [config] : []);
  if (text.startsWith("UPDATE companies")) return Promise.resolve([{ ...company, research_result: JSON.parse(v[1]), status: v[2] }]);
  return Promise.resolve([]);
}
function stub(rel, exports) {
  const p = require.resolve(path.join(__dirname, "..", rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
stub("lib/db", { sql: fakeSql });
stub("lib/form-analyzer", { analyzeForm: async (url, options) => { analyzeCalls.push({ url, options }); return { formFound: true, automatable: true, forms: [{}], analysisWarnings: [] }; } });
delete process.env.ANTHROPIC_API_KEY;
const research = require("../api/companies/[id]/research");
const callResearch = () => new Promise((resolve) => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(d) { resolve({ status: this.statusCode, body: d }); return this; } };
  research({ method: "POST", query: { id: String(company.id) } }, res);
});

test("リサーチ: プロジェクトの設定の area と見つけた県を渡す。設定が無ければ群馬県だけ", async () => {
  analyzeCalls.length = 0;
  company = { id: 1, url: "https://a.example.jp/", project: "ozukanzukan", email: null, company_info: null, company_tags: [] };
  config = null;
  assert.equal((await callResearch()).status, 200);
  assert.deepEqual(analyzeCalls[0].options.area, DEFAULT_AREA);
  company = { id: 2, url: "https://b.example.jp/", project: "locle", email: null, company_info: null, company_tags: [], found_prefecture: "大阪府" };
  config = { search_params: { area: NATIONWIDE } };
  assert.equal((await callResearch()).status, 200);
  assert.equal(analyzeCalls[1].options.area.mode, "nationwide");
  assert.equal(analyzeCalls[1].options.foundPrefecture, "大阪府");
});
