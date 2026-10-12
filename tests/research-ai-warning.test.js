// 訴求タグの推定(lib/appeal-point-classifier.js)の失敗を「該当なし」と区別して返すこと、
// リサーチ(api/companies/[id]/research.js)がその失敗を記録に目立つ警告として残すことのテスト。
// lib/db・lib/form-analyzer はrequireキャッシュで偽物に差し替え、Anthropic APIは global.fetch を偽物にする
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const updates = [];
const usageLogs = [];
let company;
let row; // 更新後の行(本物のDBと同じく、後の更新は前の更新の結果を引き継ぐ)
function fakeSql(strings, ...v) {
  const text = strings.join("?").replace(/\s+/g, " ").trim();
  if (text.startsWith("SELECT * FROM companies WHERE id")) return Promise.resolve([company]);
  if (text.startsWith("INSERT INTO api_usage_logs")) { usageLogs.push(v); return Promise.resolve([]); }
  if (text.startsWith("UPDATE companies SET research_result")) {
    updates.push({ kind: "warning", values: v });
    row = { ...row, research_result: JSON.parse(v[0]) };
    return Promise.resolve([row]);
  }
  if (text.startsWith("UPDATE companies SET company_tags")) {
    updates.push({ kind: "tags", values: v });
    row = { ...row, company_tags: JSON.parse(v[0]) };
    return Promise.resolve([row]);
  }
  if (text.startsWith("UPDATE companies")) {
    updates.push({ kind: "main", values: v });
    // 本物のDBと同じく、research_result は解析済みのオブジェクトで返る
    row = { ...company, research_result: JSON.parse(v[1]), status: v[2], company_info: v[4] ? JSON.parse(v[4]) : null };
    return Promise.resolve([row]);
  }
  return Promise.resolve([]);
}
function stub(rel, exports) {
  const p = require.resolve(path.join(__dirname, "..", rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
stub("lib/db", { sql: fakeSql });
const FOUND = { formFound: true, automatable: true, formPageUrl: "https://example.co.jp/contact/", forms: [{}], mappingSource: "ai", analysisWarnings: ["診断(起動前): …"] };
stub("lib/form-analyzer", { analyzeForm: async () => ({ ...FOUND }) });
const { classifyAppealPointsDetailed, classifyAppealPoints } = require("../lib/appeal-point-classifier");
const handler = require("../api/companies/[id]/research");

let reply;
let fetchCount = 0;
const realFetch = global.fetch;
test.before(() => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  global.fetch = async () => { fetchCount++; return reply(); };
});
test.after(() => {
  global.fetch = realFetch;
  delete process.env.ANTHROPIC_API_KEY;
});
const okReply = (text) => () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 3 } }) });
const CREDIT = () => ({ ok: false, status: 400, text: async () => '{"error":{"message":"Your credit balance is too low to access the Anthropic API."}}' });
const INFO = { business_description: "射出成形", hiring_status: { hasHiringPage: true } };

function reset(info = INFO) {
  updates.length = 0;
  usageLogs.length = 0;
  fetchCount = 0;
  company = { id: 2124, name: "東亜工業", url: "https://example.co.jp/", email: null, company_info: info, company_tags: ["業種:製造業"] };
}
function call() {
  return new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(d) { resolve({ status: this.statusCode, body: d }); return this; } };
    handler({ method: "POST", query: { id: "2124" } }, res);
  });
}

test("訴求タグ: 失敗(クレジット不足・通信・形式)は理由を返し、「該当なし」は失敗にしない", async () => {
  reset();
  reply = CREDIT;
  let r = await classifyAppealPointsDetailed(company);
  assert.deepEqual(r.points, []);
  assert.match(r.error, /status 400.*credit balance/);

  reply = () => { throw new Error("fetch failed"); };
  r = await classifyAppealPointsDetailed(company);
  assert.match(r.error, /^通信エラー: fetch failed/);

  reply = okReply("該当なしです");
  r = await classifyAppealPointsDetailed(company);
  assert.match(r.error, /JSONとして解析できませんでした/);

  reply = okReply("[]");
  r = await classifyAppealPointsDetailed(company);
  assert.deepEqual(r, { points: [], error: null }, "AIが「該当なし」と答えたのは失敗ではない");

  reply = okReply('["若手活躍", "存在しない選択肢"]');
  assert.deepEqual(await classifyAppealPoints(company), ["若手活躍"], "従来の関数は配列だけを返す");
});

test("訴求タグ: 判定材料が無い・キーが無い場合はAIを呼ばず、失敗にもしない", async () => {
  reset({});
  reply = CREDIT;
  assert.deepEqual(await classifyAppealPointsDetailed(company), { points: [], error: null });
  assert.equal(fetchCount, 0);
  delete process.env.ANTHROPIC_API_KEY;
  reset();
  assert.deepEqual(await classifyAppealPointsDetailed(company), { points: [], error: null });
  assert.equal(fetchCount, 0);
  process.env.ANTHROPIC_API_KEY = "test-key";
});

test("リサーチ: 訴求タグの推定に失敗したら、記録に目立つ警告と失敗の種類を残す(リサーチの結果は変えない)", async () => {
  reset();
  reply = CREDIT;
  const r = await call();
  assert.equal(r.status, 200);
  assert.deepEqual(updates.map((u) => u.kind), ["main", "warning"]);
  const saved = JSON.parse(updates[1].values[0]);
  assert.equal(saved.appealErrorKind, "credit");
  assert.match(saved.appealError, /credit balance/);
  assert.deepEqual(saved.analysisWarnings, ["診断(起動前): …", "⚠ 訴求タグの推定に失敗(クレジット不足)"]);
  assert.equal(saved.formFound, true, "リサーチの結果はそのまま");
  assert.equal(r.body.status, "researched");
  assert.equal(r.body.research_result.appealErrorKind, "credit", "応答にも警告入りの記録を返す");
});

test("リサーチ: 訴求タグが付いた場合・「該当なし」の場合は、従来どおり警告を付けない", async () => {
  reset();
  reply = okReply('["若手活躍"]');
  let r = await call();
  assert.deepEqual(updates.map((u) => u.kind), ["main", "tags"]);
  assert.deepEqual(r.body.company_tags, ["業種:製造業", "訴求:若手活躍"]);
  assert.ok(!r.body.research_result.analysisWarnings.some((w) => /訴求タグ/.test(w)));

  reset();
  reply = okReply("[]");
  r = await call();
  assert.deepEqual(updates.map((u) => u.kind), ["main"]);
  assert.equal(r.body.research_result.appealError, undefined);
});
