// 祝日の計算(public/jp-holidays.js)のテスト。稼働報告書で土日祝に色を付けるために使う
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { holidaysOf, holidayName } = require("../public/jp-holidays.js");

test("2026年は、毎日の送信の判定に使っている api/crm.js の一覧と完全に一致する", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "api", "crm.js"), "utf8");
  const start = src.indexOf("JAPAN_HOLIDAYS_2026");
  const block = src.slice(start, src.indexOf("]);", start));
  const crm = [...block.matchAll(/"(2026-\d\d-\d\d)"/g)].map((m) => m[1]).sort();
  assert.ok(crm.length >= 16);
  assert.deepEqual([...holidaysOf(2026).keys()], crm);
});

test("2025年: 振替休日(2/24・5/6・11/24)を含む", () => {
  assert.deepEqual([...holidaysOf(2025).keys()], [
    "2025-01-01", "2025-01-13", "2025-02-11", "2025-02-23", "2025-02-24", "2025-03-20", "2025-04-29",
    "2025-05-03", "2025-05-04", "2025-05-05", "2025-05-06", "2025-07-21", "2025-08-11", "2025-09-15",
    "2025-09-23", "2025-10-13", "2025-11-03", "2025-11-23", "2025-11-24",
  ]);
});

test("2027年: 春分の日が日曜で翌日が振替休日", () => {
  const h = holidaysOf(2027);
  assert.equal(h.get("2027-03-21"), "春分の日");
  assert.equal(h.get("2027-03-22"), "振替休日");
  assert.equal(h.get("2027-01-11"), "成人の日");
  assert.equal(h.get("2027-10-11"), "スポーツの日");
  assert.equal(h.size, 17);
});

test("国民の休日(敬老の日と秋分の日に挟まれた日)", () => {
  assert.equal(holidayName("2026-09-22"), "国民の休日");
  assert.equal(holidayName("2032-09-21"), "国民の休日");
});

test("2020・2021年はオリンピックの移動に合わせる", () => {
  assert.equal(holidayName("2020-07-24"), "スポーツの日");
  assert.equal(holidayName("2020-08-10"), "山の日");
  assert.equal(holidayName("2020-10-12"), null);
  assert.equal(holidayName("2021-07-23"), "スポーツの日");
  assert.equal(holidayName("2021-08-09"), "振替休日");
});

test("祝日でない日は null", () => {
  assert.equal(holidayName("2026-10-13"), null);
  assert.equal(holidayName("2026-12-25"), null);
  assert.equal(holidayName(""), null);
});
