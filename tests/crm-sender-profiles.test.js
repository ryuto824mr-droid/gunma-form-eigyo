// api/crm.js?action=sender-profiles のテスト。lib/dbをrequireキャッシュで偽物に差し替え、
// 実際のDB・ネットワークには一切つながない
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

// 偽のsql: 呼ばれたSQLを記録し、responderの戻り値を返す
const calls = [];
let responder = () => [];
function fakeSql(strings, ...values) {
  const text = strings.join("?").replace(/\s+/g, " ").trim();
  calls.push({ text, values });
  try {
    return Promise.resolve(responder(text, values));
  } catch (err) {
    return Promise.reject(err);
  }
}
fakeSql.query = async () => [];

const dbPath = require.resolve(path.join(__dirname, "..", "lib", "db"));
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { sql: fakeSql, getSettings: async () => ({}), isExcludedDomain: async () => false },
};
const handler = require("../api/crm");

function call(method, body) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(data) { resolve({ status: this.statusCode, body: data }); return this; },
      setHeader() {}, end() { resolve({ status: this.statusCode }); },
    };
    handler({ method, query: { action: "sender-profiles" }, body, headers: {} }, res);
  });
}

const PROFILE = {
  person_name: "松崎流空",
  person_name_kana: "まつざきりゅうと",
  company_name: "株式会社LOCLE",
  email: "matsuzaki9283@gmail.com",
  phone: "027-212-2117",
};

function reset(fn) {
  calls.length = 0;
  responder = fn;
}

test("GET: テーブルが無いときはdb-setup未実行と返す", async () => {
  reset(() => { throw new Error('relation "sender_profiles" does not exist'); });
  const r = await call("GET");
  assert.equal(r.status, 503);
  assert.equal(r.body.type, "table_missing");
});

test("GET: 未登録のプロジェクトはregistered:false(初期データなし)", async () => {
  reset((text) => (text.includes("FROM sender_accounts") ? [{ email: "matsuzaki9283@gmail.com" }] : []));
  const r = await call("GET");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, [
    { project: "ozukanzukan", registered: false },
    { project: "locle", registered: false },
  ]);
});

test("GET: 登録済みはプレビューとメール一致を返す", async () => {
  reset((text) => {
    if (text.includes("FROM sender_accounts")) return [{ email: "Matsuzaki9283@gmail.com " }];
    return [{ id: 1, project: "locle", ...PROFILE, updated_at: "2026-10-09T00:00:00Z" }];
  });
  const r = await call("GET");
  const locle = r.body.find(x => x.project === "locle");
  assert.equal(locle.registered, true);
  assert.equal(locle.valid, true);
  assert.equal(locle.email_matches_sender_account, true);
  assert.equal(locle.preview.find(p => p.field.startsWith("フリガナ")).value, "マツザキリュウト");
  assert.equal(r.body.find(x => x.project === "ozukanzukan").registered, false);
});

test("GET: DB上の値に不備があればvalid:false", async () => {
  reset((text) => (text.includes("FROM sender_accounts") ? [] : [{ id: 1, project: "locle", ...PROFILE, phone: "" }]));
  const r = await call("GET");
  const locle = r.body.find(x => x.project === "locle");
  assert.equal(locle.valid, false);
  assert.deepEqual(locle.missing, ["電話番号"]);
  assert.equal(locle.email_matches_sender_account, false);
});

