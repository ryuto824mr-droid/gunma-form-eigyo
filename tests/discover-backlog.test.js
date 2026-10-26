// 企業探しの持ち越し(discover_backlog)のテスト。上限・時間切れで処理しなかった候補を翌日以降に回し、
// 翌日の自動パイプラインは検索の前に持ち越しから処理すること(lib/discover-backlog.js・api/crm.js)。
// lib/db・api/discover・api/companies・api/companies/[id]/research・api/submit-form・api/send-email は
// requireキャッシュで偽物に差し替え、持ち越しの表は手元の配列で真似る。DB・ブラウザ・ネットワークは使わない
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { selectBacklog, leftoverCandidates, candidateOf, hostnameOf } = require("../lib/discover-backlog");

const DAY = 24 * 60 * 60 * 1000;
const calls = [];
const state = {};
function reset(over = {}) {
  calls.length = 0;
  Object.assign(state, {
    config: { project: "ozukanzukan", enabled: true, variant_id: 7, daily_limit: 3, search_params: { industry: "製造業", rotation: ROT } },
    backlog: [],
    companies: [],
    discoverReplies: [],
    discoverCalls: [],
    registered: [],
    sendCalls: [],
    backlogFails: false,
  }, over);
  process.env.CRON_SECRET = SECRET;
}
const ROT = { prefecture: "群馬県", industries: ["製造業", "建設・不動産"], cities: ["高崎市", "太田市"], min_days_between: 30 };
const SECRET = "a-long-random-test-secret-value";
let nextBacklogId = 1;

function fakeSql(strings, ...values) {
  const text = strings.join("?").replace(/\s+/g, " ").trim();
  calls.push({ text, values });
  if (/discover_backlog/.test(text) && state.backlogFails) return Promise.reject(new Error("relation \"discover_backlog\" does not exist"));
  if (text.includes("FROM auto_pipeline_config WHERE project")) return Promise.resolve(values[0] === "ozukanzukan" ? [state.config] : []);
  if (text.includes("SUM(researched_count)")) return Promise.resolve([{ done: 0 }]);
  if (text.startsWith("CREATE TABLE IF NOT EXISTS discover_backlog")) return Promise.resolve([]);
  if (text.startsWith("SELECT id, project, url_hostname") && text.includes("FROM discover_backlog")) {
    return Promise.resolve(state.backlog.filter((r) => r.project === values[0] && r.status === "pending").map((r) => ({ ...r })));
  }
  if (text.startsWith("SELECT url FROM companies WHERE project")) return Promise.resolve(state.companies.map((url) => ({ url })));
  if (text.startsWith("UPDATE discover_backlog SET status")) {
    const [status, ids] = values;
    for (const r of state.backlog) if (ids.includes(r.id) && r.status === "pending") r.status = status;
    return Promise.resolve([]);
  }
  if (text.startsWith("INSERT INTO discover_backlog")) {
    const [project, host, url, name, candidate, label] = values;
    const old = state.backlog.find((r) => r.project === project && r.url_hostname === host);
    if (old) {
      if (old.status !== "expired") return Promise.resolve([]);
      Object.assign(old, { status: "pending", found_at: new Date().toISOString(), url, name, candidate: JSON.parse(candidate), search_label: label });
      return Promise.resolve([{ id: old.id }]);
    }
    const row = { id: nextBacklogId++, project, url_hostname: host, url, name, candidate: JSON.parse(candidate), search_label: label, found_at: new Date().toISOString(), status: "pending" };
    state.backlog.push(row);
    return Promise.resolve([{ id: row.id }]);
  }
  return Promise.resolve([]);
}
fakeSql.query = async () => [];
function stub(rel, exports) {
  const p = require.resolve(path.join(__dirname, "..", rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
stub("lib/db", { sql: fakeSql, getSettings: async () => ({ skip_weekends_holidays: "false" }), isExcludedDomain: async () => false });
stub("api/discover", async (req, res) => {
  state.discoverCalls.push(req.body);
  return res.status(200).json(state.discoverReplies.shift() || { configured: true, results: [] });
});
let nextCompanyId = 9001;
stub("api/companies", async (req, res) => {
  state.registered.push(req.body.url);
  return res.status(201).json({ id: nextCompanyId++ });
});
stub("api/companies/[id]/research", async (req, res) => res.status(200).json({ id: Number(req.query.id), name: "株式会社テスト", email: null, research_result: { automatable: true } }));
stub("api/submit-form", async (req, res) => { state.sendCalls.push(req.body); return res.status(200).json({}); });
stub("api/send-email", async (req, res) => { state.sendCalls.push(req.body); return res.status(200).json({}); });
const handler = require("../api/crm");

function call(action = "run-auto-pipeline", headers = {}) {
  return new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(d) { resolve({ status: this.statusCode, body: d }); return this; }, setHeader() {} };
    handler({ method: action === "run-discover" ? "GET" : "POST", query: { action }, headers, body: {} }, res);
  });
}
const oz = (r) => r.body.results.find((x) => x.project === "ozukanzukan");
const candidates = (n, prefix = "c") => Array.from({ length: n }, (_, i) => ({ name: `株式会社${prefix}${i}`, url: `https://${prefix}${i}.example.jp/` }));
const backlogRow = (i, over = {}) => ({
  id: nextBacklogId++, project: "ozukanzukan", url_hostname: `b${i}.example.jp`, url: `https://b${i}.example.jp/`, name: `株式会社b${i}`,
  candidate: { name: `株式会社b${i}`, url: `https://b${i}.example.jp/` }, search_label: "製造業×太田市",
  found_at: new Date(Date.now() - (10 - i) * 60000).toISOString(), status: "pending", ...over,
});
const queueInserts = () => calls.filter((c) => /^INSERT INTO send_queue/.test(c.text));

