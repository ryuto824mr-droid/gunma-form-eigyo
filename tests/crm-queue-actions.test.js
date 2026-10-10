// api/crm.js?action=send-queue の段階2の操作(バリアント変更・保留・再開・却下・保留への追加)と、
// 既存の操作(send.htmlのsent記録・却下・失敗からの再送、companies.htmlのキュー登録)のテスト。
// lib/db を、行を覚える簡単な偽物に差し替える。実際のDB・ネットワーク・送信APIには一切つながない
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

let db;
const calls = [];
let raceOnUpdate = false; // trueなら条件付きUPDATEが0件になる(送信処理と同時に動いた場合の再現)
let uniqueViolationOnUpdate = false;

function fakeSql(strings, ...v) {
  const text = strings.join("?").replace(/\s+/g, " ").trim();
  calls.push({ text, values: v });
  const q = db.queue;
  const ok = (rows) => Promise.resolve(rows);
  if (text.startsWith("SELECT * FROM send_queue WHERE id = ?")) return ok(q.filter((r) => r.id === v[0]));
  if (text.startsWith("SELECT * FROM companies WHERE id = ?")) {
    const c = db.companies[v[0]];
    return ok(c ? [{ ...c, research_result: { automatable: c.automatable === "true" } }] : []);
  }
  if (text.includes("FROM companies WHERE id = ?")) return ok(db.companies[v[0]] ? [db.companies[v[0]]] : []);
  if (text.includes("FROM send_logs WHERE company_id = ?")) return ok(db.records.has(v[0]) ? [{ found: 1 }] : []);
  if (text.includes("FROM message_variants WHERE id = ?")) return ok(db.variants[v[0]] ? [db.variants[v[0]]] : []);
  if (text.includes("FROM send_queue WHERE company_id = ? AND status IN ('pending', 'sending', 'on_hold')")) {
    return ok(q.filter((r) => r.company_id === v[0] && ["pending", "sending", "on_hold"].includes(r.status)));
  }
  if (text.includes("FROM send_queue WHERE company_id = ? AND variant_id = ? AND status IN ('pending', 'sending')")) {
    return ok(q.filter((r) => r.company_id === v[0] && r.variant_id === v[1] && ["pending", "sending"].includes(r.status)));
  }
  if (text.includes("FROM send_queue WHERE company_id = ? AND status = 'on_hold'")) {
    return ok(q.filter((r) => r.company_id === v[0] && r.status === "on_hold"));
  }
  if (text.startsWith("UPDATE send_queue SET variant_id = ?")) {
    if (raceOnUpdate) return ok([]);
    const r = q.find((x) => x.id === v[1] && ["pending", "on_hold"].includes(x.status));
    if (!r) return ok([]);
    r.variant_id = v[0];
    return ok([{ ...r }]);
  }
  if (text.startsWith("UPDATE send_queue SET status = ?")) {
    if (uniqueViolationOnUpdate) return Promise.reject(new Error('duplicate key value violates unique constraint "send_queue_pending_company_variant_uidx"'));
    if (raceOnUpdate) return ok([]);
    const r = q.find((x) => x.id === v[1] && x.status === v[2]);
    if (!r) return ok([]);
    r.status = v[0];
    return ok([{ ...r }]);
  }
  if (text.startsWith("INSERT INTO send_queue (project, company_id, variant_id, channel, status, error_message)")) {
    const r = { id: 900 + q.length, project: v[0], company_id: v[1], variant_id: v[2], channel: "form", status: "on_hold", error_message: "[保留] 「あとで送る」画面から追加" };
    q.push(r);
    return ok([{ ...r }]);
  }
  if (text.startsWith("INSERT INTO send_queue (project, company_id, variant_id, channel, status)")) {
    const r = { id: 900 + q.length, project: v[0], company_id: v[1], variant_id: v[2], channel: v[3], status: "pending" };
    q.push(r);
    return ok([]);
  }
  if (text.startsWith("SELECT * FROM companies WHERE id = ?")) {
    const c = db.companies[v[0]];
    return ok(c ? [{ ...c, research_result: { automatable: c.automatable === "true" } }] : []);
  }
  return ok([]);
}
fakeSql.query = async () => [];

