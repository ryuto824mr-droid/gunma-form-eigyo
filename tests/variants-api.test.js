// 文面(message_variants)の API の動きのテスト。DB は lib/db を偽物に差し替えて、問い合わせの種類ごとに決めた行を返す。
// 画面(public/variants.html)からの呼び出しは次の4つ:
//   GET /api/variants?project= ・POST /api/variants ・PATCH /api/variants/:id ・DELETE /api/variants/:id
// /api/variants/:id は vercel.json の書き換えで /api/variants?id=:id になる(関数の数を減らすため1つの関数にまとめた)。
// このテストは、まとめる前(api/variants.js + api/variants/[id].js)と後(api/variants.js だけ)の両方で同じ結果になる
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");

const queries = [];
const db = { variants: [], logsFor: new Set() };
function fakeSql(strings, ...values) {
  const text = strings.join("?").replace(/\s+/g, " ").trim();
  queries.push({ text, values });
  if (text.startsWith("SELECT v.*, EXISTS")) return Promise.resolve(db.variants.map((v) => ({ ...v, has_logs: db.logsFor.has(v.id) })));
  if (text.startsWith("SELECT id FROM send_logs WHERE variant_id")) return Promise.resolve(db.logsFor.has(values[0]) ? [{ id: 1 }] : []);
  if (text.startsWith("SELECT * FROM message_variants WHERE id")) return Promise.resolve(db.variants.filter((v) => v.id === values[0]));
  if (text.startsWith("DELETE FROM message_variants")) {
    const i = db.variants.findIndex((v) => v.id === values[0]);
    if (i < 0) return Promise.resolve([]);
    db.variants.splice(i, 1);
    return Promise.resolve([{ id: values[0] }]);
  }
  if (text.startsWith("UPDATE message_variants")) {
    const id = values[values.length - 1];
    const v = db.variants.find((x) => x.id === id);
    Object.assign(v, { name: values[0], channel: values[1], subject_template: values[2], body_template: values[3] });
    return Promise.resolve([{ ...v }]);
  }
  if (text.startsWith("INSERT INTO message_variants")) {
    const row = { id: 100 + db.variants.length, name: values[0], channel: values[1], project: values[values.length - 1] };
    db.variants.push(row);
    return Promise.resolve([row]);
  }
  return Promise.resolve([]);
}
const dbPath = require.resolve(path.join(__dirname, "..", "lib", "db"));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { sql: fakeSql } };

const listHandler = require("../api/variants");
const idFile = path.join(__dirname, "..", "api", "variants", "[id].js");
// まとめる前は [id].js、まとめた後は api/variants.js が :id の要求を受け持つ
const idHandler = fs.existsSync(idFile) ? require(idFile) : listHandler;

function call(handler, { method, query = {}, body }) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(d) { resolve({ status: this.statusCode, body: d }); return this; },
    };
    handler({ method, query, body }, res);
  });
}
// 画面と同じ URL の形で呼ぶ(:id は書き換え後の ?id= の形)
const api = {
  list: (project) => call(listHandler, { method: "GET", query: { project } }),
  create: (body) => call(listHandler, { method: "POST", body }),
  patch: (id, body) => call(idHandler, { method: "PATCH", query: { id: String(id) }, body }),
  del: (id) => call(idHandler, { method: "DELETE", query: { id: String(id) } }),
  byId: (method, id) => call(idHandler, { method, query: { id: String(id) } }),
};

test.beforeEach(() => {
  queries.length = 0;
  db.variants = [
    { id: 7, name: "動画付き", channel: "form", subject_template: null, body_template: "本文7", project: "ozukanzukan", tags: {} },
    { id: 9, name: "下書き", channel: "form", subject_template: "件名", body_template: "本文9", project: "ozukanzukan", tags: {} },
  ];
  db.logsFor = new Set([7]); // 7 は送信記録あり
});

test("一覧(GET /api/variants?project=)は送信記録の有無付きで返す", async () => {
  const r = await api.list("ozukanzukan");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.map((v) => [v.id, v.has_logs]), [[7, true], [9, false]]);
});

test("作成(POST /api/variants)", async () => {
  const r = await api.create({ name: "新しい文面", channel: "form", body_template: "本文", project: "locle" });
  assert.equal(r.status, 201);
  assert.equal(r.body.name, "新しい文面");
  assert.equal((await api.create({ channel: "form", body_template: "本文" })).status, 400, "名前が無い");
});

test("編集(PATCH /api/variants/:id): 送信記録の無い文面は直せる", async () => {
  const r = await api.patch(9, { name: "下書き(直した)" });
  assert.equal(r.status, 200);
  assert.equal(r.body.name, "下書き(直した)");
  assert.equal(r.body.body_template, "本文9", "指定しなかった項目は今の値のまま");
});

test("編集(PATCH): 送信記録のある文面は断る(409)・無い文面は404・空の名前は400", async () => {
  const r = await api.patch(7, { name: "x" });
  assert.equal(r.status, 409);
  assert.equal(r.body.type, "has_logs");
  assert.equal((await api.patch(999, { name: "x" })).status, 404);
  assert.equal((await api.patch(9, { name: "  " })).status, 400);
  assert.ok(!queries.some((q) => q.text.startsWith("UPDATE") && q.values.includes("x")), "送信記録のある文面は書き換えない");
});

test("削除(DELETE /api/variants/:id): 送信記録の無い文面は消せる・ある文面は断る(409)・無い文面は404", async () => {
  const ok = await api.del(9);
  assert.deepEqual([ok.status, ok.body], [200, { id: 9, deleted: true }]);
  assert.equal((await api.del(7)).status, 409);
  assert.equal((await api.del(999)).status, 404);
  assert.deepEqual(db.variants.map((v) => v.id), [7]);
});

test(":id の要求: id が数でなければ400、GET・POST は405", async () => {
  assert.equal((await api.byId("DELETE", "abc")).status, 400);
  assert.equal((await api.byId("PATCH", "0")).status, 400);
  assert.equal((await api.byId("GET", 9)).status, 405);
  assert.equal((await api.byId("POST", 9)).status, 405);
});
