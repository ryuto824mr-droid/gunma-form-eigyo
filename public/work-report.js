// public/work-report.js
//
// 稼働報告書(public/work-report.html)の中身を作る計算。DOM に触らない関数だけを置き、
// 画面とテストで共用する(ブラウザでは window.WorkReport、Node では require で使う)。
//
// 時間は「分」で数えてから表示する(出勤・退勤の時刻から計算し、0時をまたげば24時間を足す。DB と同じ考え方)。
// そのため小数の合計は、1回ごとに小数2桁に丸めてから足す Excel 出力と 0.01 時間ずれることがある。
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.WorkReport = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const COMPANY_NAME = "株式会社LOCLE";
  const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
  const pad = (n) => String(n).padStart(2, "0");

  // "09:05:00" / "09:05" → 545(分)。読めなければ null
  function parseTime(t) {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(t || ""));
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  }

  // "09:05:00" → "9:05"
  function displayTime(t) {
    const min = parseTime(t);
    if (min === null) return "";
    return `${Math.floor(min / 60)}:${pad(min % 60)}`;
  }

  // 1回の出勤〜退勤の分数。退勤前(または時刻が無い)なら null
  function sessionMinutes(s) {
    const a = parseTime(s && s.clock_in);
    const b = parseTime(s && s.clock_out);
    if (a === null || b === null) return null;
    return b >= a ? b - a : b - a + 24 * 60;
  }

  // 分 → "152:30"
  function formatHM(minutes) {
    const m = Math.max(0, Math.round(minutes || 0));
    return `${Math.floor(m / 60)}:${pad(m % 60)}`;
  }
  // 分 → "152.50"
  function formatDecimal(minutes) {
    return (Math.round(((minutes || 0) / 60) * 100) / 100).toFixed(2);
  }
  // 分 → "152時間30分"
  function formatJapanese(minutes) {
    const m = Math.max(0, Math.round(minutes || 0));
    return `${Math.floor(m / 60)}時間${pad(m % 60)}分`;
  }

  function daysInMonth(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
  }
  function weekdayOf(dateStr) {
    return new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  }
  // "2026-10-01" → "2026年10月1日(木)"
  function formatJpDate(dateStr) {
    const [y, m, d] = String(dateStr).slice(0, 10).split("-").map(Number);
    return `${y}年${m}月${d}日(${WEEKDAYS[weekdayOf(dateStr)]})`;
  }

  // "2026-10" → { year: 2026, month: 10 }。読めなければ null
  function parseMonth(value) {
    const m = /^(\d{4})-(\d{2})$/.exec(String(value || ""));
    if (!m) return null;
    const year = Number(m[1]);
    const month = Number(m[2]);
    if (month < 1 || month > 12) return null;
    return { year, month };
  }

  function monthRange(year, month) {
    return { from: `${year}-${pad(month)}-01`, to: `${year}-${pad(month)}-${pad(daysInMonth(year, month))}` };
  }

  // 月の全日の行と合計を作る
  //   sessions: work_sessions の行 [{ date, clock_in, clock_out }]
  //   logs:     work_logs の行 [{ date, tasks_done }]
  //   holidayName: "YYYY-MM-DD" → 祝日名 or null を返す関数(省略可)
  function buildMonthReport({ sessions, logs, year, month, holidayName }) {
    const byDate = new Map();
    for (const s of sessions || []) {
      const key = String(s.date).slice(0, 10);
      if (!byDate.has(key)) byDate.set(key, []);
      byDate.get(key).push(s);
    }
    const logByDate = new Map((logs || []).map((l) => [String(l.date).slice(0, 10), l]));
    const { from, to } = monthRange(year, month);
    const days = [];
    let totalMinutes = 0;
    let workDays = 0;
    for (let d = 1; d <= daysInMonth(year, month); d++) {
      const date = `${year}-${pad(month)}-${pad(d)}`;
      const weekday = weekdayOf(date);
      const holiday = holidayName ? holidayName(date) : null;
      const list = (byDate.get(date) || []).slice()
        .sort((a, b) => String(a.clock_in || "").localeCompare(String(b.clock_in || "")));
      let minutes = 0;
      let open = false;
      for (const s of list) {
        const m = sessionMinutes(s);
        if (m === null) { if (s.clock_in) open = true; } else minutes += m;
      }
      totalMinutes += minutes;
      if (minutes > 0) workDays++;
      const log = logByDate.get(date);
      days.push({
        date,
        day: d,
        dateLabel: `${month}/${d}`,
        weekday,
        weekdayLabel: WEEKDAYS[weekday],
        holidayName: holiday,
        offDay: weekday === 0 || weekday === 6 || !!holiday,
        clockIn: list.map((s) => displayTime(s.clock_in)).filter(Boolean).join(" / "),
        clockOut: list.filter((s) => s.clock_in).map((s) => (s.clock_out ? displayTime(s.clock_out) : "勤務中")).join(" / "),
        minutes,
        hasOpenSession: open,
        hoursLabel: minutes > 0 ? formatHM(minutes) : "",
        tasks: log && log.tasks_done ? String(log.tasks_done).trim() : "",
      });
    }
    return {
      year, month, from, to, days, totalMinutes, workDays,
      periodLabel: `${formatJpDate(from)}〜${month}月${daysInMonth(year, month)}日(${WEEKDAYS[weekdayOf(to)]})`,
      totalLabel: `${formatJapanese(totalMinutes)}(${formatDecimal(totalMinutes)}時間)`,
      totalHM: formatHM(totalMinutes),
      totalDecimal: formatDecimal(totalMinutes),
    };
  }

  // PDF のファイル名の初期値に使うページのタイトル
  function reportTitle(userName, year, month) {
    return `稼働記録_${userName}_${year}-${pad(month)}`;
  }

  return {
    COMPANY_NAME, WEEKDAYS, parseTime, displayTime, sessionMinutes, formatHM, formatDecimal, formatJapanese,
    daysInMonth, formatJpDate, parseMonth, monthRange, buildMonthReport, reportTitle,
  };
});
