// 送信だけの処理(api/crm.js?action=run-send-queue)と、保留から送信待ちへの自動の移し替え(2-B)のテスト。
//   - run-send-queue は cron の鍵(CRON_SECRET)が無ければ401で、DB・送信に一度も触らない
//   - run-send-queue は企業探し(自動パイプライン)・予約送信を動かさない
//   - 設定 auto_release_hold が「切」(未設定・"false" 等)のときは、移し替えのための問い合わせを一度もしない
//   - 送信待ちの行は、まだ pending のときだけロックして送る(実行が重なっても二重に送らない)
//   - 「入」でも記録の表(hold_releases)が無ければ何も移さない
// lib/db と api/submit-form・api/send-email を require キャッシュで偽物に差し替え、DB・ブラウザ・ネットワークは使わない
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const calls = [];
const state = { pending: [], lockSucceeds: true, settings: {}, holdTableMissing: false };
function fakeSql(strings, ...values) {
  const text = strings.join("?").replace(/\s+/g, " ").trim();
  calls.push({ text, values });
  if (text.startsWith("SELECT * FROM send_queue WHERE status = 'pending'")) return Promise.resolve(state.pending);
  if (text.startsWith("UPDATE send_queue SET status = 'sending'")) return Promise.resolve(state.lockSucceeds ? [{ id: values[0] }] : []);
  if (text.includes("FROM hold_releases") && state.holdTableMissing) return Promise.reject(new Error('relation "hold_releases" does not exist'));
  if (text.startsWith("SELECT COUNT(*)::int AS count FROM send_logs")) return Promise.resolve([{ count: 0 }]);
  return Promise.resolve([]);
}
fakeSql.query = async (...args) => { calls.push({ text: String(args[0]) }); return []; };
const sendCalls = [];
function stub(relPath, exports) {
  const p = require.resolve(path.join(__dirname, "..", relPath));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
stub("lib/db", {
  sql: fakeSql,
  getSettings: async () => ({ skip_weekends_holidays: "false", auto_send_hour: "99", ...state.settings }),
  isExcludedDomain: async () => false,
});
stub("api/submit-form", async (req, res) => { sendCalls.push(req.body); return res.status(200).json({ success: true, submitStatus: "sent" }); });
stub("api/send-email", async (req, res) => { sendCalls.push(req.body); return res.status(200).json({ success: true }); });
const handler = require("../api/crm");

const SECRET = "a-long-random-test-secret-value";
function run(action, headers = { authorization: `Bearer ${SECRET}` }) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(d) { resolve({ status: this.statusCode, body: d }); return this; },
      setHeader() {},
    };
    handler({ method: "GET", query: { action }, headers }, res);
  });
}
function reset(over = {}) {
  calls.length = 0;
  sendCalls.length = 0;
  Object.assign(state, { pending: [], lockSucceeds: true, settings: {}, holdTableMissing: false }, over);
  process.env.CRON_SECRET = SECRET;
}
const touchedHoldRelease = () => calls.some((c) =>
  c.text.includes("hold_releases") || c.text.includes("SET status = 'pending'") ||
  c.text.includes("research_result->>'automatable'") /* later-list の読み込み */ ||
  c.text.includes("company_info FROM companies WHERE id = ANY"));

test("run-send-queue: 鍵が無い・違うときは401で、DB・送信に触らない", async () => {
  for (const headers of [{}, { authorization: "Bearer wrong" }, { authorization: SECRET }]) {
    reset();
    const r = await run("run-send-queue", headers);
    assert.equal(r.status, 401, JSON.stringify(headers));
    assert.equal(calls.length, 0);
    assert.equal(sendCalls.length, 0);
  }
  reset();
  delete process.env.CRON_SECRET;
  const r = await run("run-send-queue");
  assert.equal(r.status, 401);
  assert.equal(calls.length, 0);
});

test("run-send-queue: 送信待ちだけを処理し、企業探し・予約送信は動かさない", async () => {
  reset({ pending: [{ id: 1, company_id: 10, variant_id: 7, channel: "form", project: "ozukanzukan" }] });
  const r = await run("run-send-queue");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(!calls.some((c) => c.text.includes("auto_pipeline_config")), "企業探しの設定を読まない");
  assert.ok(!calls.some((c) => c.text.includes("FROM scheduled_sends")), "予約送信を読まない");
  assert.equal(sendCalls.length, 1, "送信待ちの1件を送る");
  assert.equal(sendCalls[0].trigger_source, "auto_pipeline", "1日の送信上限(daily_send_limit)はこれまでどおりかかる");
  assert.equal(r.body.send_queue.processed, 1);
});

test("送信待ちの行は、まだ pending のときだけロックして送る(ほかの実行が先にロックしていれば送らない)", async () => {
  reset({ pending: [{ id: 1, company_id: 10, variant_id: 7, channel: "form", project: "ozukanzukan" }], lockSucceeds: false });
  const r = await run("run-send-queue");
  assert.equal(r.status, 200);
  const lock = calls.find((c) => c.text.startsWith("UPDATE send_queue SET status = 'sending'"));
  assert.match(lock.text, /AND status = 'pending' RETURNING id/);
  assert.equal(sendCalls.length, 0, "ロックできなかった行は送らない");
  assert.equal(r.body.send_queue.processed, 0);
});

test("auto_release_hold が「切」のときは、移し替えのための問い合わせを一度もしない(run-send-queue・run-scheduled-sends)", async () => {
  for (const value of [undefined, "", "false", "0", "off", "TRUE "]) {
    // "TRUE " は前後の空白を除いて小文字にすると "true" になるため「入」。それ以外はすべて「切」
    if (value === "TRUE ") continue;
    for (const action of ["run-send-queue", "run-scheduled-sends"]) {
      reset({ settings: value === undefined ? {} : { auto_release_hold: value } });
      const r = await run(action);
      assert.equal(r.status, 200, `${action} ${value}`);
      assert.deepEqual(r.body.hold_release, { enabled: false, released: 0 }, `${action} ${value}`);
      assert.equal(touchedHoldRelease(), false, `${action} auto_release_hold=${JSON.stringify(value)} のとき問い合わせない`);
    }
  }
});

test("auto_release_hold が「入」でも、記録の表(hold_releases)が無ければ1件も移さない", async () => {
  reset({ settings: { auto_release_hold: "true" }, holdTableMissing: true });
  const r = await run("run-send-queue");
  assert.equal(r.status, 200);
  assert.equal(r.body.hold_release.enabled, true);
  assert.match(r.body.hold_release.error, /hold_releases/);
  assert.ok(!calls.some((c) => c.text.includes("SET status = 'pending'")), "保留を送信待ちにしない");
});