const dbPath = require.resolve(path.join(__dirname, "..", "lib", "db"));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { sql: fakeSql, getSettings: async () => ({}), isExcludedDomain: async () => false } };
// 送信APIが呼ばれたらテストを失敗させる(この操作は送信しない)
for (const rel of ["api/submit-form", "api/send-email"]) {
  const p = require.resolve(path.join(__dirname, "..", rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports: async () => { throw new Error(`${rel} が呼ばれました`); } };
}
const handler = require("../api/crm");

function call(method, body) {
  return new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(d) { resolve({ status: this.statusCode, body: d }); return this; } };
    handler({ method, query: { action: "send-queue" }, body, headers: {} }, res);
  });
}

const company = (id, extra = {}) => ({
  id, name: `会社${id}`, project: "ozukanzukan", status: "researched", archived: false, action_status: "none",
  automatable: "true", rejection_detected: "false", ...extra,
});

function reset() {
  calls.length = 0;
  raceOnUpdate = false;
  uniqueViolationOnUpdate = false;
  db = {
    companies: {
      52: company(52), 42: company(42), 37: company(37),
      60: company(60, { archived: true }), 61: company(61),
    },
    variants: {
      7: { id: 7, name: "動画付き", project: "ozukanzukan" },
      8: { id: 8, name: "動画付き 最新版", project: "ozukanzukan" },
      1: { id: 1, name: "LOCLE 山田", project: "locle" },
    },
    records: new Set([37]),
    queue: [
      { id: 339, project: "ozukanzukan", company_id: 52, variant_id: 7, channel: "form", status: "pending" },
      { id: 345, project: "ozukanzukan", company_id: 42, variant_id: 7, channel: "form", status: "pending" },
      { id: 347, project: "ozukanzukan", company_id: 37, variant_id: 7, channel: "form", status: "on_hold" },
      { id: 350, project: "ozukanzukan", company_id: 61, variant_id: 7, channel: "form", status: "failed" },
      { id: 351, project: "ozukanzukan", company_id: 61, variant_id: 8, channel: "form", status: "sending" },
    ],
  };
}
const rowOf = (id) => db.queue.find((r) => r.id === id);

test("バリアント変更: 送信待ちの行を変更できる(条件付きUPDATE)", async () => {
  reset();
  const r = await call("PATCH", { id: 339, variant_id: 8 });
  assert.equal(r.status, 200);
  assert.equal(rowOf(339).variant_id, 8);
  const upd = calls.find((c) => c.text.startsWith("UPDATE send_queue SET variant_id"));
  assert.match(upd.text, /status IN \('pending', 'on_hold'\)/);
});

test("バリアント変更: プロジェクト違い・送信中・同時に送信中になった場合は変更しない", async () => {
  reset();
  let r = await call("PATCH", { id: 339, variant_id: 1 });
  assert.equal(r.status, 400);
  assert.equal(rowOf(339).variant_id, 7);
  r = await call("PATCH", { id: 351, variant_id: 7 });
  assert.equal(r.status, 409, "送信中の行");
  reset();
  raceOnUpdate = true;
  r = await call("PATCH", { id: 339, variant_id: 8 });
  assert.equal(r.status, 409, "判定後に送信中になった");
  assert.equal(rowOf(339).variant_id, 7);
});

test("statusとvariant_idを同時に指定したら400", async () => {
  reset();
  const r = await call("PATCH", { id: 339, variant_id: 8, status: "on_hold" });
  assert.equal(r.status, 400);
  assert.equal(calls.length, 0);
});

test("保留にする → 再開する(送信記録なし)", async () => {
  reset();
  let r = await call("PATCH", { id: 339, status: "on_hold" });
  assert.equal(r.status, 200);
  assert.equal(rowOf(339).status, "on_hold");
  r = await call("PATCH", { id: 339, status: "pending" });
  assert.equal(r.status, 200);
  assert.equal(rowOf(339).status, "pending");
  const upd = calls.filter((c) => c.text.startsWith("UPDATE send_queue SET status"));
  for (const u of upd) assert.match(u.text, /WHERE id = \? AND status = \?/, "読み込んだ時点の状態を条件にする");
});

test("再開: 送信記録のある企業は confirm_has_record が無いと409、あれば再開", async () => {
  reset();
  let r = await call("PATCH", { id: 347, status: "pending" });
  assert.equal(r.status, 409);
  assert.equal(r.body.type, "needs_confirm_has_record");
  assert.equal(rowOf(347).status, "on_hold");
  r = await call("PATCH", { id: 347, status: "pending", confirm_has_record: true });
  assert.equal(r.status, 200);
  assert.equal(rowOf(347).status, "pending");
});

