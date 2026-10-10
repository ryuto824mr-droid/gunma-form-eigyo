// lib/later-status.js
//
// 「あとで送る」画面(public/later.html)用に、送信待ちリスト(send_queue)・予約(scheduled_sends)・
// 未送信の企業を1つの一覧にまとめ、状態別に振り分けて警告を付ける。DBには触れない純粋な関数で、
// データの取得はapi/crm.js?action=later-listが行う(テストで偽のデータを渡せるようにするため)。
//
// 状態:
//   unsent         未送信   リサーチ済み・自動送信可能・送信記録なしで、送信待ちにも予約にも入っていない企業
//   email_followup メール後のフォーム  メールは送信済み・フォームは未送信で、フォームでも送れる企業
//                  (区分: 対象 / 待機中(メールから14日未満) / 除外(人からの反応あり))
//   scheduled      予約済み 予約がpendingで、日時が未来
//   overdue        期限切れ 予約がpendingで、日時が過去(予約の自動処理は実行時刻の設定と一致した時しか
//                           動かないため、期限切れのまま残ることがある)
//   queued         キュー待ち 送信待ちリストのpending(送信中のsendingも含む)
//   on_hold        保留中   送信待ちリストのon_hold
//   stopped        停止中   送信待ちリストのfailed/dismissed/skipped、予約のcancelled/failed
// 送信済み(送信待ちリスト・予約のsent)は「あとで送る」対象ではないため一覧に含めない。

const { emailFollowupStatus, daysSinceEmail, EMAIL_FOLLOWUP_WAIT_DAYS, CLASSIFICATION_LABELS } = require("./email-followup");
const { isAutoClickResponse } = require("./response-kind");
const { isPlaceholderEmail } = require("./email-placeholder");

const STATES = ["unsent", "email_followup", "scheduled", "overdue", "queued", "on_hold", "stopped"];

const STATE_LABELS = {
  unsent: "未送信",
  email_followup: "メール後のフォーム",
  scheduled: "予約済み",
  overdue: "期限切れ",
  queued: "キュー待ち",
  on_hold: "保留中",
  stopped: "停止中",
};

function queueState(status) {
  if (status === "pending" || status === "sending") return "queued";
  if (status === "on_hold") return "on_hold";
  if (status === "failed" || status === "dismissed" || status === "skipped") return "stopped";
  return null; // sent など
}

function scheduledState(row, now) {
  if (row.status === "pending") {
    return new Date(row.scheduled_at).getTime() <= now ? "overdue" : "scheduled";
  }
  if (row.status === "cancelled" || row.status === "failed") return "stopped";
  return null; // sent など
}

const truthy = (v) => v === true || v === "true";

// ---- 未送信の企業を保留に移すかどうかの「選別の目安」 ----
// 機械的な目安で、最後は画面で人が判断する。名前に「公式ホームページ」「公式サイト」と付くだけの
// 実在企業(例: 株式会社グンエイ（公式ホームページ）)を誤って「企業ではない疑い」にしないよう、
// それ単体は判定に使わず、自治体・ポータル・団体などを示す語やドメインだけを見る。
const NOT_COMPANY_NAME_RE = new RegExp([
  "(市|町|村|県)(公式|役所|役場)", "City Hall", "City General",           // 自治体
  "ポータル", "情報サイト", "検索結果", "まとめ", "アーカイブ", "導入事例",   // ポータル・記事・一覧
  "ハブサイト", "会社情報【", "リフォーム会社・", "e-shops", "e-NAV", "団体ID",
  "[0-9０-９]+選(【|\\[|｜|\\||\\s|$)",                                    // 「おすすめ〇〇12選【2024年最新版】」形式のまとめ記事
  "協会", "協同組合", "組合", "NPO法人", "社団法人", "財団法人",            // 団体
  "医療センター", "病院", "学校", "農林業センター", "Welfare",              // 公共・医療・教育
  "America", "Inc\\.?$", ", Inc",                                         // 海外法人
].join("|"), "i");
// 企業そのものではなく、ポータル・自治体・公的機関のサイトであることが多いドメイン
const NOT_COMPANY_HOST_RE = /(^|\.)(lg\.jp|go\.jp)$|(^|\.)(city|town|vill|pref)\.|suumo\.jp$|hatomarksite\.com$|e-shops\.jp$|homepro\.jp$|navita\.co\.jp$|canpan\.info$|hotpepper\.jp$|boards\.autodesk\.com$|teachme\.jp$/i;
// 大企業の支店・工場のページ(送り先として適切かは要確認)
const BRANCH_RE = /工場|支店|営業所|Plant|Branch|Factory/i;

