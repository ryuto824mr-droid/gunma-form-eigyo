// api/analytics.js?action=scheduled-sends の PATCH(予約のバリアント変更)のテスト。
// lib/db をrequireキャッシュで偽物に差し替え、DB・ネットワークは使わない
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

let db;
const calls = [];
let raceOnUpdate = false;
function fakeSql(strings, ...v) {
  const text = strings.join("?").replace(/\s+/g, " ").trim();
  calls.push({ text, values: v });
  const ok = (rows) => Promise.resolve(rows);
  if (text.startsWith("SELECT * FROM scheduled_sends WHERE id = ?")) return ok(db.scheduled.filter((r) => r.id === v[0]));
  if (text.includes("FROM companies WHERE id = ?")) return ok(db.companies[v[0]] ? [db.companies[v[0]]] : []);
  if (text.includes("FROM message_variants WHERE id = ?")) return ok(db.variants[v[0]] ? [db.variants[v[0]]] : []);
  if (text.startsWith("UPDATE scheduled_sends SET variant_id = ?")) {
    if (raceOnUpdate) return ok([]);
    const r = db.scheduled.find((x) => x.id === v[1] && x.status === "pending");
    if (!r) return ok([]);
    r.variant_id = v[0];
    return ok([{ ...r }]);
  }
  return ok([]);
}
const dbPath = require.resolve(path.join(__dirname, "..", "lib", "db"));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { sql: fakeSql } };
const handler = require("../api/analytics");

function call(method, body) {
  return new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(d) { resolve({ status: this.statusCode, body: d }); return this; } };
    handler({ method, query: { action: "scheduled-sends" }, body, headers: {} }, res);
  });
}

function reset() {
  calls.length = 0;
  raceOnUpdate = false;
  db = {
    companies: { 52: { id: 52, project: "ozukanzukan" } },
    variants: {
      7: { id: 7, name: "動画付き", project: "ozukanzukan" },
      8: { id: 8, name: "動画付き 最新版", project: "ozukanzukan" },
      1: { id: 1, name: "LOCLE 山田", project: "locle" },
    },
    scheduled: [
      { id: 1, company_id: 52, variant_id: 7, status: "pending", scheduled_at: "2026-10-20T00:00:00Z" },
      { id: 2, company_id: 52, variant_id: 7, status: "cancelled", scheduled_at: "2026-09-01T00:00:00Z" },
    ],
  };
}

test("pendingの予約のバリアントを変更できる(pendingを条件にしたUPDATE)", async () => {
  reset();
  const r = await call("PATCH", { id: 1, variant_id: 8 });
  assert.equal(r.status, 200);
  assert.equal(db.scheduled[0].variant_id, 8);
  assert.match(calls.find((c) => c.text.startsWith("UPDATE")).text, /WHERE id = \? AND status = 'pending'/);
});

test("停止(cancelled)した予約・プロジェクト違い・同じバリアントは変更しない", async () => {
  reset();
  assert.equal((await call("PATCH", { id: 2, variant_id: 8 })).status, 409);
  assert.equal(db.scheduled[1].variant_id, 7);
  assert.equal((await call("PATCH", { id: 1, variant_id: 1 })).status, 400);
  assert.equal((await call("PATCH", { id: 1, variant_id: 7 })).status, 400);
  assert.equal((await call("PATCH", { id: 99, variant_id: 8 })).status, 404);
  assert.equal((await call("PATCH", { id: 1 })).status, 400);
  assert.ok(!calls.some((c) => c.text.startsWith("UPDATE")), "どれもUPDATEしていない");
});

test("判定の後に予約の状態が変わっていたら409", async () => {
  reset();
  raceOnUpdate = true;
  const r = await call("PATCH", { id: 1, variant_id: 8 });
  assert.equal(r.status, 409);
  assert.equal(db.scheduled[0].variant_id, 7);
});