// ---- 判定だけ(lib/discover-backlog.js) ----

test("判定: 古い順に選び、登録済み・期限切れ(14日超)・同じホスト名の重複を分ける", () => {
  const now = Date.now();
  const rows = [
    { id: 3, url_hostname: "c.jp", url: "https://c.jp/", found_at: new Date(now - 1 * DAY).toISOString(), status: "pending" },
    { id: 1, url_hostname: "a.jp", url: "https://a.jp/", found_at: new Date(now - 3 * DAY).toISOString(), status: "pending" },
    { id: 2, url_hostname: "old.jp", url: "https://old.jp/", found_at: new Date(now - 15 * DAY).toISOString(), status: "pending" },
    { id: 4, url_hostname: "known.jp", url: "https://known.jp/", found_at: new Date(now - 2 * DAY).toISOString(), status: "pending" },
    { id: 5, url_hostname: "a.jp", url: "https://www.a.jp/x", found_at: new Date(now - 1 * DAY).toISOString(), status: "pending" },
    { id: 6, url_hostname: "done.jp", url: "https://done.jp/", found_at: new Date(now - 1 * DAY).toISOString(), status: "processed" },
  ];
  const sel = selectBacklog({ rows, knownHosts: new Set(["known.jp"]), now });
  assert.deepEqual(sel.process.map((r) => r.id), [1, 3]);
  assert.deepEqual(sel.known.map((r) => r.id).sort(), [4, 5]);
  assert.deepEqual(sel.expired.map((r) => r.id), [2]);
  assert.deepEqual(leftoverCandidates([{ url: "https://a.jp/" }, { url: "https://x.jp/" }, { url: "https://www.x.jp/p" }, { name: "URLなし" }], 1).map((l) => l.url_hostname), ["x.jp"]);
  assert.equal(hostnameOf("https://www.example.co.jp/a"), "example.co.jp");
  assert.deepEqual(candidateOf({ name: "株式会社A", url: "https://a.jp/", candidate: { name: "旧", url: "https://a.jp/", snippet: "s" } }), { name: "株式会社A", url: "https://a.jp/", snippet: "s" });
});

// ---- 自動パイプライン ----

test("1. 候補15件・上限3なら、残りの12件を持ち越しに入れる(どの検索で見つけたかも残す)", async () => {
  reset();
  state.discoverReplies = [{ configured: true, results: candidates(15) }];
  const r = await call();
  assert.equal(oz(r).researched, 3);
  assert.equal(state.backlog.length, 12);
  assert.deepEqual(state.backlog.map((b) => b.url_hostname), candidates(15).slice(3).map((c) => hostnameOf(c.url)));
  assert.ok(state.backlog.every((b) => b.status === "pending" && b.search_label === "製造業×高崎市"));
  assert.equal(oz(r).backlog.carried_over, 12);
});

test("2. 翌日は持ち越しから処理し、上限に届いたら検索しない", async () => {
  reset({ backlog: [0, 1, 2, 3, 4].map((i) => backlogRow(i)) });
  const r = await call();
  assert.equal(state.discoverCalls.length, 0, "企業探しを呼ばない");
  assert.equal(oz(r).search, null);
  assert.equal(oz(r).search_skipped, "持ち越しの処理で今日の上限に達した");
  assert.deepEqual(state.registered, ["https://b0.example.jp/", "https://b1.example.jp/", "https://b2.example.jp/"], "古い順に3社");
  assert.deepEqual(state.backlog.map((b) => b.status), ["processed", "processed", "processed", "pending", "pending"]);
  assert.equal(queueInserts()[0].values[queueInserts()[0].values.length - 1], "[保留] 自動パイプラインで追加(検索: 製造業×太田市・持ち越し)");
});

