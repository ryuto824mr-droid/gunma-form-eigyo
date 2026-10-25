// 保留から送信待ちへ自動で移す行の決め方(lib/hold-release.js)のテスト。DB・ブラウザ・ネットワークは使わない
const test = require("node:test");
const assert = require("node:assert/strict");
const { selectHoldReleases, businessDaysBetween, isEnabled, AUTO_PIPELINE_HOLD_PREFIX } = require("../lib/hold-release");

const ON = { auto_release_hold: "true" };
// 2026-10-27(火) 18:17 JST
const NOW = new Date("2026-10-27T09:17:00Z").getTime();
const holidays = new Set(["2026-11-03", "2026-11-23"]);
const isHoliday = (d) => holidays.has(d);

function hold(id, companyId, createdJst, over = {}) {
  return {
    source: "queue", state: "on_hold", source_id: id, company_id: companyId, channel: "form",
    date: new Date(`${createdJst}+09:00`).toISOString(),
    error_message: `${AUTO_PIPELINE_HOLD_PREFIX}(検索: 建設・不動産×高崎市)`,
    auto_candidate: { ok: true, reasons: [] }, category: "ready",
    ...over,
  };
}

test("設定: \"true\" のときだけ「入」。未設定・空・false 等はすべて「切」", () => {
  assert.equal(isEnabled({ auto_release_hold: "true" }), true);
  assert.equal(isEnabled({ auto_release_hold: " TRUE " }), true);
  for (const s of [{}, null, undefined, { auto_release_hold: "" }, { auto_release_hold: "false" }, { auto_release_hold: "1" }, { auto_release_hold: "on" }]) {
    assert.equal(isEnabled(s), false, JSON.stringify(s));
  }
});

test("「切」のときは何も移さない(条件に合う行があっても)", () => {
  const items = [hold(1, 10, "2026-10-23T18:17:00")];
  for (const settings of [{}, { auto_release_hold: "false" }]) {
    const r = selectHoldReleases({ settings, items, now: NOW, isHoliday });
    assert.deepEqual(r.release, []);
    assert.match(r.stopped, /設定が切/);
  }
});

test("営業日の数え方: 土日・祝日は数えない", () => {
  const t = (s) => new Date(`${s}+09:00`).getTime();
  assert.equal(businessDaysBetween(t("2026-10-26T18:00:00"), t("2026-10-27T18:00:00"), isHoliday), 1, "月→火");
  assert.equal(businessDaysBetween(t("2026-10-27T09:00:00"), t("2026-10-27T23:00:00"), isHoliday), 0, "同じ日");
  assert.equal(businessDaysBetween(t("2026-10-23T18:00:00"), t("2026-10-25T18:00:00"), isHoliday), 0, "金→日(土日は数えない)");
  assert.equal(businessDaysBetween(t("2026-10-23T18:00:00"), t("2026-10-26T18:00:00"), isHoliday), 1, "金→月");
  assert.equal(businessDaysBetween(t("2026-11-02T18:00:00"), t("2026-11-03T18:00:00"), isHoliday), 0, "月→祝日の火");
  assert.equal(businessDaysBetween(t("2026-11-02T18:00:00"), t("2026-11-04T18:00:00"), isHoliday), 1, "月→祝日明けの水");
});

test("「入」: 自動パイプラインの保留で、1営業日たち、自動の候補に合格した行だけを移す", () => {
  const items = [
    hold(1, 10, "2026-10-26T18:17:00"),                                     // 月 → 火で1営業日: 移す
    hold(2, 11, "2026-10-27T09:00:00"),                                     // 今日: まだ
    hold(3, 12, "2026-10-26T18:17:00", { error_message: "[保留] 「あとで送る」画面から追加" }), // 人が保留にした
    hold(4, 13, "2026-10-26T18:17:00", { auto_candidate: { ok: false, reasons: ["宛名が不確か"] } }),
    hold(5, 14, "2026-10-26T18:17:00"),                                     // 県外
    hold(6, 15, "2026-10-26T18:17:00"),                                     // 同じ企業が送信待ちにある
    { source: "queue", state: "queued", source_id: 50, company_id: 15 },
  ];
  const r = selectHoldReleases({ settings: ON, items, now: NOW, isHoliday, prefectureBlock: new Map([[14, "会社概要の住所が群馬県ではない(長野県)"]]) });
  assert.equal(r.stopped, null);
  assert.deepEqual(r.release, [{ queue_id: 1, company_id: 10 }]);
  const why = Object.fromEntries(r.skipped.map((s) => [s.queue_id, s.reason]));
  assert.match(why[2], /1営業日たっていない/);
  assert.match(why[3], /人が保留にした/);
  assert.match(why[4], /自動の候補ではない\(宛名が不確か\)/);
  assert.match(why[5], /群馬県ではない/);
  assert.match(why[6], /ほかに送信待ち/);
});

test("「入」でも止まる場合: 土日・祝日 / 今日の送信が上限 / 直近の失敗が半分を超える / 1日の移す上限", () => {
  const items = [hold(1, 10, "2026-10-26T18:17:00"), hold(2, 11, "2026-10-26T18:17:00")];
  const sat = new Date("2026-10-31T09:17:00Z").getTime();
  assert.match(selectHoldReleases({ settings: ON, items, now: sat, isHoliday }).stopped, /土日・祝日/);
  assert.match(selectHoldReleases({ settings: ON, items, now: new Date("2026-11-03T09:17:00Z").getTime(), isHoliday }).stopped, /土日・祝日/);
  assert.match(selectHoldReleases({ settings: ON, items, now: NOW, isHoliday, todaySendCount: 20, dailySendLimit: 20 }).stopped, /上限\(20件\)/);
  assert.match(selectHoldReleases({ settings: ON, items, now: NOW, isHoliday, recentReleased: [{ status: "failed" }, { status: "failed" }, { status: "sent" }] }).stopped, /失敗が半分を超えている\(2\/3\)/);
  // 失敗が半分ちょうど・結果が1件だけなら止めない
  assert.equal(selectHoldReleases({ settings: ON, items, now: NOW, isHoliday, recentReleased: [{ status: "failed" }, { status: "sent" }] }).stopped, null);
  assert.equal(selectHoldReleases({ settings: ON, items, now: NOW, isHoliday, recentReleased: [{ status: "failed" }] }).stopped, null);
  // 1日に移す上限(初期5件。設定で変えられる)
  const one = selectHoldReleases({ settings: { ...ON, auto_release_hold_daily_limit: "1" }, items, now: NOW, isHoliday });
  assert.deepEqual(one.release.map((x) => x.queue_id), [1]);
  assert.match(one.skipped.find((s) => s.queue_id === 2).reason, /上限/);
  assert.match(selectHoldReleases({ settings: ON, items, now: NOW, isHoliday, releasedToday: 5 }).stopped, /移す上限\(5件\)/);
});
