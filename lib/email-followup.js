// lib/email-followup.js
//
// メール送信済み・フォーム未送信の企業に、フォームでも送ってよいかの判定(「あとで送る」画面の表示・
// 保留への追加・再開と、api/crm.js の queueCompanyForSend で共通に使う)。
// 決まり: メール送信から14日以上空ける / 人からの反応(返信・手動の記録)があれば送らない(辞退は必ず) /
// メールと同じバリアント(同じ本文)では送らない。リンククリックの自動記録は人の反応として扱わない。
//
// 送信記録(records)の形(api/crm.js の loadSendRecords と lib/later-status.js が作る):
//   { form:  { sent, uncertain },
//     email: { sent, uncertain, last_at, variant_ids },
//     responses: { human: [{ classification, received_at }], auto_clicks: [{ received_at, seconds_after_send }] } }

// メール送信の後にフォームで送るまでに空ける日数
const EMAIL_FOLLOWUP_WAIT_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

const fail = (status, error, type, extra) => ({ ok: false, status, error, ...(type ? { type } : {}), ...(extra || {}) });

const count = (r) => (r ? (Number(r.sent) || 0) + (Number(r.uncertain) || 0) : 0);
const hasFormRecord = (records) => count(records && records.form) > 0;
const hasEmailRecord = (records) => count(records && records.email) > 0;
const humanResponses = (records) => (records && records.responses && records.responses.human) || [];

const CLASSIFICATION_LABELS = { interested: "興味あり", declined: "辞退", question: "質問", other: "その他" };

// メール送信からの経過日数(切り捨て)
function daysSinceEmail(records, now) {
  const last = records && records.email && records.email.last_at;
  if (!last) return null;
  return Math.floor((now - new Date(last).getTime()) / DAY_MS);
}

// メール送信済み・フォーム未送信の企業に、フォームで送ってよいか(保留への追加・再開・送信待ちに積む処理で共通)。
//   variantId を渡すと、メールと同じバリアントでないかも確かめる(同じ本文を送らないため)
function checkEmailFollowup({ records, variantId, now }) {
  const human = humanResponses(records);
  if (human.length > 0) {
    const declined = human.some((r) => r.classification === "declined");
    const kinds = [...new Set(human.map((r) => CLASSIFICATION_LABELS[r.classification] || r.classification || "分類なし"))];
    return fail(409, declined
      ? "この企業からは辞退の反応が記録されています。フォームでは送れません"
      : `この企業からは反応(${kinds.join("・")})が記録されています。フォームでは送れません`, "has_response");
  }
  const days = daysSinceEmail(records, now);
  if (days !== null && days < EMAIL_FOLLOWUP_WAIT_DAYS) {
    const left = EMAIL_FOLLOWUP_WAIT_DAYS - days;
    return fail(409, `メール送信から${days}日しか経っていません(${EMAIL_FOLLOWUP_WAIT_DAYS}日空ける決まりのため、あと${left}日)`,
      "email_too_recent", { days_left: left });
  }
  const emailVariants = (records && records.email && records.email.variant_ids) || [];
  if (variantId !== undefined && variantId !== null && emailVariants.some((v) => Number(v) === Number(variantId))) {
    return fail(400, "メールと同じバリアントです。フォームでは別の文面(フォローアップ用)を選んでください", "same_variant_as_email");
  }
  return { ok: true };
}

// 画面の表示用: メール送信済み・フォーム未送信の企業の区分
//   ready = 保留に追加できる / waiting = メールから14日未満 / excluded = 人からの反応あり
function emailFollowupStatus(records, now) {
  const days = daysSinceEmail(records, now);
  const check = checkEmailFollowup({ records, now });
  if (check.ok) return { status: "ready", days_since_email: days, days_left: 0, reason: null };
  if (check.type === "email_too_recent") return { status: "waiting", days_since_email: days, days_left: check.days_left, reason: check.error };
  return { status: "excluded", days_since_email: days, days_left: 0, reason: check.error };
}

module.exports = {
  EMAIL_FOLLOWUP_WAIT_DAYS, fail, hasFormRecord, hasEmailRecord, humanResponses, daysSinceEmail,
  checkEmailFollowup, emailFollowupStatus, CLASSIFICATION_LABELS,
};
