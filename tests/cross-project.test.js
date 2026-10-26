// プロジェクトをまたいだ二重送信の防止(locle と ozukanzukan で同じ会社に送らない)のテスト。
// lib/domain-utils.js の companyKey・lib/cross-project.js の判定・「あとで送る」の区分・保留や送信待ちへの追加・
// 送信待ちの処理・企業探しの除外を確かめる。lib/db・api/submit-form・api/send-email・lib/discover-ai-filter・
// lib/places-search は require キャッシュで偽物に差し替え、DB・ブラウザ・ネットワークは使わない
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { companyKey } = require("../lib/domain-utils");
const { buildCrossProjectIndex, crossProjectBlock } = require("../lib/cross-project");
const { buildLaterList } = require("../lib/later-status");
const { checkHoldAdd, checkReadyAdd, checkQueueStatusChange } = require("../lib/later-actions");

// ---- 偽物の DB(テストごとに中身を入れ替える) ----
const calls = [];
const db = {};
function resetDb(over = {}) {
  calls.length = 0;
  Object.assign(db, {
    company: null,              // SELECT * FROM companies WHERE id = ?
    other: { companies: [], logs: [], queue: [], scheduled: [], responses: [] }, // もう一方のプロジェクト
    pending: [],                // 送信待ちの処理で読む pending の行
    crossSentUrls: [],          // 企業探しの除外で読む、もう一方の送信済みの会社の URL
  }, over);
}
function fakeSql(strings, ...values) {
  const text = strings.join("?").replace(/\s+/g, " ").trim();
  calls.push({ text, values });
  if (text.startsWith("SELECT id, url, archived FROM companies WHERE project")) return Promise.resolve(db.other.companies);
  if (text.includes("FROM send_logs sl JOIN companies c") && text.includes("GROUP BY sl.company_id, sl.status") && text.includes("IN ('sent', 'uncertain')")) return Promise.resolve(db.other.logs);
  if (text.startsWith("SELECT company_id, status FROM send_queue WHERE project")) return Promise.resolve(db.other.queue);
  if (text.startsWith("SELECT ss.company_id, ss.status FROM scheduled_sends")) return Promise.resolve(db.other.scheduled);
  if (text.startsWith("SELECT sl.company_id, r.classification, r.raw_excerpt")) return Promise.resolve(db.other.responses);
  if (text.startsWith("SELECT DISTINCT c.url FROM companies c JOIN send_logs")) return Promise.resolve(db.crossSentUrls.map((url) => ({ url })));
  if (text.startsWith("SELECT * FROM companies WHERE id")) return Promise.resolve(db.company ? [db.company] : []);
  if (text.startsWith("SELECT id, url, project FROM companies WHERE id")) return Promise.resolve(db.company ? [db.company] : []);
  if (text.startsWith("SELECT * FROM send_queue WHERE status = 'pending'")) return Promise.resolve(db.pending);
  if (text.startsWith("UPDATE send_queue SET status = 'sending'")) return Promise.resolve([{ id: values[0] }]);
  return Promise.resolve([]);
}
fakeSql.query = async () => [];
const sendCalls = [];
function stub(rel, exports) {
  const p = require.resolve(path.join(__dirname, "..", rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
stub("lib/db", { sql: fakeSql, getSettings: async () => ({ skip_weekends_holidays: "false" }), isExcludedDomain: async () => false });
stub("api/submit-form", async (req, res) => { sendCalls.push(req.body); return res.status(200).json({ ok: true }); });
stub("api/send-email", async (req, res) => { sendCalls.push(req.body); return res.status(200).json({ ok: true }); });
stub("lib/discover-ai-filter", { filterResultsWithAIDetailed: async (results) => ({ results, error: null }), filterResultsWithAI: async (r) => r });
stub("lib/places-search", { searchPlacesAPI: async () => Object.assign([], { debug: {} }), excludedPlaceType: () => null, outsidePrefecture: () => false });
const crm = require("../api/crm");
const discover = require("../api/discover");

function call(handler, req) {
  return new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(d) { resolve({ status: this.statusCode, body: d }); return this; }, setHeader() {} };
    handler({ headers: {}, query: {}, body: {}, ...req }, res);
  });
}

