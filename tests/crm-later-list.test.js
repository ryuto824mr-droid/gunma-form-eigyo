// api/crm.js?action=later-list(「あとで送る」一覧。読み取り専用)のテスト。
// lib/db をrequireキャッシュで偽物に差し替え、DB・ネットワークは使わない
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const calls = [];
let data = {};
let profileError = false;
function fakeSql(strings, ...values) {
  const text = strings.join("?").replace(/\s+/g, " ").trim();
  calls.push({ text, values });
  if (text.includes("FROM sender_profiles")) {
    if (profileError) return Promise.reject(new Error('relation "sender_profiles" does not exist'));
    return Promise.resolve(data.profile ? [data.profile] : []);
  }
  if (text.includes("FROM companies WHERE project")) return Promise.resolve(data.companies || []);
  if (text.includes("FROM responses r")) return Promise.resolve(data.responses || []);
  if (text.includes("FROM send_logs sl")) return Promise.resolve(data.logs || []);
  if (text.includes("FROM send_queue sq")) return Promise.resolve(data.queue || []);
  if (text.includes("FROM scheduled_sends ss")) return Promise.resolve(data.scheduled || []);
  return Promise.resolve([]);
}
fakeSql.query = async () => [];
const dbPath = require.resolve(path.join(__dirname, "..", "lib", "db"));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { sql: fakeSql, getSettings: async () => ({}), isExcludedDomain: async () => false } };
const handler = require("../api/crm");

function call(method, query) {
  return new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(d) { resolve({ status: this.statusCode, body: d }); return this; } };
    handler({ method, query: { action: "later-list", ...query }, headers: {} }, res);
  });
}

const PROFILE = {
  id: 1, project: "ozukanzukan", person_name: "松崎流空", person_name_kana: "まつざきりゅうと",
  company_name: "株式会社LOCLE", email: "matsuzaki9283@gmail.com", phone: "027-212-2117",
};

function reset(over = {}) {
  calls.length = 0;
  profileError = false;
  data = {
    profile: PROFILE,
    companies: [
      { id: 37, name: "高総建設", url: "https://takasokensetsu.com/", contact_form_url: "https://takasokensetsu.com/contact/", status: "researched", archived: false, action_status: "none", project: "ozukanzukan", automatable: "true", rejection_detected: "false" },
      { id: 52, name: "高商", url: "https://takasho1.jp/", contact_form_url: "https://takasho1.jp/", status: "researched", archived: false, action_status: "none", project: "ozukanzukan", automatable: "true", rejection_detected: "false" },
    ],
    logs: [{ company_id: 37, status: "sent", count: 1, last_sent_at: "2026-10-09T16:42:54Z" }],
    queue: [
      { id: 339, company_id: 52, variant_id: 7, variant_name: "動画付き", variant_project: "ozukanzukan", channel: "form", status: "pending", created_at: "2026-10-05T00:00:00Z", updated_at: null, error_message: null },
      { id: 347, company_id: 37, variant_id: 7, variant_name: "動画付き", variant_project: "ozukanzukan", channel: "form", status: "dismissed", created_at: "2026-10-05T00:00:00Z", updated_at: "2026-10-10T00:00:00Z", error_message: "[2026-10-10停止] 送信記録ありの企業のため停止(元pending)" },
    ],
    scheduled: [
      { id: 1, company_id: 37, variant_id: 7, variant_name: "動画付き", variant_project: "ozukanzukan", channel: "form", status: "cancelled", scheduled_at: "2026-09-01T00:00:00Z", created_at: "2026-08-19T00:00:00Z", error_message: "[2026-10-10停止] 期限切れ予約のため停止(元pending)" },
    ],
    ...over,
  };
}

test("状態別に振り分けた一覧と件数を返す", async () => {
  reset();
  const r = await call("GET", { project: "ozukanzukan" });
  assert.equal(r.status, 200);
  assert.equal(r.body.project, "ozukanzukan");
  assert.equal(r.body.sender_profile_valid, true);
  assert.deepEqual(r.body.counts, { unsent: 0, email_followup: 0, scheduled: 0, overdue: 0, queued: 1, on_hold: 0, stopped: 2, total: 3, email_followup_ready: 0, with_warnings: 2 });
  const keys = Object.fromEntries(r.body.items.map((it) => [it.key, it]));
  assert.equal(keys["queue-339"].state, "queued");
  assert.equal(keys["queue-347"].state, "stopped");
  assert.equal(keys["scheduled-1"].state, "stopped");
  assert.match(keys["scheduled-1"].error_message, /^\[2026-10-10停止\]/);
  assert.equal(keys["queue-339"].company_name, "高商");
});

