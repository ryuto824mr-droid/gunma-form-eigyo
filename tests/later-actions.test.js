// 「あとで送る」画面の操作の判定(lib/later-actions.js)のテスト。DB・ネットワークは使わない
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  checkQueueVariantChange, checkQueueStatusChange, checkHoldAdd, checkScheduledVariantChange,
} = require("../lib/later-actions");

const company = (extra = {}) => ({
  id: 52, project: "ozukanzukan", status: "researched", archived: false, action_status: "none",
  automatable: "true", rejection_detected: "false", ...extra,
});
const row = (extra = {}) => ({ id: 339, company_id: 52, variant_id: 7, project: "ozukanzukan", status: "pending", ...extra });
const V8 = { id: 8, name: "動画付き 最新版", project: "ozukanzukan" };
// 送信記録(lib/email-followup.js の records)
const NONE = null;
const FORM = { form: { sent: 1, uncertain: 0 }, email: { sent: 0, uncertain: 0, last_at: null, variant_ids: [] }, responses: { human: [], auto_clicks: [] } };
const VL = { id: 1, name: "LOCLE 山田", project: "locle" };

test("バリアント変更: 送信待ち・保留中の行だけ変更できる", () => {
  for (const status of ["pending", "on_hold"]) {
    assert.deepEqual(checkQueueVariantChange({ row: row({ status }), variant: V8, company: company(), otherActiveRows: [] }), { ok: true });
  }
  for (const status of ["sending", "sent", "failed", "dismissed", "skipped"]) {
    const r = checkQueueVariantChange({ row: row({ status }), variant: V8, company: company(), otherActiveRows: [] });
    assert.equal(r.ok, false, status);
    assert.equal(r.status, 409, status);
  }
});

test("バリアント変更: プロジェクト違い・存在しない・同じバリアント・重複は不可", () => {
  let r = checkQueueVariantChange({ row: row(), variant: VL, company: company(), otherActiveRows: [] });
  assert.equal(r.status, 400);
  assert.match(r.error, /プロジェクト/);
  r = checkQueueVariantChange({ row: row(), variant: undefined, company: company(), otherActiveRows: [] });
  assert.equal(r.status, 400);
  r = checkQueueVariantChange({ row: row(), variant: { id: 7, project: "ozukanzukan" }, company: company(), otherActiveRows: [] });
  assert.equal(r.status, 400);
  assert.match(r.error, /同じバリアント/);
  r = checkQueueVariantChange({ row: row(), variant: V8, company: company(), otherActiveRows: [{ id: 400, variant_id: 8, status: "on_hold" }] });
  assert.equal(r.status, 409);
  assert.equal(r.type, "duplicate");
  // 企業のプロジェクトが違う(送信待ちの行とバリアントは一致していても)
  r = checkQueueVariantChange({ row: row(), variant: V8, company: company({ project: "locle" }), otherActiveRows: [] });
  assert.equal(r.status, 400);
  assert.equal(checkQueueVariantChange({ row: null, variant: V8, company: company(), otherActiveRows: [] }).status, 404);
});

test("状態の切り替え: 保留・再開・却下は「あとで送る」の操作として扱う", () => {
  const base = { company: company(), records: NONE, confirmHasRecord: false, otherActiveRows: [] };
  assert.deepEqual(checkQueueStatusChange({ ...base, row: row(), nextStatus: "on_hold" }), { ok: true, kind: "later" });
  assert.deepEqual(checkQueueStatusChange({ ...base, row: row({ status: "on_hold" }), nextStatus: "pending" }), { ok: true, kind: "later" });
  assert.deepEqual(checkQueueStatusChange({ ...base, row: row({ status: "on_hold" }), nextStatus: "dismissed" }), { ok: true, kind: "later" });
  assert.deepEqual(checkQueueStatusChange({ ...base, row: row(), nextStatus: "dismissed" }), { ok: true, kind: "later" });
});

test("状態の切り替え: send.htmlの既存の操作(sent記録・失敗からの再送)は従来どおり通す", () => {
  const base = { company: company(), records: FORM, confirmHasRecord: false, otherActiveRows: [] };
  assert.deepEqual(checkQueueStatusChange({ ...base, row: row(), nextStatus: "sent" }), { ok: true, kind: "legacy" });
  assert.deepEqual(checkQueueStatusChange({ ...base, row: row({ status: "failed" }), nextStatus: "pending" }), { ok: true, kind: "legacy" });
});

test("状態の切り替え: 送信中の行は変えられない", () => {
  const r = checkQueueStatusChange({ row: row({ status: "sending" }), nextStatus: "on_hold", company: company(), records: NONE, otherActiveRows: [] });
  assert.equal(r.status, 409);
});

