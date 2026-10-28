// 供給と送信の収支(1日の新規・送信・在庫)を、本番の GET だけで表示する(読み取り専用)。
// DB には書かない。送信・企業探しの API は呼ばない。鍵も使わない。
//
//   node scripts/daily-balance.js              … 今日(日本時間)と直近7日
//   node scripts/daily-balance.js 2026-10-27   … その日と、その日までの7日
//
// 見るもの(プロジェクトごと):
//   新規  … 自動パイプラインの記録(auto-pipeline-logs)の 見つけた数・調べた数・保留に積んだ数(日本時間の日付で集計)
//   送信  … 送信記録(send-logs)の sent・uncertain(送った扱い)・failed(日本時間の日付で集計)
//   在庫  … 「あとで送る」(later-list)の 送れる・★候補・要確認・保留・送信待ち(今の値。過去の日の在庫は出せない)
//   収支  … 保留に積んだ数 − 送った数。在庫の日数 = 送れる ÷ 直近の平日1日あたりの送った数

const BASE = process.env.BALANCE_BASE_URL || "https://gunma-form-eigyo.vercel.app";
const PROJECTS = ["ozukanzukan", "locle"];
const DAYS = 7;

async function get(path) {
  const r = await fetch(BASE + path, { method: "GET" });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

const jstDate = (iso) => new Date(new Date(iso).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const todayJst = () => jstDate(new Date().toISOString());

function lastDays(end, n) {
  const out = [];
  const t = new Date(`${end}T00:00:00Z`).getTime();
  for (let i = n - 1; i >= 0; i--) out.push(new Date(t - i * 86400000).toISOString().slice(0, 10));
  return out;
}

const isWeekday = (d) => { const w = new Date(`${d}T00:00:00Z`).getUTCDay(); return w !== 0 && w !== 6; };
const pad = (v, n) => String(v).padStart(n);

async function project(name, days) {
  const [logs, sends, later] = await Promise.all([
    get(`/api/crm?action=auto-pipeline-logs&project=${name}`),
    get(`/api/send-logs?project=${name}`),
    get(`/api/crm?action=later-list&project=${name}`),
  ]);
  const byDay = Object.fromEntries(days.map((d) => [d, { runs: 0, found: 0, researched: 0, held: 0, sent: 0, uncertain: 0, failed: 0, email: 0, form: 0, errors: [] }]));
  for (const l of logs) {
    const d = byDay[jstDate(l.created_at)];
    if (!d) continue;
    d.runs++;
    d.found += l.found_count || 0;
    d.researched += l.researched_count || 0;
    d.held += l.sent_count || 0; // sent_count は「送信待ちリスト(保留)に積んだ数」
    if (l.error_message) d.errors.push(l.error_message);
  }
  for (const s of sends) {
    if (!s.sent_at) continue;
    const d = byDay[jstDate(s.sent_at)];
    if (!d) continue;
    if (s.status === "sent") d.sent++;
    else if (s.status === "uncertain") d.uncertain++;
    else if (s.status === "failed") d.failed++;
    if (s.status === "sent" || s.status === "uncertain") d[s.channel === "email" ? "email" : "form"]++;
  }
  const c = later.counts || {};
  return { name, byDay, stock: { ready: c.ready, auto: c.auto_candidate, review: c.review, blocked: c.blocked, on_hold: c.on_hold, queued: c.queued } };
}

(async () => {
  const end = /^\d{4}-\d{2}-\d{2}$/.test(process.argv[2] || "") ? process.argv[2] : todayJst();
  const days = lastDays(end, DAYS);
  console.log(`供給と送信の収支(読み取りのみ) ${days[0]}〜${end}(日本時間) ${BASE}\n`);
  for (const name of PROJECTS) {
    const p = await project(name, days);
    console.log(`■ ${name}`);
    console.log("  日付        曜 回数 見つけ 調べ 保留へ | 送った(フォーム/メール) 不確か 失敗 | 収支");
    let sentWeekdays = 0, weekdayCount = 0;
    for (const d of days) {
      const r = p.byDay[d];
      const done = r.sent + r.uncertain;
      const wd = "日月火水木金土"[new Date(`${d}T00:00:00Z`).getUTCDay()];
      if (isWeekday(d) && d !== end) { sentWeekdays += done; weekdayCount++; }
      console.log(`  ${d} ${wd} ${pad(r.runs, 4)} ${pad(r.found, 6)} ${pad(r.researched, 4)} ${pad(r.held, 6)} | ${pad(done, 6)}(${r.form}/${r.email}) ${pad(r.uncertain, 12)} ${pad(r.failed, 4)} | ${pad((r.held - done >= 0 ? "+" : "") + (r.held - done), 4)}`);
      const errs = [...new Set(r.errors)].filter((e) => !/土日|祝日/.test(e));
      if (errs.length) console.log(`               記録: ${errs.join(" / ").slice(0, 120)}`);
    }
    const s = p.stock;
    const perDay = weekdayCount ? sentWeekdays / weekdayCount : 0;
    console.log(`  在庫(今): 送れる ${s.ready}(★候補 ${s.auto}) / 要確認 ${s.review} / 送れない ${s.blocked} / 保留 ${s.on_hold} / 送信待ち ${s.queued}`);
    console.log(`  直近の平日1日あたりの送った数: ${perDay.toFixed(1)} → 送れる在庫は ${perDay > 0 ? (s.ready / perDay).toFixed(1) + " 日分" : "—(送信なし)"}\n`);
  }
})().catch((e) => { console.error(`取得に失敗しました: ${e.message}`); process.exit(1); });