test("再開: アーカイブ済みの企業は不可", async () => {
  reset();
  db.queue.push({ id: 360, project: "ozukanzukan", company_id: 60, variant_id: 7, channel: "form", status: "on_hold" });
  const r = await call("PATCH", { id: 360, status: "pending" });
  assert.equal(r.status, 400);
  assert.equal(r.body.type, "ineligible");
  assert.equal(rowOf(360).status, "on_hold");
});

test("一意制約にぶつかったら409(500にしない)", async () => {
  reset();
  uniqueViolationOnUpdate = true;
  const r = await call("PATCH", { id: 339, status: "on_hold" });
  assert.equal(r.status, 409);
  assert.equal(r.body.type, "duplicate");
});

test("既存の操作: send.htmlの却下・sent記録・失敗からの再送はこれまでどおり", async () => {
  reset();
  let r = await call("PATCH", { id: 345, status: "dismissed" });
  assert.equal(r.status, 200);
  assert.equal(rowOf(345).status, "dismissed");
  r = await call("PATCH", { id: 339, status: "sent" });
  assert.equal(r.status, 200);
  assert.equal(rowOf(339).status, "sent");
  // 失敗からの再送: 同じ企業(61)に送信中の行(351)があるため、二重送信を防いで409
  r = await call("PATCH", { id: 350, status: "pending" });
  assert.equal(r.status, 409);
  assert.equal(r.body.type, "duplicate");
  // 送信中の行が無くなれば再送できる
  rowOf(351).status = "sent";
  r = await call("PATCH", { id: 350, status: "pending" });
  assert.equal(r.status, 200);
  assert.equal(rowOf(350).status, "pending");
});

test("保留への追加: on_holdで作る。送信記録あり・対象外・すでに入っている企業は追加しない", async () => {
  reset();
  let r = await call("POST", { hold: true, company_id: 61, project: "ozukanzukan", variant_id: 8 });
  assert.equal(r.status, 409, "61は送信中の行がある");
  db.queue = db.queue.filter((x) => x.company_id !== 61);
  r = await call("POST", { hold: true, company_id: 61, project: "ozukanzukan", variant_id: 8 });
  assert.equal(r.status, 201);
  assert.equal(r.body.status, "on_hold");
  assert.equal(r.body.variant_id, 8);
  assert.equal(db.queue.filter((x) => x.company_id === 61).length, 1);

  db.companies[70] = company(70);
  db.records.add(70);
  assert.equal((await call("POST", { hold: true, company_id: 70, project: "ozukanzukan", variant_id: 8 })).body.type, "has_record");
  assert.equal((await call("POST", { hold: true, company_id: 60, project: "ozukanzukan", variant_id: 8 })).body.type, "ineligible");
  assert.equal((await call("POST", { hold: true, company_id: 999, project: "ozukanzukan", variant_id: 8 })).status, 404);
  assert.equal((await call("POST", { hold: true, company_id: 52, project: "ozukanzukan", variant_id: 1 })).status, 400, "locleのバリアント");
});

test("companies.htmlのキュー登録: 保留中の企業には、バリアントが違っても積まない", async () => {
  reset();
  // 37は保留中(バリアント7)。バリアント8で登録しようとしても積まない
  let r = await call("POST", { company_id: 37, project: "ozukanzukan", variant_id: 8 });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.queued, r.body.reason], [false, "on_hold"]);
  assert.equal(db.queue.filter((x) => x.company_id === 37).length, 1);
  // 保留していない企業は従来どおり積める
  db.companies[80] = company(80);
  r = await call("POST", { company_id: 80, project: "ozukanzukan", variant_id: 8 });
  assert.equal(r.body.queued, true);
  assert.equal(db.queue.find((x) => x.company_id === 80).status, "pending");
});

test("どの操作でも送信API(submit-form/send-email)は呼ばれない", async () => {
  reset();
  await call("PATCH", { id: 339, variant_id: 8 });
  await call("PATCH", { id: 339, status: "on_hold" });
  await call("PATCH", { id: 339, status: "pending" });
  await call("POST", { hold: true, company_id: 61, project: "ozukanzukan", variant_id: 7 });
  // 偽の送信APIは呼ばれると例外を投げるため、ここまで到達すれば呼ばれていない
  assert.ok(true);
});