test("PUT preview_only: 保存せずにプレビューを返す", async () => {
  reset((text) => (text.includes("FROM sender_accounts") ? [{ email: "matsuzaki9283@gmail.com" }] : []));
  const r = await call("PUT", { project: "ozukanzukan", ...PROFILE, preview_only: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.saved, false);
  assert.equal(r.body.preview.length, 8);
  assert.ok(!calls.some(c => c.text.includes("INSERT")), "INSERTしていない");
});

test("PUT: 不備があれば400で保存しない", async () => {
  reset(() => []);
  const r = await call("PUT", { project: "locle", ...PROFILE, phone: "027-212-211", email: "" });
  assert.equal(r.status, 400);
  assert.deepEqual(r.body.missing, ["メールアドレス"]);
  assert.equal(r.body.invalid[0].field, "電話番号");
  assert.equal(calls.length, 0, "DBに触れていない");
});

test("PUT: 不明なprojectは400", async () => {
  reset(() => []);
  const r = await call("PUT", { project: "other", ...PROFILE });
  assert.equal(r.status, 400);
  assert.equal(calls.length, 0);
});

test("PUT: 正しければ空白を除いた値で保存する", async () => {
  reset((text, values) => {
    if (text.includes("FROM sender_accounts")) return [];
    if (text.includes("INSERT INTO sender_profiles")) return [{ id: 2, project: values[0], person_name: values[1] }];
    return [];
  });
  const r = await call("PUT", { project: "locle", ...PROFILE, person_name: " 松崎流空　" });
  assert.equal(r.status, 200);
  assert.equal(r.body.saved, true);
  const insert = calls.find(c => c.text.includes("INSERT INTO sender_profiles"));
  assert.deepEqual(insert.values, ["locle", "松崎流空", "まつざきりゅうと", "株式会社LOCLE", "matsuzaki9283@gmail.com", "027-212-2117"]);
  assert.ok(insert.text.includes("ON CONFLICT (project) DO UPDATE"));
});

test("DELETEは受け付けない", async () => {
  reset(() => []);
  const r = await call("DELETE", { project: "locle" });
  assert.equal(r.status, 405);
  assert.equal(calls.length, 0);
});

test("GET check_variants=1: バリアントごとに署名と送信者名を照合する", async () => {
  reset((text) => {
    if (text.includes("FROM sender_accounts")) return [];
    if (text.includes("FROM message_variants")) {
      return [
        { id: 1, name: "LOCLE 山田", project: "locle", channel: "email", subject_template: "LOCLEについて", body_template: "LOCLE　山田" },
        { id: 3, name: "初回挨拶", project: "locle", channel: "form", subject_template: null, body_template: "LOCLEと申します。" },
        { id: 7, name: "動画付き", project: "ozukanzukan", channel: "email", subject_template: "件名", body_template: "編集部の松崎と申します。\nぐんまお仕事図鑑編集部　松崎流空" },
      ];
    }
    return [{ id: 1, project: "ozukanzukan", ...PROFILE, updated_at: "2026-10-09T00:00:00Z" }];
  });
  const res = await new Promise((resolve) => {
    const r = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(d) { resolve({ status: this.statusCode, body: d }); return this; },
    };
    handler({ method: "GET", query: { action: "sender-profiles", check_variants: "1" }, headers: {} }, r);
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.profiles.length, 2);
  const byId = Object.fromEntries(res.body.variant_checks.map(c => [c.variant_id, c.result]));
  assert.deepEqual(byId, { 1: "no_profile", 3: "no_profile", 7: "ok" }, "locleは未登録扱い");
});

test("GET check_variants=1: 登録済みプロジェクトで署名が無ければmismatch", async () => {
  reset((text) => {
    if (text.includes("FROM sender_accounts")) return [];
    if (text.includes("FROM message_variants")) {
      return [
        { id: 1, name: "LOCLE 山田", project: "locle", channel: "email", subject_template: "", body_template: "LOCLE　山田" },
        { id: 3, name: "初回挨拶", project: "locle", channel: "form", subject_template: null, body_template: "LOCLEと申します。" },
      ];
    }
    return [{ id: 2, project: "locle", ...PROFILE, updated_at: "2026-10-09T00:00:00Z" }];
  });
  const res = await new Promise((resolve) => {
    const r = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(d) { resolve({ status: this.statusCode, body: d }); return this; } };
    handler({ method: "GET", query: { action: "sender-profiles", check_variants: "1" }, headers: {} }, r);
  });
  assert.deepEqual(res.body.variant_checks.map(c => [c.variant_id, c.result, c.person_name]),
    [[1, "mismatch", "松崎流空"], [3, "mismatch", "松崎流空"]]);
});
