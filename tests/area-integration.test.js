// 営業の対象の地域(area)を各所につないだところのテスト(段階④〜⑦):
//   見つけた県の保存・「あとで送る」の要確認と★候補・全国のときの自動の積み込み(保留)・保留からの自動の移し替え・
//   検索の組み合わせ(県ごとの市町村)・宛名の地名の判定(47都道府県)・文面の差出人の地域・送信管理の画面の設定の保存。
// ozukanzukan(設定なし=群馬県だけ)の動きが変わらないことも確かめる。
// lib/db・api/discover・api/companies/[id]/research・api/submit-form・api/send-email は require キャッシュで偽物に差し替える
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { buildLaterList } = require("../lib/later-status");
const { pickSearchCondition } = require("../lib/search-rotation");
const { checkGreetingName } = require("../lib/greeting-name");

const NATIONWIDE = { mode: "nationwide" };
const GUNMA = { mode: "prefectures", prefectures: ["群馬県"] };

// ---- 偽物の DB ----
const calls = [];
const state = {};
function reset(over = {}) {
  calls.length = 0;
  Object.assign(state, {
    configs: {}, company: null, insertFails: false, registered: [], discoverReplies: [],
  }, over);
}
function fakeSql(strings, ...values) {
  const text = strings.join("?").replace(/\s+/g, " ").trim();
  calls.push({ text, values });
  if (text.startsWith("SELECT search_params FROM auto_pipeline_config")) {
    const c = state.configs[values[0]];
    return Promise.resolve(c ? [{ search_params: c }] : []);
  }
  if (text.includes("FROM auto_pipeline_config WHERE project")) {
    const c = state.configs[values[0]];
    return Promise.resolve(c ? [{ project: values[0], enabled: true, variant_id: 3, daily_limit: 2, search_params: c }] : []);
  }
  if (text.startsWith("SELECT * FROM companies WHERE id")) return Promise.resolve(state.company ? [state.company] : []);
  if (text.startsWith("INSERT INTO companies") && text.includes("found_prefecture")) {
    if (state.insertFails) return Promise.reject(new Error('column "found_prefecture" of relation "companies" does not exist'));
    return Promise.resolve([{ id: 9001, found_prefecture: values[4] }]);
  }
  if (text.startsWith("INSERT INTO companies")) return Promise.resolve([{ id: 9002 }]);
  return Promise.resolve([]);
}
fakeSql.query = async () => [];
function stub(rel, exports) {
  const p = require.resolve(path.join(__dirname, "..", rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
stub("lib/db", { sql: fakeSql, getSettings: async () => ({ skip_weekends_holidays: "false" }), isExcludedDomain: async () => false });
stub("api/discover", async (req, res) => res.status(200).json(state.discoverReplies.shift() || { configured: true, results: [] }));
stub("api/companies/[id]/research", async (req, res) => res.status(200).json({ id: Number(req.query.id), name: "株式会社テスト", project: "locle", url: "https://t.example.jp/", research_result: { automatable: true }, company_info: { prefecture: "大阪府" } }));
stub("api/submit-form", async (req, res) => res.status(200).json({}));
stub("api/send-email", async (req, res) => res.status(200).json({}));
const companiesApi = require("../api/companies");
const crm = require("../api/crm");
const { buildPrompt } = require("../lib/ai-message-generator");

function call(handler, req) {
  return new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(d) { resolve({ status: this.statusCode, body: d }); return this; }, setHeader() {} };
    handler({ headers: {}, query: {}, body: {}, ...req }, res);
  });
}
const later = (companies, area) => buildLaterList({ companies, sendLogSummary: [], responses: [], queueRows: [], scheduledRows: [], senderProfileValid: true, area, now: Date.now() });
const base = {
  id: 1, name: "株式会社テスト製作所", url: "https://t.example.jp/", contact_form_url: "https://t.example.jp/contact/", status: "researched",
  archived: false, automatable: "true", mapping_source: "ai", updated_at: new Date().toISOString(), phone_number: "06-1234-5678",
};

