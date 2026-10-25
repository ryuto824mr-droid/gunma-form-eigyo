// lib/hold-release.js
//
// 自動パイプラインが保留(on_hold)で積んだ行を、1営業日待ってから自動で送信待ち(pending)に移すかを決める。
// 設定 auto_release_hold が "true" のときだけ動く(初期は「切」。切のときは api/crm.js が DB に何も問い合わせない)。
// DB・ブラウザ・外部APIは使わない純粋な関数(テストで偽のデータを渡せるようにするため)。
//
// 移す対象(すべてを満たす行だけ):
//   1. 自動パイプラインが足した保留の行(メモが「[保留] 自動パイプラインで追加」で始まる)。
//      「あとで送る」画面で人が保留にした行は、人が決めたことなので移さない
//   2. 保留にしてから1営業日以上たっている(日本時間の暦日で数え、土日・祝日は数えない)
//   3. later-list(lib/later-status.js)で「自動の候補」(autoCandidate)に合格している
//      (送れる・警告なし・送信記録なし・宛名が確か・欄の判定がAI・電話番号が群馬県 等)
//   4. 会社概要の住所の県が群馬県と違わない(lib/prefecture.js)
//   5. 同じ企業が、ほかに送信待ち・予約に入っていない
// 止まる場合(この日は1件も移さない):
//   - 設定が「切」 / 土日・祝日 / 今日の送信が1日の上限に達している
//   - 直近に自動で移した行の失敗が半分を超えている(2件以上の結果があるとき)

const AUTO_PIPELINE_HOLD_PREFIX = "[保留] 自動パイプラインで追加";
const RELEASE_MARK = "[自動で送信待ちへ]";
const DEFAULT_DAILY_RELEASE_LIMIT = 5;

function isEnabled(settings) {
  return !!settings && String(settings.auto_release_hold || "").trim().toLowerCase() === "true";
}

// 日本時間の暦日 "YYYY-MM-DD"
function jstDate(t) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(t));
}

function isBusinessDay(dateStr, isHoliday) {
  const wd = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return wd !== 0 && wd !== 6 && !isHoliday(dateStr);
}

// from の翌日から to の日までに含まれる営業日の数(同じ日なら0)
function businessDaysBetween(from, to, isHoliday) {
  const start = jstDate(from);
  const end = jstDate(to);
  let n = 0;
  const d = new Date(`${start}T00:00:00Z`);
  for (let i = 0; i < 400; i++) {
    d.setUTCDate(d.getUTCDate() + 1);
    const s = d.toISOString().slice(0, 10);
    if (s > end) break;
    if (isBusinessDay(s, isHoliday)) n++;
  }
  return n;
}

function dailyLimitOf(settings) {
  const n = parseInt(settings && settings.auto_release_hold_daily_limit, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DAILY_RELEASE_LIMIT;
}

// 移す行を決める。
//   items: buildLaterList の items(送信待ち・保留の行を含む)
//   prefectureBlock: company_id → 県外の理由(文字列)。無ければ県外ではない
//   todaySendCount / dailySendLimit: 今日の送信記録の件数と1日の送信上限
//   recentReleased: 直近に自動で移した行の結果 [{ status }]
//   releasedToday: 今日すでに自動で移した件数
// 戻り値: { release: [{ queue_id, company_id }], skipped: [{ queue_id, reason }], stopped: 理由 | null }
function selectHoldReleases({ settings, items, prefectureBlock = new Map(), now = Date.now(), isHoliday = () => false,
  todaySendCount = 0, dailySendLimit = 20, recentReleased = [], releasedToday = 0 }) {
  const out = { release: [], skipped: [], stopped: null };
  if (!isEnabled(settings)) { out.stopped = "設定が切(auto_release_hold)"; return out; }
  if (!isBusinessDay(jstDate(now), isHoliday)) { out.stopped = "土日・祝日"; return out; }
  if (todaySendCount >= dailySendLimit) { out.stopped = `今日の送信が上限(${dailySendLimit}件)に達している`; return out; }
  const results = recentReleased.filter((r) => r.status === "sent" || r.status === "failed");
  const failed = results.filter((r) => r.status === "failed").length;
  if (results.length >= 2 && failed * 2 > results.length) {
    out.stopped = `直近に自動で移した行の失敗が半分を超えている(${failed}/${results.length})`;
    return out;
  }
  const remaining = dailyLimitOf(settings) - releasedToday;
  if (remaining <= 0) { out.stopped = `今日の自動で移す上限(${dailyLimitOf(settings)}件)に達している`; return out; }

  // 同じ企業のこれから送られる行(送信待ち・予約・期限切れ)
  const activeCompanies = new Set(items.filter((it) => ["queued", "scheduled", "overdue"].includes(it.state)).map((it) => it.company_id));
  const holds = items
    .filter((it) => it.source === "queue" && it.state === "on_hold")
    .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")) || a.source_id - b.source_id);
  for (const it of holds) {
    const skip = (reason) => out.skipped.push({ queue_id: it.source_id, company_id: it.company_id, reason });
    if (!String(it.error_message || "").startsWith(AUTO_PIPELINE_HOLD_PREFIX)) { skip("人が保留にした行"); continue; }
    if (!it.date || businessDaysBetween(it.date, now, isHoliday) < 1) { skip("保留から1営業日たっていない"); continue; }
    if (!it.auto_candidate || !it.auto_candidate.ok) {
      skip(`自動の候補ではない(${((it.auto_candidate && it.auto_candidate.reasons) || [it.category_reasons || "送れるではない"]).flat().join("・")})`);
      continue;
    }
    if (prefectureBlock.get(it.company_id)) { skip(prefectureBlock.get(it.company_id)); continue; }
    if (activeCompanies.has(it.company_id)) { skip("同じ企業がほかに送信待ち・予約に入っている"); continue; }
    if (out.release.length >= remaining) { skip("今日の自動で移す上限"); continue; }
    out.release.push({ queue_id: it.source_id, company_id: it.company_id });
  }
  return out;
}

module.exports = {
  AUTO_PIPELINE_HOLD_PREFIX, RELEASE_MARK, DEFAULT_DAILY_RELEASE_LIMIT,
  isEnabled, businessDaysBetween, jstDate, selectHoldReleases,
};
