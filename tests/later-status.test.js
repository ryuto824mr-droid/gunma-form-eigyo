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
  assert.deepEqual(r.counts, { unsent: 2, email_followup: 0, scheduled: 1, overdue: 1, queued: 1, on_hold: 1, stopped: 1, total: 7, email_followup_ready: 0, with_warnings: 1 });
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

test("未送信の一覧にアーカイブ済みの企業は混ざらない(送信記録なし・停止中の行だけの企業でも)", () => {
  const r = build({
    companies: [
      company(1),
      company(2, { archived: true }),                          // 送信記録も行もない
      company(3, { archived: true }),                          // 停止中の行だけ
      company(4, { archived: true, automatable: "true" }),     // 失敗の記録だけ
    ],
    sendLogSummary: [{ company_id: 4, status: "failed", count: 2, last_sent_at: PAST }],
    queueRows: [queue(10, 3, "dismissed")],
    scheduledRows: [sched(11, 3, "cancelled", PAST)],
  });
  const unsent = r.items.filter((it) => it.state === "unsent").map((it) => it.company_id);
  assert.deepEqual(unsent, [1]);
  // アーカイブ済み企業の停止中の行は、停止中としては見える
  assert.deepEqual(r.items.filter((it) => it.company_id === 3).map((it) => it.state), ["stopped", "stopped"]);
});

test("選別の目安: 「公式ホームページ」付きの実在企業は企業サイトではない疑いにしない", () => {
  const { selectionHint } = require("../lib/later-status");
  const hint = (name, url, failed = 0, dismissed = false, last = "") => selectionHint({ name, url }, failed, dismissed, last).code;
  assert.equal(hint("株式会社グンエイ（公式ホームページ）", "https://www.gunei-web.co.jp/", 3), "failed_3plus");
  assert.equal(hint("株式会社ダイアキ（公式ホームページ）", "https://www.daiaki.com/", 3), "failed_3plus");
  assert.equal(hint("前橋青果株式会社（公式ホームページ）", "https://maebashiseika.com/", 1), "failed_1_2");
  assert.equal(hint("〇〇工業 公式サイト", "https://example.co.jp/"), "no_failure");
  // 自治体・ポータル・団体・海外法人は「企業サイトではない疑い」
  assert.equal(hint("館林市公式ホームページ", "https://warp.da.ndl.go.jp/"), "not_company");
  assert.equal(hint("市内製造業企業ガイド | 羽村市公式サイト", "https://www.city.hamura.tokyo.jp/"), "not_company");
  assert.equal(hint("Maebashi City Hall", "https://www.city.maebashi.gunma.jp/"), "not_company");
  assert.equal(hint("藤岡市（群馬県）のリフォーム会社情報【SUUMO】", "https://suumo.jp/"), "not_company");
  assert.equal(hint("Rio Bravo", "https://www.hotpepper.jp/x/"), "not_company");
  assert.equal(hint("東毛漁業協同組合", "https://www.tohmohgyokyo.com/"), "not_company");
  assert.equal(hint("Yaskawa America, Inc", "https://www.yaskawa.co.jp/"), "not_company");
  assert.equal(hint("All Market Japan Co., Ltd.", "https://www.allmarketjapan.com/", 5), "failed_3plus", "Co., Ltd. は海外法人扱いしない");
  // 支店・工場、却下済み、送信できたか不明、上限で止まっただけ
  assert.equal(hint("日本ケロッグ 高崎工場", "https://www.kelloggs.jp/", 1, false, "本日の送信上限(100件)に達しました"), "branch");
  assert.equal(hint("株式会社秋山建設", "https://akiyamakensetu.com/", 8, true), "dismissed_before");
  assert.equal(hint("System", "https://system-tsd.co.jp/", 1, false, "送信中に強制終了され、実際に送信できたかは不明です"), "maybe_sent");
  assert.equal(hint("杜丸不動産", "https://www.morimaru.jp/", 1, false, "本日の送信上限(100件)に達しました"), "limit_only");
  assert.equal(hint("杜丸不動産", "https://www.morimaru.jp/", 3, false, "本日の送信上限(100件)に達しました"), "failed_3plus", "上限でも3回以上失敗していれば失敗3回以上");
});

