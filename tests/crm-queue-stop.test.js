// 送信者プロフィールが未登録・不完全(submit-formがtype: "sender_profile_missing"を返す)のとき、
// 予約送信(scheduled_sends)と送信キュー(send_queue)の処理が中断し、行がpendingのまま残ることのテスト。
// lib/db と api/submit-form をrequireキャッシュで偽物に差し替え、DB・ブラウザ・ネットワークは使わない
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const calls = [];
let scheduledItems = [];
let queueItems = [];
function fakeSql(strings, ...values) {
  const text = strings.join("?").replace(/\s+/g, " ").trim();
  calls.push({ text, values });
  if (text.startsWith("SELECT * FROM scheduled_sends")) return Promise.resolve(scheduledItems);
  // 実際のSQLと同じく、status='pending'の行だけを返す(statusが無い行はpending扱い)
  if (text.startsWith("SELECT * FROM send_queue WHERE status = 'pending'")) {
    return Promise.resolve(queueItems.filter((i) => (i.status || "pending") === "pending"));
  }
  return Promise.resolve([]);
}
fakeSql.query = async () => [];

// 現在の日本時間の「時」(予約送信は設定時刻と一致したときだけ動くため)
const jstHour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", hour: "numeric", hourCycle: "h23" }).format(new Date()));

function stub(relPath, exports) {
  const p = require.resolve(path.join(__dirname, "..", relPath));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
stub("lib/db", {
  sql: fakeSql,
  getSettings: async () => ({ skip_weekends_holidays: "false", auto_send_hour: String(jstHour) }),
  isExcludedDomain: async () => false,
});

// 偽のsubmit-form: responsesの先頭から順に応答を返す(尽きたら未登録エラー)
let responses = [];
const submitCalls = [];
const MISSING = { status: 400, body: { error: "このプロジェクト(ozukanzukan)の送信者プロフィールが未登録です。CRMの設定画面で登録してください", type: "sender_profile_missing" } };
stub("api/submit-form", async (req, res) => {
  submitCalls.push(req.body);
  const r = responses.shift() || MISSING;
  return res.status(r.status).json(r.body);
});
const handler = require("../api/crm");

function runCron() {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(d) { resolve({ status: this.statusCode, body: d }); return this; },
      setHeader() {},
    };
    handler({ method: "GET", query: { action: "run-scheduled-sends" }, headers: {} }, res);
  });
}

function reset() {
  calls.length = 0;
  submitCalls.length = 0;
  responses = [];
}
const updatesOf = (table) => calls.filter(c => c.text.startsWith(`UPDATE ${table}`)).map(c => ({ text: c.text, values: c.values }));

test("未登録なら予約送信もキューも1件目で中断し、すべてpendingのまま残る", async () => {
  reset();
  scheduledItems = [
    { id: 11, channel: "form", company_id: 1, variant_id: 7 },
    { id: 12, channel: "form", company_id: 2, variant_id: 7 },
  ];
  queueItems = [
    { id: 21, channel: "form", company_id: 3, variant_id: 7 },
    { id: 22, channel: "form", company_id: 4, variant_id: 7 },
  ];
  const r = await runCron();
  assert.equal(r.status, 200);

  // 予約送信: submit-formは1回だけ呼ばれ、scheduled_sendsは一切更新されない(pendingのまま)
  assert.equal(r.body.scheduled_sends.processed, 0);
  assert.equal(r.body.scheduled_sends.failed, 0);
  assert.equal(r.body.scheduled_sends.stopped_reason.type, "sender_profile_missing");
  assert.deepEqual(updatesOf("scheduled_sends"), []);

  // 送信キュー: 1件目をsendingにロック → pendingに戻して中断。2件目には触れない
  assert.equal(r.body.send_queue.processed, 0);
  assert.equal(r.body.send_queue.failed, 0);
  assert.equal(r.body.send_queue.stopped_reason.type, "sender_profile_missing");
  const q = updatesOf("send_queue").filter(u => !u.text.includes("WHERE status = 'sending' AND")); // 復旧処理のUPDATEは除く
  assert.equal(q.length, 2, JSON.stringify(q));
  assert.match(q[0].text, /SET status = 'sending'/);
  assert.deepEqual(q[0].values, [21]);
  assert.match(q[1].text, /SET status = 'pending'/);
  assert.deepEqual(q[1].values, [21]);
  assert.ok(!calls.some(c => c.values.includes(22) && c.text.startsWith("UPDATE")), "2件目は更新していない");
  assert.ok(!calls.some(c => c.text.startsWith("UPDATE send_queue SET status = 'failed'") && (c.values.includes(21) || c.values.includes(22))), "failedにしていない");

  assert.equal(submitCalls.length, 2, "予約送信で1回・キューで1回だけ");
});

test("途中で未登録エラーになった場合、それまでの送信済みはsent、以降はpendingのまま", async () => {
  reset();
  scheduledItems = [];
  queueItems = [
    { id: 31, channel: "form", company_id: 5, variant_id: 7 },
    { id: 32, channel: "form", company_id: 6, variant_id: 7 },
    { id: 33, channel: "form", company_id: 7, variant_id: 7 },
  ];
  responses = [{ status: 200, body: { success: true } }, MISSING];
  const r = await runCron();
  assert.equal(r.body.send_queue.processed, 1);
  assert.equal(r.body.send_queue.success, 1);
  assert.equal(r.body.send_queue.failed, 0);
  assert.equal(r.body.send_queue.remaining, 2);
  const q = updatesOf("send_queue").filter(u => !u.text.includes("WHERE status = 'sending' AND"));
  assert.deepEqual(q.map(u => [u.text.match(/SET status = '(\w+)'/)[1], u.values[u.values.length - 1]]), [
    ["sending", 31], ["sent", 31], ["sending", 32], ["pending", 32],
  ]);
  assert.equal(submitCalls.length, 2, "3件目は呼ばない");
});

test("他のエラー(フォーム送信失敗など)は従来どおりfailedにして次へ進む", async () => {
  reset();
  scheduledItems = [];
  queueItems = [
    { id: 41, channel: "form", company_id: 8, variant_id: 7 },
    { id: 42, channel: "form", company_id: 9, variant_id: 7 },
  ];
  responses = [{ status: 500, body: { error: "自動送信に失敗しました" } }, { status: 200, body: { success: true } }];
  const r = await runCron();
  assert.equal(r.body.send_queue.failed, 1);
  assert.equal(r.body.send_queue.success, 1);
  assert.equal(r.body.send_queue.stopped_reason, undefined);
});

test("保留中(on_hold)の行は毎日の送信処理で送られない", async () => {
  reset();
  scheduledItems = [];
  queueItems = [
    { id: 61, channel: "form", company_id: 11, variant_id: 7, status: "on_hold" },
    { id: 62, channel: "form", company_id: 12, variant_id: 7, status: "pending" },
    { id: 63, channel: "form", company_id: 13, variant_id: 7, status: "on_hold" },
  ];
  responses = [{ status: 200, body: { success: true } }];
  const r = await runCron();
  assert.equal(r.body.send_queue.processed, 1);
  assert.deepEqual(submitCalls.map((b) => b.company_id), [12], "送られたのはpendingの行だけ");
  const touched = calls.filter((c) => c.text.startsWith("UPDATE send_queue SET status") && (c.values.includes(61) || c.values.includes(63)));
  assert.deepEqual(touched, [], "保留中の行は更新もしない");
});
