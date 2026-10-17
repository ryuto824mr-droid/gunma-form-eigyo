// public/jp-holidays.js
//
// 日本の祝日を計算で求める(画面とテストで共用。ブラウザでは window.JPHolidays、Node では require で使う)。
// 稼働報告書(public/work-report.html)で、どの年・月でも土日祝に色を付けるために使う。
// 対象は2020〜2099年(春分・秋分の計算式の範囲)。祝日の法律が変わったときはここを直す。
// 毎日の送信の判定(api/crm.js の 2026年の一覧)とは別物で、テストで2026年分が一致することを確かめている。
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.JPHolidays = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
  // その年月の第n月曜日(日付)
  function nthMonday(y, m, n) {
    const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(); // 0=日
    const firstMonday = 1 + ((8 - first) % 7);
    return firstMonday + (n - 1) * 7;
  }
  // 春分・秋分の日(1980〜2099年に使われる近似式)
  const shunbun = (y) => Math.floor(20.8431 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
  const shubun = (y) => Math.floor(23.2488 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));

  const cache = new Map();

  // その年の祝日(振替休日・国民の休日を含む)を Map("YYYY-MM-DD" → 名前)で返す
  function holidaysOf(year) {
    const y = Number(year);
    if (cache.has(y)) return cache.get(y);
    const base = new Map();
    const add = (m, d, name) => base.set(ymd(y, m, d), name);
    add(1, 1, "元日");
    add(1, nthMonday(y, 1, 2), "成人の日");
    add(2, 11, "建国記念の日");
    add(2, 23, "天皇誕生日");
    add(3, shunbun(y), "春分の日");
    add(4, 29, "昭和の日");
    add(5, 3, "憲法記念日");
    add(5, 4, "みどりの日");
    add(5, 5, "こどもの日");
    // 東京オリンピック・パラリンピックの年(2020・2021)は海の日・スポーツの日・山の日が移動した
    if (y === 2020) {
      add(7, 23, "海の日"); add(7, 24, "スポーツの日"); add(8, 10, "山の日");
    } else if (y === 2021) {
      add(7, 22, "海の日"); add(7, 23, "スポーツの日"); add(8, 8, "山の日");
    } else {
      add(7, nthMonday(y, 7, 3), "海の日");
      add(8, 11, "山の日");
      add(10, nthMonday(y, 10, 2), "スポーツの日");
    }
    add(9, nthMonday(y, 9, 3), "敬老の日");
    add(9, shubun(y), "秋分の日");
    add(11, 3, "文化の日");
    add(11, 23, "勤労感謝の日");

    const all = new Map(base);
    const dateOf = (s) => new Date(`${s}T00:00:00Z`);
    const str = (d) => d.toISOString().slice(0, 10);
    // 国民の休日: 前日と翌日が祝日の平日(祝日に挟まれた日)
    for (const s of [...base.keys()]) {
      const next = dateOf(s); next.setUTCDate(next.getUTCDate() + 1);
      const after = dateOf(s); after.setUTCDate(after.getUTCDate() + 2);
      if (!base.has(str(next)) && base.has(str(after)) && next.getUTCDay() !== 0) all.set(str(next), "国民の休日");
    }
    // 振替休日: 日曜の祝日のあと、最初の祝日でない日
    for (const s of [...base.keys()].sort()) {
      if (dateOf(s).getUTCDay() !== 0) continue;
      const d = dateOf(s);
      do { d.setUTCDate(d.getUTCDate() + 1); } while (all.has(str(d)));
      all.set(str(d), "振替休日");
    }
    const sorted = new Map([...all.entries()].sort((a, b) => a[0].localeCompare(b[0])));
    cache.set(y, sorted);
    return sorted;
  }

  // "YYYY-MM-DD" が祝日なら名前、そうでなければ null
  function holidayName(dateStr) {
    const y = Number(String(dateStr).slice(0, 4));
    if (!y) return null;
    return holidaysOf(y).get(String(dateStr).slice(0, 10)) || null;
  }

  return { holidaysOf, holidayName };
});
