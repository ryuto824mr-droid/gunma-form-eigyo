// GET /api/send-logs?id=<ID> (送信記録1件の詳細。読み取り専用)のテスト。
// lib/db をrequireキャッシュで偽物に差し替え、DB・ネットワークは使わない
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const calls = [];
let rows = [];
function fakeSql(strings, ...values) {
  const text = strings.join("?").replace(/\s+/g, " ").trim();
  calls.push({ text, values });
  if (text.includes("WHERE sl.id = ?")) return Promise.resolve(rows.filter(r => r.id === values[0]));
  return Promise.resolve(rows);
}
const dbPath = require.resolve(path.join(__dirname, "..", "lib", "db"));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { sql: fakeSql } };
const handler = require("../api/send-logs");

function call(method, query, body) {
  return new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(d) { resolve({ status: this.statusCode, body: d }); return this; } };
    handler({ method, query: query || {}, body }, res);
  });
}

const LOG = {
  id: 700, company_id: 1, variant_id: 7, channel: "form", status: "sent", company_name: "テスト会社", variant_name: "動画付き",
  sender_profile_id: 1,
  sender_snapshot: { project: "ozukanzukan", person_name: "松崎流空", person_name_kana: "まつざきりゅうと", company_name: "株式会社LOCLE", email: "matsuzaki9283@gmail.com", phone: "027-212-2117", body_name_check: "ok" },
  filled_fields: [{ role: "contact_person_name", field: "name", label: "お名前", value: "松崎流空", filled: true }],
  confirm_step: true, result_url: "https://example.com/thanks",
};

test("?id=で送信者の写し・実際の入力値・送信結果をそのまま返す", async () => {
  calls.length = 0;
  rows = [LOG];
  const r = await call("GET", { id: "700" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, LOG);
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /^SELECT sl\.\*/);
  assert.deepEqual(calls[0].values, [700]);
});

test("存在しないidは404", async () => {
  rows = [LOG];
  const r = await call("GET", { id: "701" });
  assert.equal(r.status, 404);
});

test("不正なidは400でDBに問い合わせない", async () => {
  for (const id of ["", "abc", "0", "-1", "1.5", "7 OR 1=1"]) {
    calls.length = 0;
    const r = await call("GET", { id });
    assert.equal(r.status, 400, JSON.stringify(id));
    assert.equal(calls.length, 0, JSON.stringify(id));
  }
});

test("idが無ければ従来どおり一覧を返す(送信者名・会社名のみ)", async () => {
  calls.length = 0;
  rows = [{ id: 1 }, { id: 2 }];
  const r = await call("GET", {});
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 2);
  assert.match(calls[0].text, /sender_snapshot->>'person_name'/);
  assert.doesNotMatch(calls[0].text, /filled_fields/);
});