test("読み取り専用: 書き換えるSQL(INSERT/UPDATE/DELETE)を一切実行しない", async () => {
  reset();
  await call("GET", { project: "ozukanzukan" });
  assert.ok(calls.length >= 5);
  for (const c of calls) assert.doesNotMatch(c.text, /^(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/i, c.text);
  // プロジェクトで絞り込んでいる
  for (const c of calls) assert.ok(c.values.includes("ozukanzukan"), c.text);
});

test("GET以外は405でDBに触れない", async () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    reset();
    const r = await call(method, { project: "ozukanzukan" });
    assert.equal(r.status, 405, method);
    assert.equal(calls.length, 0, method);
  }
});

test("projectが無い・不正なら400でDBに触れない", async () => {
  for (const project of [undefined, "", "other"]) {
    reset();
    const r = await call("GET", { project });
    assert.equal(r.status, 400, String(project));
    assert.equal(calls.length, 0);
  }
});

test("送信者プロフィールが未登録・テーブル無しなら sender_profile_valid:false と警告", async () => {
  reset({ profile: null });
  let r = await call("GET", { project: "ozukanzukan" });
  assert.equal(r.body.sender_profile_valid, false);
  const q = r.body.items.find((it) => it.key === "queue-339");
  assert.ok(q.warnings.some((w) => w.code === "no_sender_profile"));

  reset();
  profileError = true;
  r = await call("GET", { project: "ozukanzukan" });
  assert.equal(r.status, 200);
  assert.equal(r.body.sender_profile_valid, false);
});

test("メール後のフォーム: チャネル別の集計と反応を使って、メール済み・フォーム未送信の企業を出す", async () => {
  reset({
    companies: [
      { id: 307, name: "三晃メンテクス", url: "http://www.sankomentex.com/", contact_form_url: "http://www.sankomentex.com/", email: "info@sanko-mtx.co.jp", status: "researched", archived: false, action_status: "none", project: "ozukanzukan", automatable: "true", rejection_detected: "false" },
      { id: 1722, name: "Joetsu Company", url: "https://www.joetsu-p.co.jp/", contact_form_url: "https://www.joetsu-p.co.jp/", email: "x@joetsu-p.co.jp", status: "researched", archived: false, action_status: "none", project: "ozukanzukan", automatable: "true", rejection_detected: "false" },
    ],
    logs: [
      { company_id: 307, channel: "email", status: "sent", count: 1, last_sent_at: "2026-09-05T00:00:00Z", variant_ids: [7] },
      { company_id: 1722, channel: "email", status: "sent", count: 1, last_sent_at: "2026-09-21T04:32:57Z", variant_ids: [8] },
    ],
    responses: [
      { company_id: 1722, classification: "interested", raw_excerpt: "リンククリックによる自動記録", message_id: null, received_at: "2026-09-21T04:33:02Z", sent_at: "2026-09-21T04:32:57Z" },
    ],
    queue: [],
    scheduled: [],
  });
  const r = await call("GET", { project: "ozukanzukan" });
  assert.equal(r.status, 200);
  const k = Object.fromEntries(r.body.items.map((it) => [it.key, it]));
  assert.equal(k["followup-307"].state, "email_followup");
  assert.equal(k["followup-307"].followup.status, "ready");
  assert.equal(k["followup-1722"].followup.status, "ready", "自動クリックだけなので除外しない");
  assert.ok(k["followup-1722"].warnings.some((w) => w.code === "auto_click" && /5秒後/.test(w.message)));
  assert.equal(r.body.counts.email_followup, 2);
  // 集計クエリはチャネル別、反応も読む
  assert.ok(calls.some((c) => /GROUP BY sl.company_id, sl.channel, sl.status/.test(c.text)));
  assert.ok(calls.some((c) => /FROM responses r/.test(c.text)));
});