// ozukanzukan の会社 2000(送信済み)が、locle の会社 500 と同じ会社
const OZ_SENT = {
  companies: [{ id: 2000, url: "https://www.example-kogyo.co.jp/company/", archived: false }],
  logs: [{ company_id: 2000, status: "sent", count: 1, last_sent_at: "2026-10-14T09:00:00Z" }],
  queue: [], scheduled: [], responses: [],
};
const LOCLE_COMPANY = { id: 500, name: "株式会社エグザンプル工業", url: "https://example-kogyo.co.jp/", project: "locle", status: "researched", archived: false, automatable: "true" };

// ---- 1. companyKey ----
test("1. companyKey: www・サブドメインの違いは同じ会社。地域型の .jp・共用のサービスはホスト名で比べる", () => {
  assert.equal(companyKey("https://www.example-kogyo.co.jp/company/"), "example-kogyo.co.jp");
  assert.equal(companyKey("https://recruit.example-kogyo.co.jp/"), "example-kogyo.co.jp");
  assert.equal(companyKey("https://example-kogyo.co.jp"), "example-kogyo.co.jp");
  // 地域型の .jp(別々の町役場を「gunma.jp」にまとめない)
  assert.equal(companyKey("https://www.town.ora.gunma.jp/"), "town.ora.gunma.jp");
  assert.notEqual(companyKey("https://www.town.ora.gunma.jp/"), companyKey("https://www.town.oizumi.gunma.jp/"));
  assert.notEqual(companyKey("https://www.city.osaka.lg.jp/"), companyKey("https://www.city.sakai.lg.jp/"));
  // 共用のサービス
  assert.notEqual(companyKey("https://shop-a.wixsite.com/top"), companyKey("https://shop-b.wixsite.com/top"));
  assert.notEqual(companyKey("https://kazelinefujimi.sakura.ne.jp/"), companyKey("https://other.sakura.ne.jp/"));
  assert.equal(companyKey("not a url"), "");
});

// ---- 2. 止める条件 ----
test("2. 止める条件: 送信記録(sent・uncertain)・送信待ち・保留・予約・返信。failed だけ・登録だけでは止めない", () => {
  const base = { project: "ozukanzukan", companies: OZ_SENT.companies };
  const block = (rows) => crossProjectBlock(LOCLE_COMPANY, buildCrossProjectIndex({ ...base, ...rows }));
  assert.match(block({ sendLogSummary: [{ company_id: 2000, status: "sent", count: 1 }] }).reason, /群馬お仕事図鑑で同じ会社に送信済み/);
  assert.ok(block({ sendLogSummary: [{ company_id: 2000, status: "uncertain", count: 1 }] }));
  assert.ok(block({ queueRows: [{ company_id: 2000, status: "on_hold" }] }));
  assert.ok(block({ queueRows: [{ company_id: 2000, status: "pending" }] }));
  assert.ok(block({ scheduledRows: [{ company_id: 2000, status: "pending" }] }));
  assert.ok(block({ responses: [{ company_id: 2000, classification: "interested", raw_excerpt: "ご連絡ありがとうございます" }] }));
  assert.equal(block({ sendLogSummary: [{ company_id: 2000, status: "failed", count: 3 }] }), null, "failed だけ");
  assert.equal(block({}), null, "登録だけ");
  assert.equal(block({ queueRows: [{ company_id: 2000, status: "dismissed" }] }), null, "却下の行");
  // アーカイブ済みの会社: 送信記録は止める、送信待ちの行は止めない
  const arch = { project: "ozukanzukan", companies: [{ ...OZ_SENT.companies[0], archived: true }] };
  assert.ok(crossProjectBlock(LOCLE_COMPANY, buildCrossProjectIndex({ ...arch, sendLogSummary: [{ company_id: 2000, status: "sent", count: 1 }] })));
  assert.equal(crossProjectBlock(LOCLE_COMPANY, buildCrossProjectIndex({ ...arch, queueRows: [{ company_id: 2000, status: "on_hold" }] })), null);
  // 送信待ちの処理では pending を「入っている」とみなさない
  assert.equal(crossProjectBlock(LOCLE_COMPANY, buildCrossProjectIndex({ ...base, queueRows: [{ company_id: 2000, status: "pending" }], activeStatuses: ["sending", "on_hold"] })), null);
  // 違う会社は止めない
  assert.equal(crossProjectBlock({ ...LOCLE_COMPANY, url: "https://another.co.jp/" }, buildCrossProjectIndex({ ...base, sendLogSummary: [{ company_id: 2000, status: "sent", count: 1 }] })), null);
});

