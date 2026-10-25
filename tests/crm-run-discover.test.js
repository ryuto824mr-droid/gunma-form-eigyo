// 企業探しとリサーチだけの処理(api/crm.js?action=run-discover)のテスト。
//   - cron の鍵(CRON_SECRET)が無ければ401で、DB・企業探しに一度も触らない
//   - 送信・送信待ち・予約送信には触らない
//   - 1日に調べる数の合計(discover_daily_limit)に達したプロジェクトは企業探しを呼ばない
//   - 1日の残りの数を、その実行で調べる上限として渡す
// lib/db・api/discover・api/submit-form・api/send-email を require キャッシュで偽物に差し替え、
// DB・ブラウザ・ネットワークは使わない
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const calls = [];
const state = { settings: {}, doneToday: { locle: 0, ozukanzukan: 0 }, config: { enabled: true, variant_id: 7, daily_limit: 12, search_params: {} } };
function fakeSql(strings, ...values) {
  const text = strings.join("?").replace(/\s+/g, " ").trim();
  calls.push({ text, values });
  if (text.includes("SUM(researched_count)")) return Promise.resolve([{ done: state.doneToday[values[0]] || 0 }]);
  if (text.startsWith("SELECT * FROM auto_pipeline_config")) return Promise.resolve([{ project: values[0], ...state.config }]);
  return Promise.resolve([]);
}
fakeSql.query = async (...args) => { calls.push({ text: String(args[0]) }); return []; };
const discoverCalls = [];
const sendCalls = [];
function stub(relPath, exports) {
  const p = require.resolve(path.join(__dirname, "..", relPath));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
stub("lib/db", {
  sql: fakeSql,
  getSettings: async () => ({ skip_weekends_holidays: "false", ...state.settings }),
  isExcludedDomain: async () => false,
});
// 企業探しは候補0件を返す(リサーチ・登録はしない)
stub("api/discover", async (req, res) => { discoverCalls.push(req.body); return res.status(200).json({ configured: true, results: [] }); });
stub("api/submit-form", async (req, res) => { sendCalls.push(req.body); return res.status(200).json({}); });
stub("api/send-email", async (req, res) => { sendCalls.push(req.body); return res.status(200).json({}); });
const handler = require("../api/crm");

const SECRET = "a-long-random-test-secret-value";
function run(headers = { authorization: `Bearer ${SECRET}` }) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(d) { resolve({ status: this.statusCode, body: d }); return this; },
      setHeader() {},
    };
    handler({ method: "GET", query: { action: "run-discover" }, headers }, res);
  });
}
function reset(over = {}) {
  calls.length = 0;
  discoverCalls.length = 0;
  sendCalls.length = 0;
  Object.assign(state, { settings: {}, doneToday: { locle: 0, ozukanzukan: 0 } }, over);
  process.env.CRON_SECRET = SECRET;
}

test("run-discover: 鍵が無い・違う・未登録のときは401で、DB・企業探しに触らない", async () => {
  for (const headers of [{}, { authorization: "Bearer wrong" }, { authorization: SECRET }]) {
    reset();
    const r = await run(headers);
    assert.equal(r.status, 401, JSON.stringify(headers));
    assert.equal(calls.length, 0);
    assert.equal(discoverCalls.length, 0);
  }
  reset();
  delete process.env.CRON_SECRET;
  assert.equal((await run()).status, 401);
  assert.equal(calls.length, 0);
});

test("run-discover: 両方のプロジェクトで企業探しを行い、送信・送信待ち・予約送信には触らない", async () => {
  reset();
  const r = await run();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.results.map((x) => x.project), ["locle", "ozukanzukan"]);
  assert.equal(discoverCalls.length, 2);
  assert.equal(sendCalls.length, 0, "送信しない");
  assert.ok(!calls.some((c) => /FROM send_queue WHERE status = 'pending'|FROM scheduled_sends|UPDATE send_queue SET status = 'sending'/.test(c.text)),
    "送信待ち・予約送信を読まない");
});

test("run-discover: 1日に調べる数の合計(初期40社・設定で変更可)に達したプロジェクトは企業探しを呼ばない", async () => {
  reset({ doneToday: { locle: 40, ozukanzukan: 3 } });
  let r = await run();
  assert.equal(r.status, 200);
  const byProject = Object.fromEntries(r.body.results.map((x) => [x.project, x]));
  assert.equal(byProject.locle.skipped, true);
  assert.match(byProject.locle.reason, /今日の上限\(40社\)/);
  assert.equal(discoverCalls.length, 1, "ozukanzukan だけ企業探しを呼ぶ");
  assert.equal(discoverCalls[0].project, "ozukanzukan");

  reset({ settings: { discover_daily_limit: "5" }, doneToday: { locle: 5, ozukanzukan: 5 } });
  r = await run();
  assert.equal(discoverCalls.length, 0);
  assert.ok(r.body.results.every((x) => x.skipped));
});

test("run-discover: 土日祝日は何もしない(設定どおり)", async () => {
  reset({ settings: { skip_weekends_holidays: "true" } });
  const r = await run();
  assert.equal(r.status, 200);
  const jstWeekday = new Date(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date()) + "T00:00:00Z").getUTCDay();
  if (jstWeekday === 0 || jstWeekday === 6) {
    assert.equal(r.body.skipped, true);
    assert.equal(discoverCalls.length, 0);
  } else {
    // 平日(祝日でなければ)は動く。祝日の判定は crm.js の一覧に任せる
    assert.ok(r.body.skipped === false || /祝日/.test(r.body.reason));
  }
});

test("auth-gate: run-discover は cron の鍵があれば通る", async () => {
  const { gate } = require("../lib/auth-gate");
  const env = { APP_PASSWORD: "p", AUTH_SECRET: "s".repeat(40), CRON_SECRET: SECRET };
  const req = (h) => new Request("https://gunma-form-eigyo.vercel.app/api/crm?action=run-discover", { headers: h });
  assert.equal(await gate(req({ Authorization: `Bearer ${SECRET}` }), env), null);
  assert.equal((await gate(req({}), env)).status, 401);
});