test("見つけた県の保存: 登録で都道府県名だけ保存する。列を足す前(デプロイ直後)は列なしで登録する", async () => {
  reset();
  let r = await call(companiesApi, { method: "POST", body: { name: "株式会社A", url: "https://a.example.jp/", project: "locle", found_prefecture: "大阪府" } });
  assert.equal(r.status, 201);
  assert.equal(r.body.found_prefecture, "大阪府");
  reset();
  r = await call(companiesApi, { method: "POST", body: { name: "株式会社A", url: "https://a.example.jp/", project: "locle", found_prefecture: "架空県" } });
  assert.equal(calls.find((c) => c.text.startsWith("INSERT INTO companies")).values[4], null, "都道府県名でなければ保存しない");
  reset({ insertFails: true });
  r = await call(companiesApi, { method: "POST", body: { name: "株式会社A", url: "https://a.example.jp/", project: "locle", found_prefecture: "大阪府" } });
  assert.equal(r.status, 201);
  assert.equal(r.body.id, 9002, "列なしで登録し直す");
});

test("自動パイプライン: 見つけた県を登録に渡し、処理しなかった残りの持ち越しにも残す", async () => {
  reset({ configs: { locle: { industry: "製造業", rotation: { prefectures: [{ name: "大阪府", cities: ["堺市"] }], industries: ["製造業"] } } } });
  const cands = Array.from({ length: 4 }, (_, i) => ({ name: `株式会社${i}`, url: `https://c${i}.example.jp/` }));
  state.discoverReplies = [{ configured: true, results: cands }];
  const r = await call(crm, { method: "POST", query: { action: "run-auto-pipeline" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const regs = calls.filter((c) => c.text.startsWith("INSERT INTO companies"));
  assert.equal(regs.length, 2, "上限2社");
  assert.ok(regs.every((c) => c.values[4] === "大阪府"), "見つけた県(大阪府)を保存");
  const leftovers = calls.filter((c) => c.text.startsWith("INSERT INTO discover_backlog"));
  assert.equal(leftovers.length, 2);
  assert.ok(leftovers.every((c) => JSON.parse(c.values[4]).found_prefecture === "大阪府"), "持ち越しの候補にも残す");
});

test("「あとで送る」(全国): 県が不明・見つけた県と違う・公共団体は要確認で★にしない。県が分かれば電話番号は見ない", () => {
  const companies = [
    { ...base, id: 1, company_prefecture: "大阪府", found_prefecture: "大阪府" },
    { ...base, id: 2, company_prefecture: null, found_prefecture: "大阪府" },
    { ...base, id: 3, company_prefecture: "群馬県", found_prefecture: "三重県" },
    { ...base, id: 4, name: "一般社団法人テスト協会", company_prefecture: "大阪府", found_prefecture: "大阪府" },
  ];
  const { items } = later(companies, NATIONWIDE);
  const by = (id) => items.find((i) => i.company_id === id);
  assert.equal(by(1).category, "ready");
  assert.ok(by(1).auto_candidate.ok, JSON.stringify(by(1).auto_candidate));
  for (const id of [2, 3, 4]) {
    assert.equal(by(id).category, "review", String(id));
    assert.ok(by(id).warnings.some((w) => w.code === "area_review"), String(id));
  }
  assert.match(by(3).warnings.find((w) => w.code === "area_review").message, /見つけた県\(三重県\)と住所の県\(群馬県\)が違う/);
});

test("「あとで送る」(設定なし=群馬県だけ): 今までどおり。要確認を足さず、★候補は電話番号(027)で見る", () => {
  const companies = [
    { ...base, id: 1, phone_number: "027-123-4567", company_prefecture: null, found_prefecture: null },
    { ...base, id: 2, phone_number: "06-1234-5678", company_prefecture: "大阪府", found_prefecture: "群馬県" },
  ];
  for (const area of [undefined, GUNMA]) {
    const { items } = later(companies, area);
    const by = (id) => items.find((i) => i.company_id === id);
    assert.ok(!items.some((i) => i.warnings.some((w) => w.code === "area_review")));
    assert.ok(by(1).auto_candidate.ok, JSON.stringify(by(1).auto_candidate));
    assert.ok(by(2).auto_candidate.reasons.includes("電話番号が群馬県の市外局番ではない"));
  }
});

test("全国のとき: 見つけた県と違う会社は、送信待ちではなく保留に積む。群馬県だけなら今までどおり送信待ち", async () => {
  const company = { id: 50, name: "株式会社松阪興産", url: "https://m.example.jp/", project: "locle", status: "researched", archived: false,
    research_result: { automatable: true }, company_info: { prefecture: "群馬県" }, found_prefecture: "三重県" };
  reset({ company, configs: { locle: { area: NATIONWIDE } } });
  let r = await call(crm, { method: "POST", query: { action: "send-queue" }, body: { company_id: 50, variant_id: 3, project: "locle" } });
  assert.equal(r.body.queued, true, JSON.stringify(r.body));
  let ins = calls.find((c) => c.text.startsWith("INSERT INTO send_queue"));
  assert.match(ins.text, /'on_hold'/);
  assert.match(ins.values[ins.values.length - 1], /要確認\(全国\): 見つけた県\(三重県\)と住所の県\(群馬県\)が違う/);
  reset({ company: { ...company, company_info: { prefecture: "群馬県" }, found_prefecture: null }, configs: {} });
  r = await call(crm, { method: "POST", query: { action: "send-queue" }, body: { company_id: 50, variant_id: 3, project: "locle" } });
  ins = calls.find((c) => c.text.startsWith("INSERT INTO send_queue"));
  assert.match(ins.text, /'pending'/, "設定なしは今までどおり");
});

test("検索の組み合わせ: 県ごとの市町村を持てる。今の形(県1つ+市町村)もそのまま読める", () => {
  const rot = { prefectures: [{ name: "大阪府", cities: ["堺市", "豊中市"] }, { name: "愛知県", cities: ["豊田市"] }], industries: ["製造業"] };
  const history = [{ industry: "製造業", prefecture: "大阪府", city: "堺市", result_count: 5, searched_at: new Date().toISOString() }];
  assert.deepEqual(pickSearchCondition({ rotation: rot, history }), { industry: "製造業", prefecture: "大阪府", city: "豊中市", reason: "未検索" });
  const all = [...history, { industry: "製造業", prefecture: "大阪府", city: "豊中市", result_count: 1, searched_at: new Date().toISOString() }];
  assert.deepEqual(pickSearchCondition({ rotation: rot, history: all }).prefecture, "愛知県");
  const old = { prefecture: "群馬県", cities: ["高崎市"], industries: ["製造業"] };
  assert.deepEqual(pickSearchCondition({ rotation: old, history: [] }), { industry: "製造業", prefecture: "群馬県", city: "高崎市", reason: "未検索" });
});

test("宛名: 47都道府県の地名(「大阪府堺市の〇〇」「〇〇株式会社 大阪府堺市」「東京都世田谷区の〇〇」)も不確か", () => {
  assert.equal(checkGreetingName("大阪府堺市の不動産会社 株式会社加茂住宅").reason, "地域の説明から始まる");
  assert.equal(checkGreetingName("東京都世田谷区の工務店").reason, "地域の説明から始まる");
  assert.equal(checkGreetingName("日本不動産株式会社 大阪府堺市").reason, "社名の後ろに地名が付いている");
  assert.equal(checkGreetingName("株式会社北区製作所").ok, true);
  assert.equal(checkGreetingName("群馬県太田市の不動産").reason, "地域の説明から始まる", "群馬県は今までどおり");
});

test("文面の差出人の地域: 全国なら「全国の地域企業」、設定なしは今までどおり「群馬県を中心に」", () => {
  assert.match(buildPrompt({}), /LOCLEという、群馬県を中心に地域企業の採用・広報支援/);
  assert.match(buildPrompt({ area: GUNMA }), /群馬県を中心に地域企業/);
  assert.match(buildPrompt({ area: NATIONWIDE }), /LOCLEという、全国の地域企業の採用・広報支援/);
});

test("送信管理の画面: LOCLE の設定に地域を選ぶ欄があり、保存で area を消さない", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "send.html"), "utf8");
  assert.match(html, /<select id="pipelineArea">/);
  assert.match(html, /searchParams\.area = \{ mode: "nationwide" \}/);
  assert.match(html, /else if \(prevParams\.area\) \{\s*searchParams\.area = prevParams\.area;/, "お仕事図鑑は読み込んだ設定を引き継ぐ");
});