const SELECTION_HINTS = {
  dismissed_before: "却下済みあり(段階0等)",
  not_company: "企業サイトではない疑い",
  maybe_sent: "送信できたか不明(要確認)",
  branch: "支店・工場(要確認)",
  limit_only: "送信上限で止まっただけ(有力)",
  failed_3plus: "失敗3回以上",
  failed_1_2: "失敗1〜2回",
  no_failure: "失敗なし",
};
// 直近の失敗理由が「送信中に強制終了」= 実際には送れていた可能性がある(送ると二重送信の危険)
const MAYBE_SENT_RE = /強制終了|送信できたかは不明/;
// 直近の失敗理由が「1日の送信上限」= フォーム自体の問題ではなく、上限で順番が回らなかっただけ
const LIMIT_RE = /送信上限/;

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

// 登録ドメイン(例: www.wabika.com → wabika.com、shop.example.co.jp → example.co.jp)
function baseDomain(host) {
  const labels = (host || "").replace(/^www\./, "").split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const jpSecondLevel = /^(co|or|ne|ac|go|gr|ed|lg)$/;
  const take = labels[labels.length - 1] === "jp" && jpSecondLevel.test(labels[labels.length - 2]) ? 3 : 2;
  return labels.slice(-take).join(".");
}

// company: 企業 / failed: 過去の失敗回数 / dismissed: 却下(dismissed)された送信待ちの行があるか
// lastFailureMessage: 直近の失敗理由(送信待ちリストのfailedの行のエラー内容。無ければ空)
function selectionHint(company, failed, dismissed, lastFailureMessage) {
  let code;
  const name = (company && company.name) || "";
  const last = lastFailureMessage || "";
  if (dismissed) code = "dismissed_before";
  else if (NOT_COMPANY_NAME_RE.test(name) || NOT_COMPANY_HOST_RE.test(hostOf(company && company.url))) code = "not_company";
  else if (MAYBE_SENT_RE.test(last)) code = "maybe_sent";
  else if (BRANCH_RE.test(name)) code = "branch";
  else if (LIMIT_RE.test(last) && failed <= 2) code = "limit_only";
  else if (failed >= 3) code = "failed_3plus";
  else if (failed > 0) code = "failed_1_2";
  else code = "no_failure";
  return { code, label: SELECTION_HINTS[code] };
}

// 企業が自動送信の対象外になっている理由(無ければ空配列)
function ineligibleReasons(company) {
  if (!company) return ["企業が見つかりません"];
  const reasons = [];
  if (company.archived === true) reasons.push("アーカイブ済み");
  if (company.action_status === "closed") reasons.push("クローズ");
  if (company.action_status === "rejected") reasons.push("お断り");
  if (truthy(company.rejection_detected)) reasons.push("営業お断りを検出");
  if (company.status !== "researched") reasons.push(`リサーチ状態: ${company.status}`);
  else if (!truthy(company.automatable)) reasons.push("自動送信に非対応");
  return reasons;
}

// 送信記録の集計(send_logsを企業×チャネル×状態で集計したもの)と反応から、企業ごとの記録を作る
//   sendLogSummary: [{ company_id, channel, status, count, last_sent_at, variant_ids }]
//                   (channelが無い行はフォームとして扱う)
//   responses:      [{ company_id, classification, raw_excerpt, message_id, received_at, sent_at }]
function buildRecords(sendLogSummary, responses) {
  const records = new Map();
  const failedCounts = new Map();
  const get = (id) => {
    if (!records.has(id)) {
      records.set(id, {
        form: { sent: 0, uncertain: 0 },
        email: { sent: 0, uncertain: 0, last_at: null, variant_ids: [] },
        responses: { human: [], auto_clicks: [] },
      });
    }
    return records.get(id);
  };
  for (const s of sendLogSummary) {
    if (s.status === "failed") {
      failedCounts.set(s.company_id, (failedCounts.get(s.company_id) || 0) + (Number(s.count) || 0));
      continue;
    }
    if (s.status !== "sent" && s.status !== "uncertain") continue;
    const r = get(s.company_id);
    const ch = s.channel === "email" ? r.email : r.form;
    ch[s.status] += Number(s.count) || 0;
    if (s.channel === "email") {
      if (s.last_sent_at && (!ch.last_at || new Date(s.last_sent_at) > new Date(ch.last_at))) ch.last_at = s.last_sent_at;
      for (const v of s.variant_ids || []) if (!ch.variant_ids.includes(Number(v))) ch.variant_ids.push(Number(v));
    }
  }
  for (const resp of responses || []) {
    const r = get(resp.company_id);
    if (isAutoClickResponse(resp)) {
      const seconds = resp.sent_at && resp.received_at
        ? Math.round((new Date(resp.received_at) - new Date(resp.sent_at)) / 1000)
        : null;
      r.responses.auto_clicks.push({ received_at: resp.received_at, seconds_after_send: seconds });
    } else {
      r.responses.human.push({ classification: resp.classification, received_at: resp.received_at });
    }
  }
  return { records, failedCounts };
}