test("直近の失敗理由を参考情報として付け、未送信の行に選別の目安を付ける", () => {
  const r = build({
    companies: [company(292), company(1)],
    sendLogSummary: [{ company_id: 292, status: "failed", count: 1, last_sent_at: PAST }],
    lastFailures: [{ company_id: 292, error_message: "本日の送信上限(100件)に達しました", updated_at: PAST }],
  });
  const k = byKey(r);
  assert.ok(k["company-292"].warnings.some((w) => w.code === "last_failure" && w.level === "info" && /送信上限/.test(w.message)));
  assert.deepEqual(k["company-292"].selection_hint, { code: "limit_only", label: "送信上限で止まっただけ(有力)" });
  assert.deepEqual(k["company-1"].selection_hint, { code: "no_failure", label: "失敗なし" });
});

// ---- 「メール後のフォーム」(A) ----
const followupCompanies = () => [
  company(307, { url: "http://www.sankomentex.com/", contact_form_url: "http://www.sankomentex.com/" }),
  company(38, { url: "https://wabika.com/", contact_form_url: "https://wabika.com/consultation" }),
  company(142, { url: "https://japoncompany.business/shibukawa/548181-", contact_form_url: "https://towheree.com/contact" }),
  company(500),   // メールから9日
  company(501),   // 人からの反応あり
  company(502),   // リンククリックの自動記録だけ
];
const emailLog = (company_id, days, variant = 7) => ({
  company_id, channel: "email", status: "sent", count: 1,
  last_sent_at: new Date(NOW - days * 86400000).toISOString(), variant_ids: [variant],
});

test("メール後のフォーム: メール済み・フォーム未送信の企業を区分付きで出す(対象・待機中・除外)", () => {
  const r = build({
    companies: followupCompanies(),
    sendLogSummary: [emailLog(307, 35), emailLog(38, 54), emailLog(142, 52), emailLog(500, 9), emailLog(501, 30), emailLog(502, 20)],
    responses: [
      { company_id: 501, classification: "declined", raw_excerpt: "今回は見送ります", message_id: "<m1>", received_at: PAST, sent_at: PAST },
      { company_id: 502, classification: "interested", raw_excerpt: "リンククリックによる自動記録", message_id: null,
        received_at: new Date(NOW - 20 * 86400000 + 93000).toISOString(), sent_at: new Date(NOW - 20 * 86400000).toISOString() },
    ],
  });
  const k = byKey(r);
  assert.deepEqual(r.items.filter((it) => it.state === "email_followup").map((it) => it.company_id).sort((a, b) => a - b), [38, 142, 307, 500, 501, 502]);
  assert.equal(r.items.filter((it) => it.state === "unsent").length, 0, "メール済みの企業は未送信には出ない");
  assert.equal(k["followup-307"].followup.status, "ready");
  assert.equal(k["followup-307"].followup.days_since_email, 35);
  assert.deepEqual([k["followup-500"].followup.status, k["followup-500"].followup.days_left], ["waiting", 5]);
  assert.equal(k["followup-501"].followup.status, "excluded");
  assert.match(k["followup-501"].followup.reason, /辞退/);
  assert.equal(k["followup-502"].followup.status, "ready", "自動クリックだけなら除外しない");
  assert.equal(r.counts.email_followup, 6);
  assert.equal(r.counts.email_followup_ready, 4);
});