test("3. 持ち越しが上限より少なければ、全部処理してから検索し、残りをまた持ち越す", async () => {
  reset({ config: { ...state.config, daily_limit: 5 }, backlog: [0, 1].map((i) => backlogRow(i)) });
  state.discoverReplies = [{ configured: true, results: candidates(5) }];
  const r = await call();
  assert.equal(state.discoverCalls.length, 1);
  assert.deepEqual(state.registered, ["https://b0.example.jp/", "https://b1.example.jp/", "https://c0.example.jp/", "https://c1.example.jp/", "https://c2.example.jp/"]);
  assert.equal(oz(r).researched, 5);
  assert.deepEqual(state.backlog.filter((b) => b.status === "pending").map((b) => b.url_hostname), ["c3.example.jp", "c4.example.jp"]);
});

test("4. companies にすでにある会社は「登録済み」にしてリサーチしない", async () => {
  reset({ config: { ...state.config, daily_limit: 5 }, backlog: [backlogRow(0), backlogRow(1)], companies: ["https://www.b0.example.jp/"] });
  const r = await call();
  assert.ok(!state.registered.includes("https://b0.example.jp/"));
  assert.ok(state.registered.includes("https://b1.example.jp/"));
  assert.equal(state.backlog[0].status, "known");
  assert.equal(oz(r).backlog.known, 1);
});

test("5. 14日を過ぎた持ち越しは処理せず「期限切れ」にする", async () => {
  reset({ backlog: [backlogRow(0, { found_at: new Date(Date.now() - 15 * DAY).toISOString() })] });
  const r = await call();
  assert.equal(state.registered.length, 0);
  assert.equal(state.backlog[0].status, "expired");
  assert.equal(oz(r).backlog.expired, 1);
  assert.ok(state.discoverCalls.length >= 1, "持ち越しが無くなったので検索する(候補0件なので、次の組み合わせでもう1回探す)");
});

test("6. 同じ候補を2回持ち越しても1行のまま(期限切れの行だけ待ちに戻す)", async () => {
  reset();
  state.discoverReplies = [{ configured: true, results: candidates(5) }];
  await call();
  assert.equal(state.backlog.length, 2);
  // 次の日: 前日の持ち越しは処理済み(1行だけ期限切れ)にして検索させ、同じ候補をまた見つけたことにする
  state.config = { ...state.config, daily_limit: 1 };
  state.backlog.forEach((b) => { b.status = "processed"; });
  state.backlog[1].status = "expired";
  state.discoverReplies = [{ configured: true, results: candidates(5) }];
  const r = await call();
  const hosts = state.backlog.map((b) => b.url_hostname);
  assert.equal(new Set(hosts).size, hosts.length, "同じホスト名の行は増えない");
  assert.equal(state.backlog.find((b) => b.url_hostname === "c4.example.jp").status, "pending", "期限切れは待ちに戻る");
  assert.equal(state.backlog.find((b) => b.url_hostname === "c3.example.jp").status, "processed", "処理済みはそのまま");
  assert.ok(oz(r).backlog.carried_over >= 1);
});

test("7. 持ち越しの読み書きに失敗しても、今までどおり検索して処理する", async () => {
  reset({ backlogFails: true });
  state.discoverReplies = [{ configured: true, results: candidates(5) }];
  const r = await call();
  assert.equal(state.discoverCalls.length, 1);
  assert.equal(oz(r).researched, 3);
  assert.equal(oz(r).queued, 3);
  assert.match(oz(r).backlog.error, /持ち越しの読み込みに失敗/);
  assert.equal(oz(r).error, null, "企業探しの結果はエラーにしない");
});

test("8. AIの絞り込みに失敗した日は、検索の結果を登録も持ち越しもしない", async () => {
  reset();
  state.discoverReplies = [{ configured: true, results: [], ai_filter_error: "Claude APIエラー (status 400): Your credit balance is too low" }];
  const r = await call();
  assert.equal(state.registered.length, 0);
  assert.equal(state.backlog.length, 0);
  assert.match(oz(r).error, /^企業探しのAIの絞り込みに失敗した/);
  assert.equal(queueInserts().length, 0);
});

test("9. 送信の処理は一度も呼ばず、送信待ちリストへは保留(on_hold)だけで積む", async () => {
  reset({ backlog: [backlogRow(0)] });
  state.discoverReplies = [{ configured: true, results: candidates(4) }];
  await call();
  assert.equal(state.sendCalls.length, 0);
  assert.ok(queueInserts().length > 0);
  assert.ok(queueInserts().every((c) => /'on_hold'/.test(c.text)));
  assert.ok(!calls.some((c) => /UPDATE send_queue SET status = 'sending'|FROM scheduled_sends/.test(c.text)));
});

test("10. 企業探しだけの処理(run-discover)でも持ち越しから処理する", async () => {
  reset({ config: { ...state.config, daily_limit: 2 }, backlog: [0, 1, 2].map((i) => backlogRow(i)) });
  const r = await call("run-discover", { authorization: `Bearer ${SECRET}` });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const o = r.body.results.find((x) => x.project === "ozukanzukan");
  assert.equal(o.backlog.processed, 2);
  assert.equal(o.search_skipped, "持ち越しの処理で今日の上限に達した");
  assert.equal(state.sendCalls.length, 0);
  delete process.env.CRON_SECRET;
});
