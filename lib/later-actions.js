// lib/later-actions.js
//
// 「あとで送る」画面(public/later.html)からの操作(送信待ちリストのバリアント変更・保留・再開・却下、
// 未送信企業の保留追加、予約のバリアント変更)と、送信待ちに積む処理(api/crm.js の queueCompanyForSend)
// を許すかどうかの判定。DBには触れない純粋な関数で、必要な行はapi/crm.js・api/analytics.jsが読み込んで
// 渡す(テストで偽のデータを渡せるようにするため)。
// 戻り値はどれも { ok: true } か { ok: false, status, error, type? }。
//
// 送信記録(records)の形(api/crm.js の loadSendRecords が作る):
//   { form:  { sent, uncertain },                                  フォームの送信記録の件数
//     email: { sent, uncertain, last_at, variant_ids },            メールの送信記録(最後の日時・使ったバリアント)
//     responses: { human: [{ classification, received_at }],      人からの反応(返信・手動の記録)
//                  auto_clicks: [{ received_at, seconds_after_send }] } リンククリックの自動記録

const { ineligibleReasons } = require("./later-status");

// バリアントを変更できる送信待ちリストの状態(送信中・送信済み・失敗・却下の行は変えない)
const QUEUE_EDITABLE_STATUSES = ["pending", "on_hold"];

// 「あとで送る」画面から行う状態の切り替え。これ以外(send.htmlの既存の操作:
// pending→sent、pending→dismissed、failed→pending)は従来どおりの扱いとする
const LATER_TRANSITIONS = {
  pending: ["on_hold", "dismissed"],
  on_hold: ["pending", "dismissed"],
};

const {
  EMAIL_FOLLOWUP_WAIT_DAYS, fail, hasFormRecord, hasEmailRecord, daysSinceEmail,
  checkEmailFollowup, emailFollowupStatus,
} = require("./email-followup");

function checkVariant(variant, project, company) {
  if (!variant) return fail(400, "バリアントが見つかりません");
  if (variant.project !== project) return fail(400, "バリアントのプロジェクトが送信待ち・予約のプロジェクトと違います");
  if (company && company.project !== variant.project) return fail(400, "バリアントのプロジェクトが企業と違います");
  return { ok: true };
}

// 送信待ちリストの行のバリアント変更
//   row: 送信待ちリストの行 / variant: 変更先 / company: 企業 / records: 企業の送信記録
//   otherActiveRows: 同じ企業のほかの行のうち pending・sending・on_hold のもの
function checkQueueVariantChange({ row, variant, company, otherActiveRows, records }) {
  if (!row) return fail(404, "キュー項目が見つかりません");
  if (!QUEUE_EDITABLE_STATUSES.includes(row.status)) {
    return fail(409, `この行は「${row.status}」のため、バリアントを変更できません(変更できるのは送信待ち・保留中の行だけです)`);
  }
  const v = checkVariant(variant, row.project, company);
  if (!v.ok) return v;
  if (Number(variant.id) === Number(row.variant_id)) return fail(400, "今と同じバリアントです");
  if (otherActiveRows.some((r) => Number(r.variant_id) === Number(variant.id))) {
    return fail(409, "同じ企業・同じバリアントの送信待ち(または保留)がすでにあります", "duplicate");
  }
  const emailVariants = (records && records.email && records.email.variant_ids) || [];
  if (hasEmailRecord(records) && emailVariants.some((id) => Number(id) === Number(variant.id))) {
    return fail(400, "メールと同じバリアントです。フォームでは別の文面(フォローアップ用)を選んでください", "same_variant_as_email");
  }
  return { ok: true };
}

