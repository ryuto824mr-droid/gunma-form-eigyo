// 「あとで送る」一覧の状態振り分け・警告(lib/later-status.js)のテスト。DB・ネットワークは使わない
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildLaterList, ineligibleReasons } = require("../lib/later-status");

const NOW = Date.parse("2026-10-10T03:00:00Z");
const PAST = "2026-09-01T00:00:00Z";
const FUTURE = "2026-10-20T00:00:00Z";

const company = (id, extra = {}) => ({
  id, name: `会社${id}`, url: `https://example${id}.jp/`, contact_form_url: `https://example${id}.jp/contact/`,
  status: "researched", archived: false, action_status: "none", project: "ozukanzukan",
  automatable: "true", rejection_detected: "false", ...extra,
});
const queue = (id, company_id, status, extra = {}) => ({
  id, company_id, variant_id: 8, variant_name: "動画付き 最新版", variant_project: "ozukanzukan",
  channel: "form", status, created_at: "2026-10-05T00:00:00Z", updated_at: null, error_message: null, ...extra,
});
const sched = (id, company_id, status, scheduled_at, extra = {}) => ({
  id, company_id, variant_id: 7, variant_name: "動画付き", variant_project: "ozukanzukan",
  channel: "form", status, scheduled_at, created_at: "2026-08-19T00:00:00Z", error_message: null, ...extra,
});

function build(over = {}) {
  return buildLaterList({
    companies: [], sendLogSummary: [], queueRows: [], scheduledRows: [],
    senderProfileValid: true, now: NOW, ...over,
  });
}
const byKey = (r) => Object.fromEntries(r.items.map((it) => [it.key, it]));
const codes = (it) => it.warnings.map((w) => w.code).sort();

test("送信待ちリストの状態: pending/sending→キュー待ち、on_hold→保留中、failed/dismissed/skipped→停止中、sentは含めない", () => {
  const r = build({
    companies: [1, 2, 3, 4, 5, 6, 7].map((i) => company(i)),
    queueRows: [
      queue(1, 1, "pending"), queue(2, 2, "sending"), queue(3, 3, "on_hold"),
      queue(4, 4, "failed"), queue(5, 5, "dismissed"), queue(6, 6, "skipped"), queue(7, 7, "sent"),
    ],
  });
  const k = byKey(r);
  assert.equal(k["queue-1"].state, "queued");
  assert.equal(k["queue-2"].state, "queued");
  assert.equal(k["queue-3"].state, "on_hold");
  assert.equal(k["queue-4"].state, "stopped");
  assert.equal(k["queue-5"].state, "stopped");
  assert.equal(k["queue-6"].state, "stopped");
  assert.equal(k["queue-7"], undefined, "送信済みの行は含めない");
});

test("予約の状態: pending未来→予約済み、pending過去→期限切れ、cancelled/failed→停止中、sentは含めない", () => {
  const r = build({
    companies: [1, 2, 3, 4, 5].map((i) => company(i)),
    scheduledRows: [
      sched(1, 1, "pending", FUTURE), sched(2, 2, "pending", PAST),
      sched(3, 3, "cancelled", PAST), sched(4, 4, "failed", PAST), sched(5, 5, "sent", PAST),
    ],
  });
  const k = byKey(r);
  assert.equal(k["scheduled-1"].state, "scheduled");
  assert.equal(k["scheduled-2"].state, "overdue");
  assert.deepEqual(codes(k["scheduled-2"]), ["overdue"]);
  assert.equal(k["scheduled-3"].state, "stopped");
  assert.equal(k["scheduled-4"].state, "stopped");
  assert.equal(k["scheduled-5"], undefined);
});

test("段階0で止めた予約(cancelled)・送信待ち(dismissed)は停止中として、印の文言付きで出る", () => {
  const r = build({
    companies: [company(37), company(2194)],
    sendLogSummary: [{ company_id: 37, status: "sent", count: 1, last_sent_at: "2026-10-09T16:42:54Z" }],
    scheduledRows: [sched(10, 37, "cancelled", PAST, { error_message: "[2026-10-10停止] 期限切れ予約のため停止(元pending)" })],
    queueRows: [
      queue(347, 37, "dismissed", { error_message: "[2026-10-10停止] 送信記録ありの企業のため停止(元pending)" }),
      queue(352, 2194, "dismissed", { error_message: "[2026-10-10停止] 不適切: フォームが検索欄(元pending)" }),
    ],
  });
  const k = byKey(r);
  for (const key of ["scheduled-10", "queue-347", "queue-352"]) {
    assert.equal(k[key].state, "stopped", key);
    assert.match(k[key].error_message, /^\[2026-10-10停止\]/, key);
    assert.equal(k[key].state_label, "停止中");
  }
  // 停止中の行には「送ると二重送信」の強い警告は付けない(送られないため)
  assert.deepEqual(k["queue-347"].warnings.map((w) => [w.code, w.level]), [["has_send_record", "warn"]]);
  assert.equal(r.counts.stopped, 3);
  assert.equal(r.items.filter((it) => it.state === "unsent").length, 1, "2194は未送信(送信記録なし・対象)として別に出る");
});