const sendCount = (ch) => (Number(ch.sent) || 0) + (Number(ch.uncertain) || 0);

// input:
//   companies:      [{ id, name, url, contact_form_url, email, status, archived, action_status,
//                      automatable, rejection_detected, project }]
//   sendLogSummary: [{ company_id, channel, status, count, last_sent_at, variant_ids }]
//   responses:      [{ company_id, classification, raw_excerpt, message_id, received_at, sent_at }](省略可)
//   queueRows:      [{ id, company_id, variant_id, variant_name, variant_project, channel, status,
//                      created_at, updated_at, error_message }]
//   scheduledRows:  [{ id, company_id, variant_id, variant_name, variant_project, channel, status,
//                      scheduled_at, created_at, error_message }]
//   senderProfileValid: このプロジェクトの送信者プロフィールが登録済みで検証に合格しているか
//   lastFailures:   [{ company_id, error_message, updated_at }]  企業ごとの直近の失敗理由(省略可)
//   now:            現在時刻(ミリ秒)
function buildLaterList({ companies, sendLogSummary, responses, queueRows, scheduledRows, senderProfileValid, lastFailures, now }) {
  const companyById = new Map(companies.map((c) => [c.id, c]));
  const lastFailureByCompany = new Map((lastFailures || []).map((f) => [f.company_id, f]));
  const { records, failedCounts } = buildRecords(sendLogSummary, responses);
  const hasAnySend = (id) => {
    const r = records.get(id);
    return !!r && (sendCount(r.form) > 0 || sendCount(r.email) > 0);
  };

  const items = [];
  for (const q of queueRows) {
    const state = queueState(q.status);
    if (!state) continue;
    items.push({
      key: `queue-${q.id}`, source: "queue", source_id: q.id, state, raw_status: q.status,
      company_id: q.company_id, variant_id: q.variant_id, variant_name: q.variant_name,
      variant_project: q.variant_project, channel: q.channel,
      date: q.created_at, date_label: "登録", updated_at: q.updated_at || null,
      error_message: q.error_message || null,
    });
  }
  for (const s of scheduledRows) {
    const state = scheduledState(s, now);
    if (!state) continue;
    items.push({
      key: `scheduled-${s.id}`, source: "scheduled", source_id: s.id, state, raw_status: s.status,
      company_id: s.company_id, variant_id: s.variant_id, variant_name: s.variant_name,
      variant_project: s.variant_project, channel: s.channel,
      date: s.scheduled_at, date_label: "予約", updated_at: null,
      error_message: s.error_message || null,
    });
  }

  // 同じ企業が「これから送られる」行(キュー待ち・保留・予約・期限切れ)に複数入っているか、
  // また停止中の行(却下・停止・失敗)があるか
  const activeStates = new Set(["queued", "on_hold", "scheduled", "overdue"]);
  const activeCount = new Map();
  const stoppedCount = new Map();
  const dismissedCompanies = new Set();
  for (const it of items) {
    if (activeStates.has(it.state)) activeCount.set(it.company_id, (activeCount.get(it.company_id) || 0) + 1);
    if (it.state === "stopped") stoppedCount.set(it.company_id, (stoppedCount.get(it.company_id) || 0) + 1);
    if (it.source === "queue" && it.raw_status === "dismissed") dismissedCompanies.add(it.company_id);
  }

  // 未送信の企業と、メール送信済み・フォーム未送信の企業(どちらも、送信待ちにも予約にも
  // 「これから送られる」行が無く、送信対象外でもないもの)
  for (const c of companies) {
    if (activeCount.has(c.id)) continue;
    if (ineligibleReasons(c).length > 0) continue;
    const r = records.get(c.id);
    const base = {
      source: "company", source_id: c.id, raw_status: null, company_id: c.id,
      variant_id: null, variant_name: null, variant_project: null, channel: "form",
      date: null, date_label: null, updated_at: null, error_message: null,
    };
    if (!hasAnySend(c.id)) {
      items.push({ ...base, key: `company-${c.id}`, state: "unsent" });
    } else if (sendCount(r.form) === 0 && sendCount(r.email) > 0) {
      items.push({
        ...base, key: `followup-${c.id}`, state: "email_followup",
        date: r.email.last_at, date_label: "メール送信",
        followup: {
          ...emailFollowupStatus(r, now),
          last_email_at: r.email.last_at,
          email_variant_ids: r.email.variant_ids,
        },
      });
    }
  }

  for (const it of items) {
    const c = companyById.get(it.company_id);
    it.company_name = c ? c.name : `(企業ID ${it.company_id})`;
    it.company_url = c ? c.url : null;
    it.contact_form_url = c ? c.contact_form_url : null;
    it.state_label = STATE_LABELS[it.state];
    it.warnings = warningsFor(it, c, records.get(it.company_id), activeCount.get(it.company_id) || 0, senderProfileValid, {
      failed: failedCounts.get(it.company_id) || 0,
      stopped: stoppedCount.get(it.company_id) || 0,
      lastFailure: lastFailureByCompany.get(it.company_id) || null,
    }, now);
    it.selection_hint = it.state === "unsent"
      ? selectionHint(c, failedCounts.get(it.company_id) || 0, dismissedCompanies.has(it.company_id),
          (lastFailureByCompany.get(it.company_id) || {}).error_message)
      : null;
    if (!it.followup) it.followup = null;
  }

  const order = { overdue: 0, queued: 1, on_hold: 2, scheduled: 3, email_followup: 4, unsent: 5, stopped: 6 };
  items.sort((a, b) =>
    order[a.state] - order[b.state] ||
    String(b.date || "").localeCompare(String(a.date || "")) ||
    a.key.localeCompare(b.key));

  const counts = Object.fromEntries(STATES.map((s) => [s, 0]));
  for (const it of items) counts[it.state]++;
  counts.total = items.length;
  counts.email_followup_ready = items.filter((it) => it.followup && it.followup.status === "ready").length;
  // 件数は注意が必要なもの(warn/danger)だけ数える。info(過去の失敗・停止の履歴)は数えない
  counts.with_warnings = items.filter((it) => it.warnings.some((w) => w.level !== "info")).length;

  return { items, counts };
}