test("再開: 送信対象外の企業は不可、送信記録がある企業は確認が必要", () => {
  const onHold = row({ status: "on_hold" });
  for (const bad of [{ archived: true }, { action_status: "closed" }, { rejection_detected: "true" }, { automatable: "false" }]) {
    const r = checkQueueStatusChange({ row: onHold, nextStatus: "pending", company: company(bad), records: NONE, otherActiveRows: [] });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal(r.type, "ineligible");
  }
  let r = checkQueueStatusChange({ row: onHold, nextStatus: "pending", company: company(), records: FORM, confirmHasRecord: false, otherActiveRows: [] });
  assert.equal(r.status, 409);
  assert.equal(r.type, "needs_confirm_has_record");
  r = checkQueueStatusChange({ row: onHold, nextStatus: "pending", company: company(), records: FORM, confirmHasRecord: true, otherActiveRows: [] });
  assert.deepEqual(r, { ok: true, kind: "later" });
  // 保留にする・却下するときは送信記録の確認は不要
  assert.equal(checkQueueStatusChange({ row: row(), nextStatus: "on_hold", company: company(), records: FORM, otherActiveRows: [] }).ok, true);
});

test("pendingに戻す操作は、同じ企業の保留中・送信待ちと重ねない(失敗からの再送も同じ)", () => {
  for (const from of ["on_hold", "failed"]) {
    let r = checkQueueStatusChange({ row: row({ status: from }), nextStatus: "pending", company: company(), records: NONE, confirmHasRecord: false,
      otherActiveRows: [{ id: 500, variant_id: 8, status: "on_hold" }] });
    assert.equal(r.status, 409, from);
    assert.equal(r.type, "company_on_hold");
    r = checkQueueStatusChange({ row: row({ status: from }), nextStatus: "pending", company: company(), records: NONE, confirmHasRecord: false,
      otherActiveRows: [{ id: 501, variant_id: 8, status: "pending" }] });
    assert.equal(r.status, 409, from);
    assert.equal(r.type, "duplicate");
  }
});

test("保留への追加: 対象の未送信企業だけ", () => {
  const base = { company: company(), project: "ozukanzukan", variant: V8, records: NONE, activeRows: [] };
  assert.deepEqual(checkHoldAdd(base), { ok: true });
  assert.equal(checkHoldAdd({ ...base, company: null }).status, 404);
  assert.equal(checkHoldAdd({ ...base, project: "locle" }).status, 400);
  assert.equal(checkHoldAdd({ ...base, variant: VL }).status, 400);
  assert.equal(checkHoldAdd({ ...base, company: company({ archived: true }) }).type, "ineligible");
  assert.equal(checkHoldAdd({ ...base, company: company({ status: "no_form" }) }).type, "ineligible");
  assert.equal(checkHoldAdd({ ...base, records: FORM }).type, "has_record");
  assert.equal(checkHoldAdd({ ...base, activeRows: [{ id: 1, variant_id: 4, status: "pending" }] }).type, "already_queued");
  assert.equal(checkHoldAdd({ ...base, activeRows: [{ id: 1, variant_id: 4, status: "on_hold" }] }).type, "already_queued");
});

test("予約のバリアント変更: pendingの予約だけ、プロジェクト一致", () => {
  const r0 = { id: 1, company_id: 52, variant_id: 7, status: "pending" };
  assert.deepEqual(checkScheduledVariantChange({ row: r0, variant: V8, company: company() }), { ok: true });
  for (const status of ["cancelled", "sent", "failed"]) {
    assert.equal(checkScheduledVariantChange({ row: { ...r0, status }, variant: V8, company: company() }).status, 409, status);
  }
  assert.equal(checkScheduledVariantChange({ row: r0, variant: VL, company: company() }).status, 400);
  assert.equal(checkScheduledVariantChange({ row: r0, variant: { id: 7, project: "ozukanzukan" }, company: company() }).status, 400);
  assert.equal(checkScheduledVariantChange({ row: null, variant: V8, company: company() }).status, 404);
});

// ---- メール送信済み・フォーム未送信の企業(lib/email-followup.js) ----
const NOW = Date.parse("2026-10-10T03:00:00Z");
const daysAgo = (d) => new Date(NOW - d * 24 * 60 * 60 * 1000).toISOString();
const emailOnly = ({ days = 20, variants = [7], human = [], autoClicks = [] } = {}) => ({
  form: { sent: 0, uncertain: 0 },
  email: { sent: 1, uncertain: 0, last_at: daysAgo(days), variant_ids: variants },
  responses: { human, auto_clicks: autoClicks },
});

