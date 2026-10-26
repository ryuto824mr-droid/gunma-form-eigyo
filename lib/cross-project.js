// lib/cross-project.js
//
// プロジェクトをまたいだ二重送信の防止(locle と ozukanzukan で同じ会社に送らない)。
// 同じ会社が両方のプロジェクトに別々の行で登録されていると、それぞれから送られてしまう
// (2026-10-26: locle の「送れる」63社が ozukanzukan にも登録があり、うち47社は ozukanzukan で送信済み)。
// 会社は lib/domain-utils.js の companyKey(サイトの登録ドメイン。地域型の .jp・共用のサービスはホスト名)で比べる。
//
// もう一方のプロジェクトの同じ会社で、次のどれかに当てはまれば送らない:
//   - 送信記録がある(sent・uncertain。failed だけなら止めない)
//   - 人からの返信がある(リンククリックの自動記録は除く)
//   - 送信待ち・送信中・保留・予約に入っている(アーカイブ済みの会社の行は除く)
// 送信記録と返信は、もう一方の会社がアーカイブ済みでも止める(送った事実は消えないため)。
// DB には触らない純粋な関数だけを置く(読み込みは api/crm.js・api/discover.js)。

const { companyKey } = require("./domain-utils");
const { isAutoClickResponse } = require("./response-kind");

const ACTIVE_QUEUE_STATUSES = ["pending", "sending", "on_hold"];

// もう一方のプロジェクトの行から、会社ごとの記録を作る。
//   companies:      [{ id, url, archived }]
//   sendLogSummary: [{ company_id, status, count, last_sent_at }]
//   queueRows:      [{ company_id, status }]
//   scheduledRows:  [{ company_id, status }]
//   responses:      [{ company_id, classification, raw_excerpt }]
//   activeStatuses: 「入っている」とみなす送信待ちリストの状態(既定 pending・sending・on_hold)。送信待ちの処理では
//     pending を除く(両方のプロジェクトの同じ会社が同じ回の送信待ちにあると、互いに止め合ってしまうため。
//     先に送った方の送信記録で、後の方が止まる)
// 戻り値: Map<companyKey, { ids, sent, last_sent_at, responded, active }>
function buildCrossProjectIndex({ project, companies = [], sendLogSummary = [], queueRows = [], scheduledRows = [], responses = [],
  activeStatuses = ACTIVE_QUEUE_STATUSES }) {
  const byId = new Map();
  for (const c of companies) {
    const key = companyKey(c.url);
    if (key) byId.set(c.id, { key, archived: c.archived === true });
  }
  const index = new Map();
  const entry = (companyId) => {
    const c = byId.get(companyId);
    if (!c) return null;
    if (!index.has(c.key)) index.set(c.key, { project, ids: [], sent: 0, last_sent_at: null, responded: false, active: false });
    const e = index.get(c.key);
    if (!e.ids.includes(companyId)) e.ids.push(companyId);
    return { e, archived: c.archived };
  };
  for (const s of sendLogSummary) {
    if (s.status !== "sent" && s.status !== "uncertain") continue;
    const hit = entry(s.company_id);
    if (!hit) continue;
    hit.e.sent += Number(s.count) || 0;
    if (s.last_sent_at && (!hit.e.last_sent_at || new Date(s.last_sent_at) > new Date(hit.e.last_sent_at))) hit.e.last_sent_at = s.last_sent_at;
  }
  for (const r of responses) {
    if (isAutoClickResponse(r)) continue;
    const hit = entry(r.company_id);
    if (hit) hit.e.responded = true;
  }
  const activeRows = [
    ...queueRows.filter((q) => activeStatuses.includes(q.status)),
    ...scheduledRows.filter((s) => s.status === "pending"),
  ];
  for (const row of activeRows) {
    const c = byId.get(row.company_id);
    if (!c || c.archived) continue;
    entry(row.company_id).e.active = true;
  }
  // 記録の無い会社(登録だけ)は止める理由にならないので外す
  for (const [key, e] of index) if (!e.sent && !e.responded && !e.active) index.delete(key);
  return index;
}

const PROJECT_LABELS = { locle: "LOCLE", ozukanzukan: "群馬お仕事図鑑" };

// この会社を、もう一方のプロジェクトの記録のために止めるか。止めるなら { reason, ids }、止めないなら null
function crossProjectBlock(company, index) {
  if (!company || !index || index.size === 0) return null;
  const e = index.get(companyKey(company.url));
  if (!e) return null;
  const label = PROJECT_LABELS[e.project] || e.project || "別のプロジェクト";
  const parts = [];
  if (e.sent) parts.push(`送信済み${e.last_sent_at ? `(最後 ${String(new Date(e.last_sent_at).toISOString()).slice(0, 10)})` : ""}`);
  if (e.responded) parts.push("返信あり");
  if (e.active) parts.push("送信待ち・保留・予約に入っている");
  return { reason: `${label}で同じ会社に${parts.join("・")}(企業ID ${e.ids.join(", ")})`, ids: e.ids.slice() };
}

module.exports = { buildCrossProjectIndex, crossProjectBlock, ACTIVE_QUEUE_STATUSES };
