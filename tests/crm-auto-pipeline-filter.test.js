// 自動パイプライン(api/crm.js の run-auto-pipeline)が、企業探しのAIの絞り込みに失敗した日は企業を登録せず、
// 止めた理由を auto_pipeline_logs に記録することのテスト。lib/db と api/discover はrequireキャッシュで偽物に差し替える
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const calls = [];
let discoverBody;
function fakeSql(strings, ...values) {
  const text = strings.join("?").replace(/\s+/g, " ").trim();
  calls.push({ text, values });
  if (text.includes("FROM auto_pipeline_config WHERE project")) {
    return Promise.resolve(values[0] === "ozukanzukan"
      ? [{ project: "ozukanzukan", enabled: true, search_params: { industry: "製造業" }, variant_id: 7, daily_limit: 15 }]
      : []);
  }
  return Promise.resolve([]);
}
fakeSql.query = async () => [];
function stub(rel, exports) {
  const p = require.resolve(path.join(__dirname, "..", rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
stub("lib/db", { sql: fakeSql, getSettings: async () => ({ skip_weekends_holidays: "false" }), isExcludedDomain: async () => false });
stub("api/discover", async (req, res) => res.status(200).json(discoverBody));
const handler = require("../api/crm");

function call() {
  return new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(d) { resolve({ status: this.statusCode, body: d }); return this; } };
    handler({ method: "POST", query: { action: "run-auto-pipeline" }, headers: {}, body: {} }, res);
  });
}

test("企業探しのAIの絞り込みに失敗した日は、企業を登録せず、止めた理由を記録する", async () => {
  calls.length = 0;
  discoverBody = { configured: true, results: [], ai_filter_error: "Claude APIエラー (status 400): Your credit balance is too low" };
  const r = await call();
  assert.equal(r.status, 200);
  const oz = r.body.results.find((x) => x.project === "ozukanzukan");
  assert.equal(oz.found, 0);
  assert.equal(oz.queued, 0);
  assert.match(oz.error, /^企業探しのAIの絞り込みに失敗した\(クレジット不足\)ため、今日の企業の登録を止めました: Claude APIエラー/);
  const log = calls.find((c) => /^INSERT INTO auto_pipeline_logs/.test(c.text) && c.values[0] === "ozukanzukan");
  assert.match(log.values[log.values.length - 1], /^企業探しのAIの絞り込みに失敗した/);
  assert.ok(!calls.some((c) => /^INSERT INTO companies/.test(c.text)), "企業を登録しない");
});

test("絞り込みに成功して候補が無い日は、従来どおりエラーにしない", async () => {
  calls.length = 0;
  discoverBody = { configured: true, results: [] };
  const r = await call();
  const oz = r.body.results.find((x) => x.project === "ozukanzukan");
  assert.equal(oz.error, null);
});
