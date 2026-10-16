// 「あとで送る」の3区分(送れる / 要確認 / 送れない)と、自動で送信待ちに入れられる候補の印
// (lib/later-status.js)、「送れる」企業をまとめて送信待ちに入れるときの確認(lib/later-actions.js)のテスト。
// DB・ブラウザ・外部APIは使わない
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildLaterList, categorize, phoneDigits, readyToSendProblems } = require("../lib/later-status");
const { checkReadyAdd, checkQueueStatusChange } = require("../lib/later-actions");
const { AUTO_CLICK_EXCERPT } = require("../lib/response-kind");

const NOW = Date.parse("2026-10-16T09:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

// 候補の条件をすべて満たす企業
function company(id, over = {}) {
  return {
    id, name: `株式会社テスト${id}`, official_name: null, url: `https://test${id}.co.jp/`,
    contact_form_url: `https://test${id}.co.jp/contact/`, email: `info@test${id}.co.jp`,
    status: "researched", archived: false, action_status: "none", project: "ozukanzukan",
    automatable: "true", rejection_detected: "false", mapping_source: "ai", ai_error: null, appeal_error: null,
    captcha_detected: "false", needs_review: [], image_auth_fields: [], phone_number: "027-123-4567",
    updated_at: new Date(NOW - 2 * DAY).toISOString(), ...over,
  };
}

function build({ companies, logs = [], queue = [], scheduled = [], responses = [], senderProfileValid = true, lastFailures = [] }) {
  return buildLaterList({ companies, sendLogSummary: logs, responses, queueRows: queue, scheduledRows: scheduled, senderProfileValid, lastFailures, now: NOW });
}
const byCompany = (r, id) => r.items.find((it) => it.company_id === id);
const qrow = (id, companyId, status, over = {}) => ({
  id, company_id: companyId, variant_id: 7, variant_name: "動画付き", variant_project: "ozukanzukan", channel: "form",
  status, created_at: "2026-10-15T00:00:00Z", updated_at: null, error_message: null, ...over,
});

test("警告のない未送信・保留の企業は「送れる」", () => {
  const r = build({ companies: [company(1), company(2)], queue: [qrow(10, 2, "on_hold")] });
  assert.equal(byCompany(r, 1).category, "ready");
  assert.equal(byCompany(r, 2).state, "on_hold");
  assert.equal(byCompany(r, 2).category, "ready");
  assert.equal(r.counts.ready, 2);
});

test("送信待ち・予約済みは区分の外(active)", () => {
  const r = build({
    companies: [company(1), company(2)],
    queue: [qrow(10, 1, "pending")],
    scheduled: [{ id: 5, company_id: 2, variant_id: 7, variant_name: "x", variant_project: "ozukanzukan", channel: "form", status: "pending", scheduled_at: new Date(NOW + DAY).toISOString(), created_at: "2026-10-01T00:00:00Z" }],
  });
  assert.equal(byCompany(r, 1).category, "active");
  assert.equal(byCompany(r, 2).category, "active");
  assert.equal(r.counts.active, 2);
  assert.equal(r.counts.ready, 0);
});

test("要確認: 宛名が不確か・ドメイン違い・仮のメール・過去の失敗・メール後のフォーム・期限切れ", () => {
  const r = build({
    companies: [
      company(1, { name: "株式会社へ" }),
      company(2, { contact_form_url: "https://portal-site.jp/form?id=2" }),
      company(3, { email: "info@example.com" }),
      company(4),
      company(5),
      company(6),
    ],
    logs: [
      { company_id: 4, channel: "form", status: "failed", count: 1 },
      { company_id: 5, channel: "email", status: "sent", count: 1, last_sent_at: new Date(NOW - 20 * DAY).toISOString(), variant_ids: [3] },
    ],
    scheduled: [{ id: 9, company_id: 6, variant_id: 7, variant_name: "x", variant_project: "ozukanzukan", channel: "form", status: "pending", scheduled_at: new Date(NOW - DAY).toISOString(), created_at: "2026-10-01T00:00:00Z" }],
  });
  for (const id of [1, 2, 3, 4, 5, 6]) assert.equal(byCompany(r, id).category, "review", `企業${id}`);
  assert.match(byCompany(r, 1).category_reasons.join(" "), /宛名/);
  assert.match(byCompany(r, 2).category_reasons.join(" "), /別のドメイン/);
  assert.match(byCompany(r, 3).category_reasons.join(" "), /仮/);
  assert.match(byCompany(r, 4).category_reasons.join(" "), /失敗1回/);
  assert.match(byCompany(r, 5).category_reasons.join(" "), /メール送信済み/);
  assert.match(byCompany(r, 6).category_reasons.join(" "), /予約日時を過ぎて/);
});

test("送れない: 停止中・送信記録あり・人の反応・送信者プロフィールなし・メールから14日未満", () => {
  const r = build({
    companies: [company(1), company(2), company(3), company(4), company(5)],
    queue: [
      qrow(11, 1, "dismissed"),
      qrow(12, 2, "on_hold"),
      qrow(13, 3, "on_hold"),
      qrow(14, 4, "on_hold"),
      qrow(15, 5, "on_hold"),
    ],
    logs: [
      { company_id: 2, channel: "form", status: "uncertain", count: 1 },
      { company_id: 3, channel: "email", status: "sent", count: 1, last_sent_at: new Date(NOW - 30 * DAY).toISOString(), variant_ids: [3] },
      { company_id: 5, channel: "email", status: "sent", count: 1, last_sent_at: new Date(NOW - 3 * DAY).toISOString(), variant_ids: [3] },
    ],
    responses: [{ company_id: 3, classification: "interested", raw_excerpt: "詳しく聞きたい", message_id: "m1", received_at: new Date(NOW - 20 * DAY).toISOString(), sent_at: new Date(NOW - 30 * DAY).toISOString() }],
  });
  const it = (id) => r.items.find((x) => x.company_id === id && x.source === "queue");
  assert.equal(it(1).category, "blocked");
  assert.deepEqual(it(1).category_reasons, ["停止中"]);
  assert.equal(it(2).category, "blocked");
  assert.match(it(2).category_reasons.join(" "), /送信記録あり/);
  assert.equal(it(3).category, "blocked");
  assert.match(it(3).category_reasons.join(" "), /人からの反応/);
  assert.equal(it(5).category, "blocked");
  assert.match(it(5).category_reasons.join(" "), /14日/);
  // 送信者プロフィールが無ければ、警告の無い保留の行も送れない
  const noProfile = build({ companies: [company(4)], queue: [qrow(14, 4, "on_hold")], senderProfileValid: false });
  assert.equal(byCompany(noProfile, 4).category, "blocked");
});

test("情報の警告のうち、リンクの自動クリックだけなら「送れる」のまま", () => {
  const it = { state: "unsent", warnings: [{ code: "auto_click", level: "info", message: "x" }] };
  assert.equal(categorize(it).category, "ready");
  assert.equal(categorize({ state: "unsent", warnings: [{ code: "previously_stopped", level: "info", message: "y" }] }).category, "review");
});

test("候補: 条件をすべて満たせば ★候補", () => {
  const r = build({ companies: [company(1), company(2, { phone_number: "＋81 27-123-4567" })] });
  assert.deepEqual(byCompany(r, 1).auto_candidate, { ok: true, reasons: [] });
  assert.equal(byCompany(r, 2).auto_candidate.ok, true, "全角・国番号つきの電話番号");
  assert.equal(r.counts.auto_candidate, 2);
});

test("候補: 条件を1つでも外れれば印を付けず、理由を返す", () => {
  const cases = [
    [{ captcha_detected: "true" }, /CAPTCHA/],
    [{ image_auth_fields: ["認証コード"] }, /CAPTCHA/],
    [{ needs_review: ["お名前"] }, /要確認の欄/],
    [{ mapping_source: "heuristic" }, /AI由来ではない/],
    [{ ai_error: "status 529" }, /AIのエラー/],
    [{ appeal_error: "parse" }, /AIのエラー/],
    [{ phone_number: null }, /電話番号がなく/],
    [{ phone_number: "03-1234-5678" }, /群馬県の市外局番ではない/],
    [{ phone_number: "0120-123-456" }, /群馬県の市外局番ではない/],
    [{ updated_at: new Date(NOW - 31 * DAY).toISOString() }, /30日を超えて/],
    [{ updated_at: null }, /更新日が分からない/],
  ];
  for (const [over, re] of cases) {
    const r = build({ companies: [company(1, over)] });
    const it = byCompany(r, 1);
    assert.equal(it.category, "ready", JSON.stringify(over));
    assert.equal(it.auto_candidate.ok, false, JSON.stringify(over));
    assert.match(it.auto_candidate.reasons.join(" "), re, JSON.stringify(over));
  }
});

test("候補: 「送れる」以外の行には印を付けない(null)", () => {
  const r = build({ companies: [company(1, { name: "株式会社へ" })] });
  assert.equal(byCompany(r, 1).category, "review");
  assert.equal(byCompany(r, 1).auto_candidate, null);
});

test("候補: 情報の警告(リンクの自動クリック)があれば候補にしない", () => {
  const r = build({
    companies: [company(1)], queue: [qrow(10, 1, "on_hold")],
    responses: [{ company_id: 1, classification: null, raw_excerpt: AUTO_CLICK_EXCERPT, message_id: null, received_at: new Date(NOW).toISOString(), sent_at: new Date(NOW).toISOString() }],
  });
  const it = byCompany(r, 1);
  assert.equal(it.category, "ready");
  assert.equal(it.auto_candidate.ok, false);
  assert.match(it.auto_candidate.reasons.join(" "), /警告あり/);
});

test("電話番号の数字だけを取り出す", () => {
  assert.equal(phoneDigits("027-212-2117"), "0272122117");
  assert.equal(phoneDigits("TEL：０２７０（２２）１２３４"), "0270221234");
  assert.equal(phoneDigits("+81-27-212-2117"), "0272122117");
  assert.equal(phoneDigits(null), "");
});

test("送れる条件の確認(サーバー側)", () => {
  assert.deepEqual(readyToSendProblems(company(1), { failed: 0, stopped: 0 }), []);
  assert.match(readyToSendProblems(company(1, { contact_form_url: "https://portal.jp/f" }), { failed: 0, stopped: 0 }).join(), /別のドメイン/);
  assert.match(readyToSendProblems(company(1, { email: "xxx@example.com" }), { failed: 0, stopped: 0 }).join(), /仮/);
  assert.match(readyToSendProblems(company(1), { failed: 2, stopped: 0 }).join(), /失敗2回/);
  assert.match(readyToSendProblems(company(1), { failed: 0, stopped: 1 }).join(), /停止/);
});

const VARIANT = { id: 7, name: "動画付き", project: "ozukanzukan" };
const EMPTY = { form: { sent: 0, uncertain: 0 }, email: { sent: 0, uncertain: 0, last_at: null, variant_ids: [] }, responses: { human: [], auto_clicks: [] } };
const ready = (over = {}) => checkReadyAdd({
  company: company(1), project: "ozukanzukan", variant: VARIANT, records: EMPTY, activeRows: [],
  history: { failed: 0, stopped: 0 }, now: NOW, ...over,
});

test("まとめて送信待ちへ: 送れる企業は通る", () => {
  assert.deepEqual(ready(), { ok: true });
});

test("まとめて送信待ちへ: 送れない企業は断る", () => {
  assert.equal(ready({ company: company(1, { name: "株式会社へ" }) }).type, "greeting_uncertain");
  assert.equal(ready({ company: company(1, { contact_form_url: "https://portal.jp/f" }) }).type, "not_ready");
  assert.equal(ready({ company: company(1, { email: "a@example.com" }) }).type, "not_ready");
  assert.equal(ready({ history: { failed: 1, stopped: 0 } }).type, "not_ready");
  assert.equal(ready({ history: { failed: 0, stopped: 1 } }).type, "not_ready");
  assert.equal(ready({ records: { ...EMPTY, form: { sent: 0, uncertain: 1 } } }).type, "has_record");
  assert.equal(ready({ activeRows: [{ id: 3, variant_id: 7, status: "on_hold" }] }).type, "already_queued");
  assert.equal(ready({ company: company(1, { automatable: "false" }) }).type, "ineligible");
  const emailed = { ...EMPTY, email: { sent: 1, uncertain: 0, last_at: new Date(NOW - 30 * DAY).toISOString(), variant_ids: [3] } };
  assert.equal(ready({ records: emailed }).type, "email_sent");
  assert.equal(ready({ variant: { id: 8, name: "x", project: "locle" } }).ok, false);
});

test("保留からの再開: 宛名が不確かなら断る", () => {
  const args = (c) => ({
    row: { id: 1, status: "on_hold", variant_id: 7, project: "ozukanzukan" }, nextStatus: "pending",
    company: c, records: EMPTY, confirmHasRecord: false, otherActiveRows: [], now: NOW,
  });
  assert.equal(checkQueueStatusChange(args(company(1))).ok, true);
  const r = checkQueueStatusChange(args(company(1, { name: "株式会社へ", official_name: "株式会社" })));
  assert.equal(r.ok, false);
  assert.equal(r.type, "greeting_uncertain");
  // 登録名が使えなくても正式名称が使えれば再開できる
  assert.equal(checkQueueStatusChange(args(company(1, { name: "株式会社へ", official_name: "株式会社テスト" }))).ok, true);
});

test("区分の理由の種類(category_codes)を返す(画面の「理由で絞り込み」に使う)", () => {
  const r = build({ companies: [company(1, { name: "株式会社へ" }), company(2)], queue: [qrow(10, 2, "dismissed")] });
  assert.deepEqual(byCompany(r, 1).category_codes, ["greeting_uncertain"]);
  const stoppedRow = r.items.find((x) => x.key === "queue-10");
  assert.deepEqual(stoppedRow.category_codes, ["stopped"]);
  const unsent2 = r.items.find((x) => x.key === "company-2");
  assert.deepEqual(unsent2.category_codes, ["previously_stopped"]);
  assert.deepEqual(categorize({ state: "unsent", warnings: [] }).category_codes, []);
});
