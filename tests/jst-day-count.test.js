// 「今日」の数え方を日本時間にした修正のテスト。
//   - 1日に調べる数(discover_daily_limit): 自動パイプラインの記録を、作られた時刻の日本時間の日付で数える
//   - 自動パイプラインの記録の run_date: 日本時間の日付で書く
//   - 1日の送信の上限(daily_send_limit): メールの送信と、保留からの自動の移し替えで、送信記録を日本時間の日付で数える
// DB の日付(CURRENT_DATE)は DB の時刻の設定(Neon の既定は UTC)で決まり、日本時間の 0:00〜9:00 が前の日に
// 数えられていた(朝 6:05・8:05 の企業探しが、前の日の 18:00 の分と合わせて数えられる)。
// 時計は日本時間 2026-10-28(水)6:05 = UTC 10/27 21:05 に固定する(UTC では前の日)。
// lib/db・api/discover・lib/gmail-sender を require キャッシュで偽物に差し替え、DB・ネットワークは使わない
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const NOW = new Date("2026-10-27T21:05:00Z");
const JST_TODAY = "2026-10-28";

const calls = [];
let settings = {};
function fakeSql(strings, ...values) {
  const text = strings.join("?").replace(/\s+/g, " ").trim();
  calls.push({ text, values });
  if (text.includes("SUM(researched_count)")) return Promise.resolve([{ done: 0 }]);
  if (text.startsWith("SELECT * FROM auto_pipeline_config")) {
    return Promise.resolve([{ project: values[0], enabled: true, variant_id: 7, daily_limit: 12, search_params: {} }]);
  }
  if (text.includes("AS count FROM send_logs WHERE")) return Promise.resolve([{ count: 0 }]);
  if (text.includes("FROM companies WHERE id")) {
    return Promise.resolve([{ id: 134, name: "群馬くみあい運輸株式会社", url: "http://www.gku.co.jp/", email: "info@gku.co.jp", project: "ozukanzukan", archived: false, action_status: "none", research_result: {} }]);
  }
  if (text.includes("FROM message_variants WHERE id")) return Promise.resolve([{ id: 8, project: "ozukanzukan", subject_template: "件名", body_template: "本文" }]);
  if (text.startsWith("INSERT INTO send_logs")) return Promise.resolve([{ id: 999 }]);
  if (text.startsWith("UPDATE send_logs SET status = 'sent'")) return Promise.resolve([{ id: 999, status: "sent" }]);
  return Promise.resolve([]);
}
fakeSql.query = async () => [];
function stub(rel, exports) {
  const p = require.resolve(path.join(__dirname, "..", rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
stub("lib/db", {
  sql: fakeSql,
  getSettings: async () => ({ skip_weekends_holidays: "false", ...settings }),
  isExcludedDomain: async () => false,
});
stub("api/discover", async (req, res) => res.status(200).json({ configured: true, results: [] }));
stub("lib/gmail-sender", {
  sendEmail: async () => ({ configured: true, messageId: "m1" }),
  ensureLabel: async () => null,
  addLabelToMessage: async () => null,
});
const crm = require("../api/crm");
const sendEmail = require("../api/send-email");

const SECRET = "a-long-random-test-secret-value";
function call(handler, req) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(d) { resolve({ status: this.statusCode, body: d }); return this; },
      setHeader() {},
    };
    handler(req, res);
  });
}
function reset(t, over = {}) {
  calls.length = 0;
  settings = over;
  process.env.CRON_SECRET = SECRET;
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
}
const usesJstDate = (c) => /AT TIME ZONE 'Asia\/Tokyo'\)::date = \?::date/.test(c.text) && c.values.includes(JST_TODAY);

test("1日に調べる数: 記録を作られた時刻の日本時間の日付で数え、CURRENT_DATE(UTC では前の日)を使わない", async (t) => {
  reset(t);
  const r = await call(crm, { method: "GET", query: { action: "run-discover" }, headers: { authorization: `Bearer ${SECRET}` } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const sums = calls.filter((c) => c.text.includes("SUM(researched_count)"));
  assert.equal(sums.length, 2, "2つのプロジェクトで数える");
  for (const c of sums) {
    assert.ok(usesJstDate(c), c.text);
    assert.match(c.text, /\(created_at AT TIME ZONE 'Asia\/Tokyo'\)::date/);
    assert.doesNotMatch(c.text, /CURRENT_DATE|run_date/);
  }
});

test("自動パイプラインの記録の run_date を日本時間の日付で書く", async (t) => {
  reset(t);
  await call(crm, { method: "GET", query: { action: "run-discover" }, headers: { authorization: `Bearer ${SECRET}` } });
  const inserts = calls.filter((c) => c.text.startsWith("INSERT INTO auto_pipeline_logs"));
  assert.ok(inserts.length >= 1);
  for (const c of inserts) {
    assert.doesNotMatch(c.text, /CURRENT_DATE/);
    assert.equal(c.values[1], JST_TODAY, "run_date");
  }
});

test("1日の送信の上限(メール・自動): 送信記録を日本時間の日付で数える。上限に達していたら送らない", async (t) => {
  reset(t, { daily_send_limit: "5" });
  const r = await call(sendEmail, { method: "POST", body: { company_id: 134, variant_id: 8, trigger_source: "auto_pipeline" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const counts = calls.filter((c) => c.text.includes("AS count FROM send_logs WHERE"));
  assert.equal(counts.length, 1);
  assert.ok(usesJstDate(counts[0]), counts[0].text);
  assert.doesNotMatch(counts[0].text, /CURRENT_DATE/);
});

test("1日の送信の上限(保留からの自動の移し替え): 送信記録を日本時間の日付で数える", async (t) => {
  reset(t, { auto_release_hold: "true" });
  const r = await call(crm, { method: "GET", query: { action: "run-send-queue" }, headers: { authorization: `Bearer ${SECRET}` } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const counts = calls.filter((c) => c.text.includes("AS count FROM send_logs WHERE"));
  assert.ok(counts.length >= 1, "送信の数を数える");
  for (const c of counts) {
    assert.ok(usesJstDate(c), c.text);
    assert.doesNotMatch(c.text, /CURRENT_DATE/);
  }
});
