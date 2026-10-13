// 企業探しの検索条件の順番替え(lib/search-rotation.js)のテスト。DB・ネットワークは使わない
const test = require("node:test");
const assert = require("node:assert/strict");
const { pickSearchCondition, orderedCombos } = require("../lib/search-rotation");

const NOW = Date.parse("2026-10-14T09:00:00Z");
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString();
const ROT = { prefecture: "群馬県", industries: ["製造業", "建設・不動産", "IT・情報通信"], cities: ["高崎市", "前橋市", "太田市"], min_days_between: 30 };
const h = (industry, city, days, count) => ({ industry, prefecture: "群馬県", city, result_count: count, searched_at: daysAgo(days) });

test("並び順は業種と市町村の両方が変わる斜めの順番", () => {
  const order = orderedCombos(ROT.industries, ROT.cities).map((c) => `${c.industry}×${c.city}`);
  assert.deepEqual(order.slice(0, 4), ["製造業×高崎市", "建設・不動産×高崎市", "製造業×前橋市", "IT・情報通信×高崎市"]);
  assert.equal(order.length, 9);
});

test("まだ検索していない組み合わせを優先する(過去の検索は search_history から)", () => {
  assert.deepEqual(pickSearchCondition({ rotation: ROT, history: [], now: NOW }),
    { industry: "製造業", prefecture: "群馬県", city: "高崎市", reason: "未検索" });
  const r = pickSearchCondition({ rotation: ROT, history: [h("製造業", "高崎市", 2, 5), h("建設・不動産", "高崎市", 1, 3)], now: NOW });
  assert.deepEqual([r.industry, r.city, r.reason], ["製造業", "前橋市", "未検索"]);
});

test("同じ実行の中で試した組み合わせは除く", () => {
  const r = pickSearchCondition({ rotation: ROT, history: [], now: NOW, exclude: [{ industry: "製造業", prefecture: "群馬県", city: "高崎市" }] });
  assert.deepEqual([r.industry, r.city], ["建設・不動産", "高崎市"]);
});

test("すべて検索済みなら、間隔が空いた組み合わせのうち前回の新しい候補が多いものを選ぶ", () => {
  const hist = [];
  for (const i of ROT.industries) {
    for (const c of ROT.cities) {
      if (i === "製造業" && c === "太田市") hist.push(h(i, c, 40, 28));
      else if (i === "IT・情報通信" && c === "前橋市") hist.push(h(i, c, 45, 9));
      else hist.push(h(i, c, 5, 1)); // 5日前(まだ使えない)
    }
  }
  const r = pickSearchCondition({ rotation: ROT, history: hist, now: NOW });
  assert.deepEqual([r.industry, r.city], ["製造業", "太田市"], "前回28件の方を先に");
  assert.match(r.reason, /前回から40日\(前回の新しい候補28件\)/);
  // 同じ組み合わせは一番新しい検索で判断する(古い検索で28件でも、5日前に検索していれば使わない)
  const r2 = pickSearchCondition({ rotation: ROT, history: [...hist, h("製造業", "太田市", 5, 0)], now: NOW });
  assert.deepEqual([r2.industry, r2.city], ["IT・情報通信", "前橋市"]);
});

test("間隔が空いた組み合わせが無ければ null(呼び出し元が固定の条件に戻す)", () => {
  const all = [];
  for (const i of ROT.industries) for (const c of ROT.cities) all.push(h(i, c, 10, 3));
  assert.equal(pickSearchCondition({ rotation: ROT, history: all, now: NOW }), null);
  assert.equal(pickSearchCondition({ rotation: { ...ROT, min_days_between: 7 }, history: all, now: NOW }).industry, "製造業");
});

test("設定が無い・一覧が空なら null", () => {
  assert.equal(pickSearchCondition({ rotation: null, history: [], now: NOW }), null);
  assert.equal(pickSearchCondition({ rotation: { industries: [], cities: ["高崎市"] }, history: [], now: NOW }), null);
});