// ---- 3. 「あとで送る」 ----
test("3. 「あとで送る」: 警告 cross_project が付き、「送れる」と★候補から外れる", () => {
  const crossProject = buildCrossProjectIndex({ project: "ozukanzukan", companies: OZ_SENT.companies, sendLogSummary: OZ_SENT.logs });
  const companies = [LOCLE_COMPANY, { ...LOCLE_COMPANY, id: 501, name: "株式会社別会社", url: "https://another.co.jp/" }];
  const { items } = buildLaterList({ companies, sendLogSummary: [], responses: [], queueRows: [], scheduledRows: [], senderProfileValid: true, crossProject, now: Date.now() });
  const it = items.find((x) => x.company_id === 500);
  assert.ok(it.warnings.some((w) => w.code === "cross_project" && w.level === "danger"));
  assert.equal(it.category, "blocked");
  assert.ok(it.category_codes.includes("cross_project"));
  assert.equal(it.auto_candidate, null);
  const other = items.find((x) => x.company_id === 501);
  assert.ok(!other.warnings.some((w) => w.code === "cross_project"), "違う会社には付かない");
  // crossProject を渡さない(今までの呼び方)ときは何も変わらない
  const plain = buildLaterList({ companies, sendLogSummary: [], responses: [], queueRows: [], scheduledRows: [], senderProfileValid: true, now: Date.now() });
  assert.ok(!plain.items.some((x) => x.warnings.some((w) => w.code === "cross_project")));
});

