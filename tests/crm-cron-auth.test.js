// 毎日の送信(api/crm.js?action=run-scheduled-sends)が、Vercel の cron の鍵(CRON_SECRET)を
// 確かめるテスト。鍵が無い・違う・未登録のときは401で、DB・送信処理に一度も触らないこと。
// lib/db と api/submit-form・api/send-email をrequireキャッシュで偽物に差し替え、DB・ブラウザ・ネットワークは使わない
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const calls = [];
function fakeSql(strings, ...values) {
  calls.push({ text: strings.join("?").replace(/\s+/g, " ").trim(), values });
  return Promise.resolve([]);
}
fakeSql.query = async (...args) => { calls.push({ text: String(args[0]) }); return []; };
let settingsCalls = 0;
const sendCalls = [];
function stub(relPath, exports) {
  const p = require.resolve(path.join(__dirname, "..", relPath));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
stub("lib/db", {
  sql: fakeSql,
  getSettings: async () => { settingsCalls++; return { skip_weekends_holidays: "false", auto_send_hour: "99" }; },
  isExcludedDomain: async () => false,
});
stub("api/submit-form", async (req, res) => { sendCalls.push(req.body); return res.status(200).json({}); });
stub("api/send-email", async (req, res) => { sendCalls.push(req.body); return res.status(200).json({}); });
const handler = require("../api/crm");

function runCron(headers) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(d) { resolve({ status: this.statusCode, body: d }); return this; },
      setHeader() {},
    };
    handler({ method: "GET", query: { action: "run-scheduled-sends" }, headers }, res);
  });
}

function reset() {
  calls.length = 0;
  sendCalls.length = 0;
  settingsCalls = 0;
}

const SECRET = "a-long-random-test-secret-value";

test("CRON_SECRET が未登録なら、鍵を付けても401で何もしない", async () => {
  reset();
  delete process.env.CRON_SECRET;
  const r = await runCron({ authorization: `Bearer ${SECRET}` });
  assert.equal(r.status, 401);
  assert.match(r.body.error, /CRON_SECRET が登録されていない/);
  assert.equal(calls.length, 0, "DBに触らない");
  assert.equal(settingsCalls, 0);
  assert.equal(sendCalls.length, 0);
});

test("鍵が無い・違う・形が違うときは401で何もしない", async () => {
  process.env.CRON_SECRET = SECRET;
  for (const headers of [
    {},
    { authorization: "" },
    { authorization: "Bearer wrong" },
    { authorization: SECRET },
    { authorization: `Bearer ${SECRET}x` },
    { authorization: `bearer ${SECRET}` },
    { "x-vercel-cron": "1" },
  ]) {
    reset();
    const r = await runCron(headers);
    assert.equal(r.status, 401, JSON.stringify(headers));
    assert.match(r.body.error, /認証に失敗しました/);
    assert.equal(calls.length, 0, "DBに触らない");
    assert.equal(settingsCalls, 0);
    assert.equal(sendCalls.length, 0);
  }
});

test("正しい鍵なら今までどおり動く(送信待ちが空なので何も送らない)", async () => {
  reset();
  process.env.CRON_SECRET = SECRET;
  const r = await runCron({ authorization: `Bearer ${SECRET}` });
  assert.equal(r.status, 200);
  assert.ok(r.body.send_queue_recovery, "詰まりの復旧が動く");
  assert.ok(r.body.send_queue, "送信待ちの処理が動く");
  assert.equal(settingsCalls, 1);
  assert.equal(sendCalls.length, 0);
  assert.ok(calls.some((c) => c.text.startsWith("UPDATE send_queue SET status = 'failed'")), "復旧のSQLが実行される");
});
