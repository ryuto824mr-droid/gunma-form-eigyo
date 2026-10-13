// lib/search-rotation.js
//
// 自動パイプラインの企業探しの検索条件を、「業種×市町村」の組み合わせから日ごとに選ぶ。
// 以前は「製造業・地域の指定なし」で毎日同じ検索をしていたため、新しい候補が1日0〜1件しか
// 見つからなかった(2026-09〜10の17回で合計18件)。手動で市町村を指定した初回の検索では3〜28件
// 見つかっていたため、まだ検索していない組み合わせを優先し、検索済みの組み合わせは間隔を空けて使う。
//
// rotation(自動パイプラインの設定 search_params.rotation):
//   { prefecture: "群馬県", industries: ["製造業", ...], cities: ["高崎市", ...], min_days_between: 30 }
// history: search_history の行 [{ industry, prefecture, city, result_count, searched_at }]

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MIN_DAYS = 30;

const keyOf = (industry, prefecture, city) => `${industry || ""}|${prefecture || ""}|${city || ""}`;

// 組み合わせの並び順。業種と市町村の両方が日ごとに変わるよう、斜めの順番(業種の位置+市町村の位置が
// 小さい順。同じなら市町村の位置が小さい順)に並べる
function orderedCombos(industries, cities) {
  const combos = [];
  industries.forEach((industry, i) => cities.forEach((city, j) => combos.push({ industry, city, i, j })));
  return combos.sort((a, b) => (a.i + a.j) - (b.i + b.j) || a.j - b.j);
}

// 次に使う検索条件を選ぶ。戻り値: { industry, prefecture, city, reason } または null(選べる組み合わせが無い)
//   exclude: 同じ実行の中ですでに試した条件([{ industry, prefecture, city }])
function pickSearchCondition({ rotation, history, now = Date.now(), exclude = [] }) {
  if (!rotation || typeof rotation !== "object") return null;
  const industries = (Array.isArray(rotation.industries) ? rotation.industries : []).map((s) => String(s).trim()).filter(Boolean);
  const cities = (Array.isArray(rotation.cities) ? rotation.cities : []).map((s) => String(s).trim()).filter(Boolean);
  if (industries.length === 0 || cities.length === 0) return null;
  const prefecture = String(rotation.prefecture || "").trim();
  const minDays = Number.isFinite(Number(rotation.min_days_between)) && Number(rotation.min_days_between) >= 0
    ? Number(rotation.min_days_between) : DEFAULT_MIN_DAYS;

  // 組み合わせごとの最後の検索(日時と新しい候補の数)
  const last = new Map();
  for (const h of history || []) {
    const at = new Date(h.searched_at).getTime();
    if (!Number.isFinite(at)) continue;
    const k = keyOf(h.industry, h.prefecture, h.city);
    const prev = last.get(k);
    if (!prev || at > prev.at) last.set(k, { at, count: Number(h.result_count) || 0 });
  }
  const excluded = new Set((exclude || []).map((e) => keyOf(e.industry, e.prefecture, e.city)));
  const combos = orderedCombos(industries, cities)
    .map((c) => ({ ...c, key: keyOf(c.industry, prefecture, c.city) }))
    .filter((c) => !excluded.has(c.key));

  // ① まだ検索していない組み合わせ(並び順の先頭から)
  const fresh = combos.find((c) => !last.has(c.key));
  if (fresh) return { industry: fresh.industry, prefecture, city: fresh.city, reason: "未検索" };

  // ② 前回から min_days_between 日以上空いた組み合わせ。前回の新しい候補が多い順、同じなら古い順
  const due = combos
    .map((c) => ({ ...c, ...last.get(c.key) }))
    .filter((c) => now - c.at >= minDays * DAY_MS)
    .sort((a, b) => b.count - a.count || a.at - b.at);
  if (due.length > 0) {
    const c = due[0];
    return { industry: c.industry, prefecture, city: c.city, reason: `前回から${Math.floor((now - c.at) / DAY_MS)}日(前回の新しい候補${c.count}件)` };
  }
  return null;
}

module.exports = { pickSearchCondition, orderedCombos };