test("未送信: 対象の企業で、送信記録も、これから送られる行も無いものだけ", () => {
  const r = build({
    companies: [
      company(1),                                   // 未送信
      company(2),                                   // 送信記録あり → 出ない
      company(3),                                   // キュー待ちあり → 未送信には出ない
      company(4, { archived: true }),               // 対象外
      company(5, { action_status: "closed" }),      // 対象外
      company(6, { rejection_detected: "true" }),   // 対象外
      company(7, { automatable: "false" }),         // 対象外
      company(8, { status: "no_form" }),            // 対象外
      company(9),                                   // 停止中の行しかない → 未送信として出る
      company(10),                                  // failedの送信記録だけ → 未送信として出る
    ],
    sendLogSummary: [
      { company_id: 2, status: "uncertain", count: 1, last_sent_at: PAST },
      { company_id: 10, status: "failed", count: 3, last_sent_at: PAST },
    ],
    queueRows: [queue(1, 3, "pending"), queue(2, 9, "failed")],
  });
  const unsent = r.items.filter((it) => it.state === "unsent").map((it) => it.company_id).sort((a, b) => a - b);
  assert.deepEqual(unsent, [1, 9, 10]);
  assert.equal(r.counts.unsent, 3);
});

test("警告: uncertainだけの企業への送信予定は二重送信の危険(danger)、sentありはwarn", () => {
  const r = build({
    companies: [company(1), company(2)],
    sendLogSummary: [
      { company_id: 1, status: "uncertain", count: 2, last_sent_at: PAST },
      { company_id: 2, status: "sent", count: 1, last_sent_at: PAST },
      { company_id: 2, status: "uncertain", count: 1, last_sent_at: PAST },
    ],
    queueRows: [queue(1, 1, "pending"), queue(2, 2, "pending")],
  });
  const k = byKey(r);
  const w1 = k["queue-1"].warnings.find((w) => w.code === "has_send_record");
  assert.equal(w1.level, "danger");
  assert.match(w1.message, /uncertain 2件/);
  assert.match(w1.message, /二重送信/);
  const w2 = k["queue-2"].warnings.find((w) => w.code === "has_send_record");
  assert.equal(w2.level, "warn");
  assert.match(w2.message, /sent 1件・uncertain 1件/);
});

test("警告: 送信対象外・重複・バリアントのプロジェクト違い・送信者プロフィール未登録", () => {
  const r = build({
    companies: [company(1, { archived: true }), company(2), company(3)],
    queueRows: [
      queue(1, 1, "pending"),
      queue(2, 2, "pending"),
      queue(3, 3, "pending", { variant_project: "locle" }),
    ],
    scheduledRows: [sched(1, 2, "pending", FUTURE)],
    senderProfileValid: false,
  });
  const k = byKey(r);
  assert.deepEqual(codes(k["queue-1"]), ["ineligible", "no_sender_profile"]);
  assert.match(k["queue-1"].warnings[0].message, /アーカイブ済み/);
  assert.deepEqual(codes(k["queue-2"]), ["duplicate", "no_sender_profile"]);
  assert.deepEqual(codes(k["scheduled-1"]), ["duplicate", "no_sender_profile"]);
  assert.deepEqual(codes(k["queue-3"]), ["no_sender_profile", "variant_project_mismatch"]);
});

test("停止中の行には、送信対象外・重複・プロフィール未登録の警告を付けない", () => {
  const r = build({
    companies: [company(1, { archived: true })],
    queueRows: [queue(1, 1, "failed"), queue(2, 1, "dismissed")],
    senderProfileValid: false,
  });
  for (const it of r.items) assert.deepEqual(it.warnings, [], it.key);
});

test("並び順は 期限切れ→キュー待ち→保留中→予約済み→未送信→停止中、件数も返す", () => {
  const r = build({
    companies: [1, 2, 3, 4, 5, 6].map((i) => company(i)),
    queueRows: [queue(1, 1, "failed"), queue(2, 2, "on_hold"), queue(3, 3, "pending")],
    scheduledRows: [sched(1, 4, "pending", FUTURE), sched(2, 5, "pending", PAST)],
  });
  assert.deepEqual(r.items.map((it) => it.state), ["overdue", "queued", "on_hold", "scheduled", "unsent", "unsent", "stopped"]);
  assert.deepEqual(r.counts, { unsent: 2, scheduled: 1, overdue: 1, queued: 1, on_hold: 1, stopped: 1, total: 7, with_warnings: 1 });
});

test("企業一覧に無い企業の行も落とさずに出す", () => {
  const r = build({ companies: [], queueRows: [queue(1, 999, "pending")] });
  assert.equal(r.items[0].company_name, "(企業ID 999)");
  assert.deepEqual(codes(r.items[0]), ["ineligible"]);
  assert.deepEqual(ineligibleReasons(undefined), ["企業が見つかりません"]);
});

test("参考情報: 過去の失敗回数と、停止・却下の履歴(停止中の行自身には付けない)。件数の「警告あり」には数えない", () => {
  const r = build({
    companies: [company(35), company(2194)],
    sendLogSummary: [{ company_id: 35, status: "failed", count: 8, last_sent_at: PAST }],
    queueRows: [queue(348, 35, "dismissed"), queue(352, 2194, "dismissed")],
  });
  const k = byKey(r);
  assert.deepEqual(k["company-35"].warnings.map((w) => [w.code, w.level, w.message]), [
    ["past_failures", "info", "過去の送信が失敗8回"],
    ["previously_stopped", "info", "停止・却下・失敗した送信待ち/予約あり(停止中タブ)"],
  ]);
  assert.deepEqual(codes(k["company-2194"]), ["previously_stopped"]);
  assert.deepEqual(k["queue-348"].warnings, []);
  assert.equal(r.counts.with_warnings, 0);
});