function formatJstDate(v) {
  const d = new Date(v);
  if (isNaN(d)) return "";
  return d.toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" });
}

function warningsFor(it, company, record, activeCount, senderProfileValid, history, now) {
  const w = [];
  const willSend = it.state === "queued" || it.state === "scheduled" || it.state === "overdue" || it.state === "on_hold";
  // フォームで送る予定・候補の行(未送信・メール後のフォーム・送信待ち等のフォームの行)
  const formCandidate = it.state !== "stopped" && it.channel === "form";

  if (record && sendCount(record.form) > 0) {
    const f = record.form;
    const parts = [];
    if (f.sent) parts.push(`sent ${f.sent}件`);
    if (f.uncertain) parts.push(`uncertain ${f.uncertain}件`);
    w.push({
      code: "has_send_record",
      // 再送信ガードが止めるのはsentだけのため、uncertainだけの企業は送ると二重送信になり得る
      level: willSend && !f.sent ? "danger" : "warn",
      message: `送信記録あり(${parts.join("・")})` + (willSend && !f.sent ? "。送ると二重送信になる可能性があります" : ""),
    });
  }
  if (record && sendCount(record.email) > 0) {
    const days = daysSinceEmail(record, now);
    const tooRecent = days !== null && days < EMAIL_FOLLOWUP_WAIT_DAYS;
    w.push({
      code: "email_sent",
      level: willSend && it.channel === "form" && tooRecent ? "danger" : "warn",
      message: `メール送信済み(${formatJstDate(record.email.last_at)}・${days}日前)` +
        (willSend && it.channel === "form" && tooRecent ? `。メールから${EMAIL_FOLLOWUP_WAIT_DAYS}日空ける決まりです` : ""),
    });
  }
  if (record && record.responses.human.length > 0) {
    const declined = record.responses.human.some((r) => r.classification === "declined");
    const kinds = [...new Set(record.responses.human.map((r) => CLASSIFICATION_LABELS[r.classification] || r.classification || "分類なし"))];
    w.push({
      code: "human_response",
      level: declined ? "danger" : "warn",
      message: `人からの反応あり(${kinds.join("・")})`,
    });
  }
  if (record && record.responses.auto_clicks.length > 0) {
    const first = record.responses.auto_clicks[0];
    const quick = first.seconds_after_send !== null && first.seconds_after_send <= 300;
    w.push({
      code: "auto_click",
      level: "info",
      message: "リンクのクリックを自動記録" +
        (first.seconds_after_send !== null ? `(送信から${first.seconds_after_send}秒後)` : "") +
        (quick ? "。送信直後のため、相手のセキュリティ機能による自動確認の可能性があります" : ""),
    });
  }
  if (it.state === "overdue") {
    w.push({ code: "overdue", level: "warn", message: "予約日時を過ぎたまま実行されていません" });
  }
  if (it.source !== "company") {
    const reasons = ineligibleReasons(company);
    if (reasons.length > 0 && willSend) {
      w.push({ code: "ineligible", level: "warn", message: `送信対象外: ${reasons.join("・")}` });
    }
  }
  if (activeCount > 1 && (it.state === "queued" || it.state === "on_hold" || it.state === "scheduled" || it.state === "overdue")) {
    w.push({ code: "duplicate", level: "warn", message: "同じ企業が送信待ち・予約に複数入っています" });
  }
  if (it.variant_project && company && company.project && it.variant_project !== company.project) {
    w.push({ code: "variant_project_mismatch", level: "danger", message: "バリアントのプロジェクトが企業と違います(送信時に拒否されます)" });
  }
  if (willSend && it.channel === "form" && !senderProfileValid) {
    w.push({ code: "no_sender_profile", level: "danger", message: "送信者プロフィールが未登録・不完全です(フォーム送信は止まります)" });
  }
  // フォームが企業のサイトとは別のドメインにある(掲載サイト・ポータルの運営会社のフォームの疑い)。
  // 外部のフォームサービスを使う実在企業もあるため、止めずに警告だけにする
  if (formCandidate && company && company.contact_form_url && company.url) {
    const siteBase = baseDomain(hostOf(company.url));
    const formBase = baseDomain(hostOf(company.contact_form_url));
    if (siteBase && formBase && siteBase !== formBase) {
      w.push({
        code: "form_domain_mismatch",
        level: "danger",
        message: `フォームが企業のサイトと別のドメインです(${formBase})。掲載サイト等、別の会社のフォームの疑い`,
      });
    }
  }
  // メールで送る予定の行で、登録アドレスが入力例・仮のアドレス(送信時にメール送信の処理が止める)
  if (willSend && it.channel === "email" && company && company.email) {
    const ph = isPlaceholderEmail(company.email);
    if (ph.placeholder) {
      w.push({ code: "placeholder_email", level: "danger", message: `登録メールアドレスが入力例のため送信されません(${ph.reason})` });
    }
  }
  // これから送る・送るかもしれない行(未送信を含む)には、過去の失敗と停止の履歴を知らせる
  if (it.state !== "stopped") {
    if (history.failed > 0) {
      w.push({ code: "past_failures", level: "info", message: `過去の送信が失敗${history.failed}回` });
    }
    if (history.stopped > 0) {
      w.push({ code: "previously_stopped", level: "info", message: "停止・却下・失敗した送信待ち/予約あり(停止中タブ)" });
    }
    if (history.lastFailure && history.lastFailure.error_message) {
      w.push({ code: "last_failure", level: "info", message: `直近の失敗理由: ${history.lastFailure.error_message.slice(0, 120)}` });
    }
  }
  return w;
}

module.exports = {
  STATES, STATE_LABELS, SELECTION_HINTS, buildLaterList, buildRecords, ineligibleReasons, selectionHint, baseDomain,
};