// ---- 4. 保留・送れる・再開・自動の積み込み ----
test("4. 保留への追加・送れるへの追加・送信待ちへ戻す操作・自動の積み込みが cross_project で断る", async () => {
  const crossBlock = { reason: "群馬お仕事図鑑で同じ会社に送信済み(企業ID 2000)", ids: [2000] };
  const variant = { id: 3, name: "初回", project: "locle" };
  const company = { ...LOCLE_COMPANY, official_name: null };
  const hold = checkHoldAdd({ company, project: "locle", variant, records: null, activeRows: [], crossBlock, now: Date.now() });
  assert.equal(hold.ok, false);
  assert.equal(hold.type, "cross_project");
  const ready = checkReadyAdd({ company, project: "locle", variant, records: null, activeRows: [], history: { failed: 0, stopped: 0 }, crossBlock, now: Date.now() });
  assert.equal(ready.type, "cross_project");
  for (const from of ["on_hold", "failed"]) {
    const r = checkQueueStatusChange({ row: { id: 1, status: from, company_id: 500, variant_id: 3 }, nextStatus: "pending", company, records: null, otherActiveRows: [], crossBlock, now: Date.now() });
    assert.equal(r.type, "cross_project", from);
  }
  // 送信待ちから外す操作(却下)は止めない
  assert.notEqual(checkQueueStatusChange({ row: { id: 1, status: "on_hold", company_id: 500, variant_id: 3 }, nextStatus: "dismissed", company, records: null, otherActiveRows: [], crossBlock, now: Date.now() }).type, "cross_project");
  // 自動の積み込み(送信待ちリストへの追加の API → queueCompanyForSend)
  resetDb({ company: { ...LOCLE_COMPANY, research_result: { automatable: true } }, other: OZ_SENT });
  const r = await call(crm, { method: "POST", query: { action: "send-queue" }, body: { company_id: 500, variant_id: 3, project: "locle" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.queued, false);
  assert.equal(r.body.reason, "cross_project");
  assert.ok(!calls.some((c) => /^INSERT INTO send_queue/.test(c.text)), "送信待ちに入れない");
});

// ---- 5. 送信待ちの処理 ----
test("5. 送信待ちの処理: 送る直前に止め、送信の処理を呼ばずに却下にする", async () => {
  const SECRET = "a-long-random-test-secret-value";
  process.env.CRON_SECRET = SECRET;
  sendCalls.length = 0;
  resetDb({ company: { id: 500, url: LOCLE_COMPANY.url, project: "locle" }, other: OZ_SENT, pending: [{ id: 77, project: "locle", company_id: 500, variant_id: 3, channel: "form", status: "pending" }] });
  const r = await call(crm, { method: "GET", query: { action: "run-send-queue" }, headers: { authorization: `Bearer ${SECRET}` } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(sendCalls.length, 0, "送信の処理を呼ばない");
  assert.equal(r.body.send_queue.cross_skipped, 1);
  const dismissed = calls.find((c) => /^UPDATE send_queue SET status = 'dismissed'/.test(c.text));
  assert.ok(dismissed, "却下にする");
  assert.match(dismissed.values[0], /^\[二重送信の防止\] 群馬お仕事図鑑で同じ会社に送信済み/);
  // もう一方が pending だけなら止めずに送る(互いに止め合わない)
  sendCalls.length = 0;
  resetDb({ company: { id: 500, url: LOCLE_COMPANY.url, project: "locle" }, other: { ...OZ_SENT, logs: [], queue: [{ company_id: 2000, status: "pending" }] }, pending: [{ id: 78, project: "locle", company_id: 500, variant_id: 3, channel: "form", status: "pending" }] });
  const r2 = await call(crm, { method: "GET", query: { action: "run-send-queue" }, headers: { authorization: `Bearer ${SECRET}` } });
  assert.equal(r2.body.send_queue.cross_skipped, 0);
  assert.equal(sendCalls.length, 1);
  delete process.env.CRON_SECRET;
});

// ---- 6. 企業探し ----
test("6. 企業探し: もう一方のプロジェクトで送信済みの会社を候補から外す", async () => {
  process.env.BRAVE_SEARCH_API_KEY = "test-key";
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ web: { results: [
    { title: "株式会社エグザンプル工業", url: "https://www.example-kogyo.co.jp/" },
    { title: "株式会社別会社", url: "https://another.co.jp/" },
  ] } }) });
  try {
    resetDb({ crossSentUrls: ["https://example-kogyo.co.jp/company/"] });
    const r = await call(discover, { method: "POST", body: { project: "locle", prefecture: "大阪府", city: "堺市", industry: "製造業" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const hosts = r.body.results.map((x) => new URL(x.url).hostname);
    assert.ok(!hosts.some((h) => h.endsWith("example-kogyo.co.jp")), JSON.stringify(hosts));
    assert.ok(hosts.includes("another.co.jp"));
    assert.equal(r.body.excluded_cross_project_count, 1);
    // 読めないときは除外しない(企業探しを止めない)
    resetDb({ crossSentUrls: [] });
    const r2 = await call(discover, { method: "POST", body: { project: "locle", prefecture: "大阪府", city: "堺市", industry: "製造業" } });
    assert.equal(r2.body.excluded_cross_project_count, 0);
  } finally {
    global.fetch = realFetch;
    delete process.env.BRAVE_SEARCH_API_KEY;
  }
});

// ---- 7. 同じプロジェクトの中の重複防止は変わらない ----
test("7. 同じプロジェクトの中の今の重複防止は変わらない(crossBlock が無ければ今までどおり)", () => {
  const variant = { id: 3, name: "初回", project: "locle" };
  const company = { ...LOCLE_COMPANY, official_name: null };
  const dup = checkHoldAdd({ company, project: "locle", variant, records: null, activeRows: [{ id: 9, status: "on_hold" }], crossBlock: null, now: Date.now() });
  assert.equal(dup.type, "already_queued");
  assert.equal(checkHoldAdd({ company, project: "locle", variant, records: null, activeRows: [], now: Date.now() }).ok, true, "crossBlock を渡さない呼び方");
  // もう一方の記録の表は、同じプロジェクトの会社を含めない(loadCrossProjectIndex はもう一方だけを読む)
  const idx = buildCrossProjectIndex({ project: "ozukanzukan", companies: [], sendLogSummary: [{ company_id: 500, status: "sent", count: 1 }] });
  assert.equal(idx.size, 0);
});