test("メール後のフォーム: フォームのドメイン違い(掲載サイトのフォーム)を警告する(142)", () => {
  const r = build({ companies: followupCompanies(), sendLogSummary: [emailLog(307, 35), emailLog(38, 54), emailLog(142, 52)] });
  const k = byKey(r);
  const w142 = k["followup-142"].warnings.find((w) => w.code === "form_domain_mismatch");
  assert.equal(w142.level, "danger");
  assert.match(w142.message, /towheree\.com/);
  assert.ok(!k["followup-307"].warnings.some((w) => w.code === "form_domain_mismatch"), "同じドメイン");
  assert.ok(!k["followup-38"].warnings.some((w) => w.code === "form_domain_mismatch"), "wabika.com と wabika.com/consultation");
  // 区分は対象のまま(警告のみで止めない)
  assert.equal(k["followup-142"].followup.status, "ready");
});

test("反応の区別: 人の反応は警告、リンククリックの自動記録は参考情報(送信直後は自動確認の可能性を添える)", () => {
  const r = build({
    companies: followupCompanies(),
    sendLogSummary: [emailLog(501, 30), emailLog(502, 20)],
    responses: [
      { company_id: 501, classification: "question", raw_excerpt: "詳しく教えてください", message_id: null, received_at: PAST, sent_at: PAST },
      { company_id: 502, classification: "interested", raw_excerpt: "リンククリックによる自動記録", message_id: null,
        received_at: "2026-09-21T04:31:36Z", sent_at: "2026-09-21T04:30:03Z" },
    ],
  });
  const k = byKey(r);
  const human = k["followup-501"].warnings.find((w) => w.code === "human_response");
  assert.deepEqual([human.level, human.message], ["warn", "人からの反応あり(質問)"]);
  const auto = k["followup-502"].warnings.find((w) => w.code === "auto_click");
  assert.equal(auto.level, "info");
  assert.match(auto.message, /送信から93秒後/);
  assert.match(auto.message, /自動確認の可能性/);
  assert.ok(!k["followup-502"].warnings.some((w) => w.code === "human_response"));
});

test("メール送信済みの企業へのフォームの送信待ちは、14日未満なら赤い警告", () => {
  const r = build({
    companies: [company(600), company(601)],
    sendLogSummary: [emailLog(600, 5), emailLog(601, 30)],
    queueRows: [queue(1, 600, "on_hold"), queue(2, 601, "on_hold")],
  });
  const k = byKey(r);
  const w600 = k["queue-1"].warnings.find((w) => w.code === "email_sent");
  assert.equal(w600.level, "danger");
  assert.match(w600.message, /5日前.*14日空ける/);
  assert.equal(k["queue-2"].warnings.find((w) => w.code === "email_sent").level, "warn");
});

test("メールで送る予定の行で、登録アドレスが入力例なら警告(送信時に止まる)", () => {
  const r = build({
    companies: [company(700, { email: "sample@gku.co.jp", automatable: "false", status: "no_form" }), company(701, { email: "bandotaro@abc.jp" })],
    queueRows: [queue(1, 700, "pending", { channel: "email" }), queue(2, 701, "pending", { channel: "email" })],
  });
  const k = byKey(r);
  assert.ok(k["queue-1"].warnings.some((w) => w.code === "placeholder_email" && w.level === "danger"));
  assert.ok(!k["queue-2"].warnings.some((w) => w.code === "placeholder_email"), "abc.jp は判定から除外");
});

test("選別の目安: 「〇選【」形式のまとめ記事は企業サイトではない疑い(1716)", () => {
  const { selectionHint } = require("../lib/later-status");
  const hint = (name) => selectionHint({ name, url: "https://imitsu.jp/list/web-system/gumma/" }, 0, false, "").code;
  assert.equal(hint("群馬県のおすすめシステム開発会社12選【2024年最新版】｜PRONIアイミツ"), "not_company");
  assert.equal(hint("製造業のホームページ参考事例14選！作成のポイント"), "no_failure", "「選！」は対象外(他の語で判定)");
  assert.equal(hint("おすすめ業者３選【群馬】"), "not_company", "全角数字");
  assert.equal(hint("株式会社選抜工業"), "no_failure", "数字が無い「選」は対象外");
});