// 送信待ちリストの状態の切り替え
//   records: 企業の送信記録 / confirmHasRecord: 画面で確認済みか / now: 現在時刻(ミリ秒)
//   otherActiveRows: 同じ企業のほかの行のうち pending・sending・on_hold のもの
// 戻り値の kind: "later"(この画面の操作として確認した) / "legacy"(send.htmlの既存の操作)
function checkQueueStatusChange({ row, nextStatus, company, records, confirmHasRecord, otherActiveRows, now }) {
  if (!row) return fail(404, "キュー項目が見つかりません");
  if (row.status === "sending") return fail(409, "送信中のため変更できません");

  const later = (LATER_TRANSITIONS[row.status] || []).includes(nextStatus);
  const others = otherActiveRows || [];

  // pendingになる操作(保留からの再開・失敗からの再送)は、同じ企業の保留・送信待ちと重ねない
  // (保留中の企業には、バリアントが違っても新しく送信待ちを作らない方針のため)
  if (nextStatus === "pending") {
    if (others.some((r) => r.status === "on_hold")) {
      return fail(409, "同じ企業の別の行が保留中です。保留中の企業は送信待ちに戻せません", "company_on_hold");
    }
    if (others.some((r) => r.status === "pending" || r.status === "sending")) {
      return fail(409, "同じ企業の送信待ちがすでにあります(二重送信を防ぐため戻せません)", "duplicate");
    }
  }

  if (!later) return { ok: true, kind: "legacy" };

  if (row.status === "on_hold" && nextStatus === "pending") {
    const reasons = ineligibleReasons(company);
    if (reasons.length > 0) return fail(400, `送信対象外のため再開できません(${reasons.join("・")})`, "ineligible");
    if (hasFormRecord(records)) {
      if (!confirmHasRecord) {
        return fail(409, "この企業にはフォームの送信記録(sent/uncertain)があります。再開すると二重送信になる可能性があります", "needs_confirm_has_record");
      }
    } else if (hasEmailRecord(records)) {
      // メール送信済み・フォーム未送信: 保留にしている間に反応が来ていないか、14日経ったかを確かめ直す
      const followup = checkEmailFollowup({ records, variantId: row.variant_id, now });
      if (!followup.ok) return followup;
      if (!confirmHasRecord) {
        const days = daysSinceEmail(records, now);
        return fail(409, `この企業にはメールを送信済みです(${days}日前)。フォームでも送ると2回目の連絡になります`, "needs_confirm_has_record");
      }
    }
  }
  return { ok: true, kind: "later" };
}

// 未送信の企業(またはメール送信済み・フォーム未送信の企業)を保留(on_hold)として送信待ちリストに追加する
//   activeRows: その企業の送信待ちリストの行のうち pending・sending・on_hold のもの
function checkHoldAdd({ company, project, variant, records, activeRows, now }) {
  if (!company) return fail(404, "企業が見つかりません");
  if (company.project !== project) return fail(400, "企業のプロジェクトが違います");
  const v = checkVariant(variant, project, company);
  if (!v.ok) return v;
  const reasons = ineligibleReasons(company);
  if (reasons.length > 0) return fail(400, `送信対象外のため保留に追加できません(${reasons.join("・")})`, "ineligible");
  if (hasFormRecord(records)) return fail(409, "フォームの送信記録(sent/uncertain)がある企業は保留に追加できません", "has_record");
  if (activeRows.length > 0) return fail(409, "この企業はすでに送信待ち・保留に入っています", "already_queued");
  if (hasEmailRecord(records)) {
    const followup = checkEmailFollowup({ records, variantId: variant.id, now });
    if (!followup.ok) return followup;
  }
  return { ok: true };
}

// 予約のバリアント変更(pendingの予約だけ)
function checkScheduledVariantChange({ row, variant, company }) {
  if (!row) return fail(404, "予約が見つかりません");
  if (row.status !== "pending") return fail(409, `この予約は「${row.status}」のため、バリアントを変更できません`);
  if (!company) return fail(404, "企業が見つかりません");
  const v = checkVariant(variant, company.project, company);
  if (!v.ok) return v;
  if (Number(variant.id) === Number(row.variant_id)) return fail(400, "今と同じバリアントです");
  return { ok: true };
}

module.exports = {
  EMAIL_FOLLOWUP_WAIT_DAYS,
  QUEUE_EDITABLE_STATUSES,
  LATER_TRANSITIONS,
  hasFormRecord,
  hasEmailRecord,
  checkEmailFollowup,
  emailFollowupStatus,
  checkQueueVariantChange,
  checkQueueStatusChange,
  checkHoldAdd,
  checkScheduledVariantChange,
};