test("メール後のフォーム: 14日以上・反応なし・メールと別のバリアントなら保留に追加できる", () => {
  const base = { company: company(), project: "ozukanzukan", variant: V8, activeRows: [], now: NOW };
  assert.deepEqual(checkHoldAdd({ ...base, records: emailOnly({ days: 14 }) }), { ok: true });
  assert.deepEqual(checkHoldAdd({ ...base, records: emailOnly({ days: 35 }) }), { ok: true });
  let r = checkHoldAdd({ ...base, records: emailOnly({ days: 13 }) });
  assert.equal(r.status, 409);
  assert.equal(r.type, "email_too_recent");
  assert.equal(r.days_left, 1);
  assert.match(r.error, /13日/);
  r = checkHoldAdd({ ...base, records: emailOnly({ days: 30, variants: [8] }) });
  assert.equal(r.status, 400);
  assert.equal(r.type, "same_variant_as_email");
});

test("メール後のフォーム: 人からの反応があれば除外(辞退は必ず)、リンククリックの自動記録だけなら除外しない", () => {
  const base = { company: company(), project: "ozukanzukan", variant: V8, activeRows: [], now: NOW };
  for (const classification of ["interested", "question", "other", "declined"]) {
    const r = checkHoldAdd({ ...base, records: emailOnly({ human: [{ classification, received_at: daysAgo(10) }] }) });
    assert.equal(r.type, "has_response", classification);
  }
  assert.match(checkHoldAdd({ ...base, records: emailOnly({ human: [{ classification: "declined" }] }) }).error, /辞退/);
  const autoOnly = emailOnly({ autoClicks: [{ received_at: daysAgo(20), seconds_after_send: 93 }] });
  assert.deepEqual(checkHoldAdd({ ...base, records: autoOnly }), { ok: true });
  // 自動記録と人の反応の両方があれば除外
  const both = emailOnly({ autoClicks: [{ seconds_after_send: 5 }], human: [{ classification: "interested" }] });
  assert.equal(checkHoldAdd({ ...base, records: both }).type, "has_response");
});

test("メール後のフォーム: フォームの送信記録もある企業は従来どおり追加できない", () => {
  const records = { ...emailOnly(), form: { sent: 0, uncertain: 1 } };
  const r = checkHoldAdd({ company: company(), project: "ozukanzukan", variant: V8, activeRows: [], records, now: NOW });
  assert.equal(r.type, "has_record");
});

test("メール後のフォーム: 再開時に14日・反応・バリアントを確かめ直し、確認ダイアログも必須", () => {
  const onHold = row({ status: "on_hold", variant_id: 8 });
  const base = { row: onHold, nextStatus: "pending", company: company(), otherActiveRows: [], now: NOW };
  // 保留中に返信が来た
  let r = checkQueueStatusChange({ ...base, records: emailOnly({ human: [{ classification: "declined" }] }), confirmHasRecord: true });
  assert.equal(r.type, "has_response");
  // メールから14日未満
  r = checkQueueStatusChange({ ...base, records: emailOnly({ days: 3 }), confirmHasRecord: true });
  assert.equal(r.type, "email_too_recent");
  // 保留中の行がメールと同じバリアント
  r = checkQueueStatusChange({ ...base, row: row({ status: "on_hold", variant_id: 7 }), records: emailOnly(), confirmHasRecord: true });
  assert.equal(r.type, "same_variant_as_email");
  // 条件を満たしても、確認なしでは409(2回目の連絡になる旨)
  r = checkQueueStatusChange({ ...base, records: emailOnly({ days: 20 }) });
  assert.equal(r.type, "needs_confirm_has_record");
  assert.match(r.error, /メールを送信済み.*20日前/);
  assert.deepEqual(checkQueueStatusChange({ ...base, records: emailOnly({ days: 20 }), confirmHasRecord: true }), { ok: true, kind: "later" });
});

test("メール後のフォーム: 保留中の行をメールと同じバリアントに変更できない", () => {
  const r = checkQueueVariantChange({
    row: row({ status: "on_hold", variant_id: 8 }), variant: { id: 7, project: "ozukanzukan" },
    company: company(), otherActiveRows: [], records: emailOnly({ variants: [7] }),
  });
  assert.equal(r.type, "same_variant_as_email");
});

test("区分の表示: 対象・待機中(あとN日)・除外", () => {
  const { emailFollowupStatus } = require("../lib/later-actions");
  assert.deepEqual(emailFollowupStatus(emailOnly({ days: 20 }), NOW), { status: "ready", days_since_email: 20, days_left: 0, reason: null });
  const w = emailFollowupStatus(emailOnly({ days: 9 }), NOW);
  assert.deepEqual([w.status, w.days_since_email, w.days_left], ["waiting", 9, 5]);
  const e = emailFollowupStatus(emailOnly({ human: [{ classification: "question" }] }), NOW);
  assert.equal(e.status, "excluded");
  assert.match(e.reason, /質問/);
});
