// lib/discover-backlog.js
//
// 企業探しで見つけたが、その日の上限・時間切れで登録・リサーチしなかった候補の「持ち越し」(discover_backlog)。
// 以前は残りの候補も discovered_urls に記録されて自動の検索から7日間外れ、その「業種×市町村」も30日間使われない
// ため、実質しばらく消えていた(2026-10-15〜23 の7回で、見つけた96件のうち78件)。
// 残った候補を持ち越しに入れ、翌日以降の自動パイプラインは検索の前に持ち越しから処理する。
// ここは DB に触らない判定だけを置く(読み書きは api/crm.js)。
//
// 持ち越しの行: { id, project, url_hostname, url, name, candidate, search_label, found_at, status, processed_at }
//   status: pending(待ち) / processed(処理した) / known(処理する前に companies に登録されていた) / expired(期限切れ)

const BACKLOG_TTL_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

// api/discover.js の getHostname() と同じ形(www. を除いたホスト名)
function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return String(url || "");
  }
}

// 待ちの行を、処理するもの・すでに登録済みのもの・期限切れに分ける(古い順)。
//   rows: status = 'pending' の行 / knownHosts: companies に登録済みのホスト名(Set)
// 戻り値: { process: [行], known: [行], expired: [行] }
function selectBacklog({ rows, knownHosts = new Set(), now = Date.now(), ttlDays = BACKLOG_TTL_DAYS }) {
  const out = { process: [], known: [], expired: [] };
  const seen = new Set();
  const sorted = (rows || [])
    .filter((r) => r && r.status === "pending")
    .slice()
    .sort((a, b) => new Date(a.found_at) - new Date(b.found_at) || a.id - b.id);
  for (const r of sorted) {
    const host = r.url_hostname || hostnameOf(r.url);
    const foundAt = new Date(r.found_at).getTime();
    if (!Number.isFinite(foundAt) || now - foundAt > ttlDays * DAY_MS) { out.expired.push(r); continue; }
    if (knownHosts.has(host) || seen.has(host)) { out.known.push(r); continue; }
    seen.add(host);
    out.process.push(r);
  }
  return out;
}

// 持ち越しの行を、自動パイプラインの候補の形({ name, url, ... })に戻す
function candidateOf(row) {
  const c = row && row.candidate && typeof row.candidate === "object" ? row.candidate : {};
  return { ...c, name: row.name || c.name, url: row.url || c.url };
}

// 持ち越しに入れる候補(処理しなかった残り)。ホスト名の無いもの・同じホスト名の重複は除く
function leftoverCandidates(candidates, processedCount) {
  const seen = new Set();
  const out = [];
  for (const c of (candidates || []).slice(Math.max(0, processedCount || 0))) {
    if (!c || !c.url) continue;
    const host = hostnameOf(c.url);
    if (!host || seen.has(host)) continue;
    seen.add(host);
    out.push({ candidate: c, url_hostname: host });
  }
  return out;
}

module.exports = { BACKLOG_TTL_DAYS, hostnameOf, selectBacklog, candidateOf, leftoverCandidates };
