// 稼働報告書の計算(public/work-report.js)のテスト。DB・ブラウザ・外部APIは使わない
const test = require("node:test");
const assert = require("node:assert/strict");
const WR = require("../public/work-report.js");
const { holidayName } = require("../public/jp-holidays.js");

const build = (over) => WR.buildMonthReport({ sessions: [], logs: [], year: 2026, month: 10, holidayName, ...over });
const day = (r, d) => r.days[d - 1];

test("月の全日を並べる(28・29・30・31日)と曜日", () => {
  assert.equal(build({ year: 2026, month: 2 }).days.length, 28);
  assert.equal(build({ year: 2028, month: 2 }).days.length, 29);
  assert.equal(build({ year: 2026, month: 11 }).days.length, 30);
  const oct = build();
  assert.equal(oct.days.length, 31);
  assert.equal(day(oct, 1).weekdayLabel, "木");
  assert.equal(day(oct, 31).weekdayLabel, "土");
  assert.equal(day(oct, 1).dateLabel, "10/1");
  assert.equal(oct.periodLabel, "2026年10月1日(木)〜10月31日(土)");
  assert.deepEqual([oct.from, oct.to], ["2026-10-01", "2026-10-31"]);
});

test("土日祝に印を付け、祝日名を持つ", () => {
  const oct = build();
  assert.equal(day(oct, 3).offDay, true, "土曜");
  assert.equal(day(oct, 4).offDay, true, "日曜");
  assert.equal(day(oct, 12).offDay, true);
  assert.equal(day(oct, 12).holidayName, "スポーツの日");
  assert.equal(day(oct, 13).offDay, false);
  assert.equal(day(oct, 13).holidayName, null);
});

test("出勤・退勤・稼働時間・業務内容。記録のない日は空欄", () => {
  const r = build({
    sessions: [{ date: "2026-10-01", clock_in: "09:00:00", clock_out: "18:00:00", work_hours: "9.00" }],
    logs: [{ date: "2026-10-01T00:00:00.000Z", tasks_done: "  リサーチ\n資料作成 " }],
  });
  const d1 = day(r, 1);
  assert.deepEqual([d1.clockIn, d1.clockOut, d1.hoursLabel, d1.minutes, d1.tasks], ["9:00", "18:00", "9:00", 540, "リサーチ\n資料作成"]);
  const d2 = day(r, 2);
  assert.deepEqual([d2.clockIn, d2.clockOut, d2.hoursLabel, d2.tasks], ["", "", "", ""]);
});

test("1日に複数回の出勤は「/」で並べ、出勤順にする", () => {
  const r = build({ sessions: [
    { date: "2026-10-02", clock_in: "13:00:00", clock_out: "18:00:00" },
    { date: "2026-10-02", clock_in: "09:00:00", clock_out: "12:00:00" },
  ] });
  assert.deepEqual([day(r, 2).clockIn, day(r, 2).clockOut, day(r, 2).hoursLabel], ["9:00 / 13:00", "12:00 / 18:00", "8:00"]);
});

test("0時をまたぐ記録は24時間を足す(22:00→1:00 は3時間)", () => {
  const r = build({ sessions: [{ date: "2026-10-05", clock_in: "22:00:00", clock_out: "01:00:00" }] });
  assert.equal(day(r, 5).minutes, 180);
  assert.equal(day(r, 5).hoursLabel, "3:00");
});

test("退勤していない記録は「勤務中」と出し、合計に入れない", () => {
  const r = build({ sessions: [
    { date: "2026-10-06", clock_in: "09:00:00", clock_out: "12:00:00" },
    { date: "2026-10-06", clock_in: "13:00:00", clock_out: null },
    { date: "2026-10-07", clock_in: "09:00:00", clock_out: null },
  ] });
  assert.equal(day(r, 6).clockOut, "12:00 / 勤務中");
  assert.equal(day(r, 6).minutes, 180);
  assert.equal(day(r, 6).hasOpenSession, true);
  assert.equal(day(r, 7).hoursLabel, "", "勤務中だけの日は稼働時間を空欄");
  assert.equal(r.totalMinutes, 180);
  assert.equal(r.workDays, 1);
});

test("合計は「時間:分」と小数の両方。分で数えるので 20分×3回は 1:00・1.00", () => {
  const r = build({ sessions: [
    { date: "2026-10-01", clock_in: "09:00", clock_out: "09:20" },
    { date: "2026-10-02", clock_in: "09:00", clock_out: "09:20" },
    { date: "2026-10-05", clock_in: "09:00", clock_out: "09:20" },
  ] });
  assert.equal(r.totalHM, "1:00");
  assert.equal(r.totalDecimal, "1.00");
  assert.equal(r.workDays, 3);
});

test("152時間30分の月の見出しの表記", () => {
  const sessions = [];
  // 平日20日 × 7:30 + 1日 × 2:30 = 152:30
  let n = 0;
  for (let d = 1; d <= 31 && n < 21; d++) {
    const date = `2026-10-${String(d).padStart(2, "0")}`;
    const wd = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (wd === 0 || wd === 6 || holidayName(date)) continue;
    sessions.push({ date, clock_in: "09:00:00", clock_out: n < 20 ? "16:30:00" : "11:30:00" });
    n++;
  }
  const r = build({ sessions });
  assert.equal(r.totalHM, "152:30");
  assert.equal(r.totalDecimal, "152.50");
  assert.equal(r.totalLabel, "152時間30分(152.50時間)");
  assert.equal(r.workDays, 21);
});

test("時間の表記・月の読み取り・タイトル", () => {
  assert.equal(WR.formatHM(0), "0:00");
  assert.equal(WR.formatHM(605), "10:05");
  assert.equal(WR.formatDecimal(605), "10.08");
  assert.equal(WR.formatJapanese(605), "10時間05分");
  assert.equal(WR.displayTime("09:05:00"), "9:05");
  assert.equal(WR.displayTime(null), "");
  assert.deepEqual(WR.parseMonth("2026-10"), { year: 2026, month: 10 });
  assert.equal(WR.parseMonth("2026-13"), null);
  assert.equal(WR.parseMonth("abc"), null);
  assert.equal(WR.reportTitle("りゅうと", 2026, 9), "稼働記録_りゅうと_2026-09");
  assert.equal(WR.COMPANY_NAME, "株式会社LOCLE");
  assert.equal(WR.formatJpDate("2026-11-01"), "2026年11月1日(日)");
});
