// 自動パイプライン(api/crm.js の run-auto-pipeline)の検索条件の順番替えと、新しい企業を保留(on_hold)で積むことのテスト。
// lib/db・api/discover・api/companies・api/companies/[id]/research はrequireキャッシュで偽物に差し替える
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const calls = [];
let config;
let history;
let discoverReplies;
const discoverBodies = [];
function fakeSql(strings, ...values) {
  const text = strings.join("?").replace(/\s+/g, " ").trim();
  calls.push({ text, values });
  if (text.includes("FROM auto_pipeline_config WHERE project")) return Promise.resolve(values[0] === "ozukanzukan" ? [config] : []);
  if (text.includes("FROM search_history")) return Promise.resolve(history);
  return Promise.resolve([]);
}
fakeSql.query = async () => [];
function stub(rel, exports) {
  const p = require.resolve(path.join(__dirname, "..", rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
stub("lib/db", { sql: fakeSql, getSettings: async () => ({ skip_weekends_holidays: "false" }), isExcludedDomain: async () => false });
stub("api/discover", async (req, res) => {
  discoverBodies.push(req.body);
  return res.status(200).json(discoverReplies.shift() || { configured: true, results: [] });
});
stub("api/companies", async (req, res) => res.status(201).json({ id: 9001 }));
stub("api/companies/[id]/research", async (req, res) => res.status(200).json({ id: 9001, email: null, research_result: { automatable: true } }));
const handler = require("../api/crm");

function call() {
  return new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(d) { resolve({ status: this.statusCode, body: d }); return this; } };
    handler({ method: "POST", query: { action: "run-auto-pipeline" }, headers: {}, body: {} }, res);
  });
}
const ROT = { prefecture: "群馬県", industries: ["製造業", "建設・不動産"], cities: ["高崎市", "太田市"], min_days_between: 30 };
const reset = (over = {}) => {
  calls.length = 0;
  discoverBodies.length = 0;
  config = { project: "ozukanzukan", enabled: true, variant_id: 7, daily_limit: 15, search_params: { industry: "製造業", rotation: ROT }, ...over };
  history = [];
  discoverReplies = [];
};
const queueInserts = () => calls.filter((c) => /^INSERT INTO send_queue/.test(c.text));
const oz = (r) => r.body.results.find((x) => x.project === "ozukanzukan");

test("rotation があれば未検索の「業種×市町村」で検索し、新しい企業は保留(on_hold)で積む", async () => {
  reset();
  history = [{ industry: "製造業", prefecture: "群馬県", city: "高崎市", result_count: 9, searched_at: new Date(Date.now() - 86400000).toISOString() }];
  discoverReplies = [{ configured: true, results: [{ name: "株式会社テスト", url: "https://test.example.jp/" }] }];
  const r = await call();
  assert.deepEqual(oz(r).search, { industry: "建設・不動産", prefecture: "群馬県", city: "高崎市" });
  assert.equal(discoverBodies[0].industry, "建設・不動産");
  assert.equal(discoverBodies[0].city, "高崎市");
  assert.equal(discoverBodies[0].rotation, undefined, "設定の rotation は企業探しに渡さない");
  assert.equal(oz(r).queued, 1);
  const ins = queueInserts();
  assert.equal(ins.length, 1);
  assert.match(ins[0].text, /'on_hold'/);
  assert.equal(ins[0].values[ins[0].values.length - 1], "[保留] 自動パイプラインで追加(検索: 建設・不動産×高崎市)");
});

test("新しい候補が0件なら、次の組み合わせでもう1回だけ探す", async () => {
  reset();
  discoverReplies = [{ configured: true, results: [] }, { configured: true, results: [] }];
  const r = await call();
  assert.deepEqual(discoverBodies.map((b) => `${b.industry}×${b.city}`), ["製造業×高崎市", "建設・不動産×高崎市"]);
  assert.equal(oz(r).search.industry, "建設・不動産");
  assert.equal(oz(r).error, null);
});

test("AIの絞り込みに失敗した日は探し直さず、登録もしない", async () => {
  reset();
  discoverReplies = [{ configured: true, results: [], ai_filter_error: "Claude APIエラー (status 400): Your credit balance is too low" }];
  const r = await call();
  assert.equal(discoverBodies.length, 1);
  assert.match(oz(r).error, /^企業探しのAIの絞り込みに失敗した/);
  assert.equal(queueInserts().length, 0);
});

test("rotation が無ければ従来どおり固定の条件で1回だけ検索する。hold_new_companies: false なら送信待ち(pending)で積む", async () => {
  reset({ search_params: { industry: "製造業", hold_new_companies: false } });
  discoverReplies = [{ configured: true, results: [{ name: "株式会社テスト", url: "https://test.example.jp/" }] }];
  const r = await call();
  assert.equal(discoverBodies.length, 1);
  assert.equal(discoverBodies[0].industry, "製造業");
  assert.equal(discoverBodies[0].city, undefined);
  assert.equal(discoverBodies[0].hold_new_companies, undefined, "設定の項目は企業探しに渡さない");
  const ins = queueInserts();
  assert.equal(ins.length, 1);
  assert.match(ins[0].text, /'pending'/);
  assert.equal(oz(r).held, false);
});

test("hold_new_companies が無い設定(今の本番の設定)でも、新しい企業は保留で積む", async () => {
  reset({ search_params: { industry: "製造業" } });
  discoverReplies = [{ configured: true, results: [{ name: "株式会社テスト", url: "https://test.example.jp/" }] }];
  const r = await call();
  assert.match(queueInserts()[0].text, /'on_hold'/);
  assert.equal(queueInserts()[0].values[queueInserts()[0].values.length - 1], "[保留] 自動パイプラインで追加(検索: 製造業)");
  assert.equal(oz(r).held, true);
});
