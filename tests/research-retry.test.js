// リサーチの1回だけのやり直し(lib/research-retry.js と api/companies/[id]/research.js)のテスト。
// lib/db と lib/form-analyzer をrequireキャッシュで偽物に差し替え、DB・ブラウザ・ネットワークは使わない
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { shouldRetryResearch, RETRY_MIN_REMAINING_MS } = require("../lib/research-retry");

const err = (m) => new Error(m);

test("ブラウザ側の一時的な失敗だけ、残り時間が十分ならやり直す", () => {
  for (const m of [
    "net::ERR_INSUFFICIENT_RESOURCES at https://www.sgrc.co.jp/en/company-en/",
    "Attempted to use detached Frame '0255D5EC8273B73B7'",
    "Navigating frame was detached",
    "Protocol error (DOM.describeNode): Target closed",
    "Execution context was destroyed, most likely because of a navigation.",
  ]) {
    assert.equal(shouldRetryResearch(err(m), 50000), true, m);
    assert.equal(shouldRetryResearch(err(m), RETRY_MIN_REMAINING_MS - 1), false, `${m}(残り時間不足)`);
  }
});

test("サイト側の問題はやり直さない", () => {
  for (const m of [
    "net::ERR_NAME_NOT_RESOLVED at https://example.invalid/",
    "net::ERR_CONNECTION_REFUSED at https://x/",
    "net::ERR_CERT_DATE_INVALID at https://x/",
    "Navigation timeout of 20000 ms exceeded",
    "urlの形式が正しくありません",
  ]) {
    assert.equal(shouldRetryResearch(err(m), 50000), false, m);
  }
  assert.equal(shouldRetryResearch(null, 50000), false);
});

// ---- api/companies/[id]/research.js(偽のDB・偽のリサーチ) ----
const updates = [];
function fakeSql(strings, ...v) {
  const text = strings.join("?").replace(/\s+/g, " ").trim();
  if (text.startsWith("SELECT * FROM companies WHERE id")) {
    return Promise.resolve([{ id: 2106, url: "https://www.sgrc.co.jp/", email: null, company_info: null, company_tags: [] }]);
  }
  if (text.startsWith("UPDATE companies")) {
    updates.push({ text, values: v });
    return Promise.resolve([{ id: 2106, status: v[2] }]);
  }
  return Promise.resolve([]);
}
let analyzeCalls = 0;
let script = [];
function stub(rel, exports) {
  const p = require.resolve(path.join(__dirname, "..", rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
stub("lib/db", { sql: fakeSql });
stub("lib/form-analyzer", {
  analyzeForm: async () => {
    analyzeCalls++;
    const step = script.shift();
    if (step instanceof Error) throw step;
    return step;
  },
});
delete process.env.ANTHROPIC_API_KEY; // 訴求ポイントの推定(外部API)は呼ばない
const handler = require("../api/companies/[id]/research");

function call() {
  return new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(d) { resolve({ status: this.statusCode, body: d }); return this; } };
    handler({ method: "POST", query: { id: "2106" } }, res);
  });
}
const FOUND = { formFound: true, automatable: true, formPageUrl: "https://www.sgrc.co.jp/contact/", forms: [{}], analysisWarnings: [] };
const reset = (steps) => { updates.length = 0; analyzeCalls = 0; script = steps; };

test("資源不足で失敗したら1回だけやり直し、成功した結果を保存する(やり直したことを警告に残す)", async () => {
  reset([err("net::ERR_INSUFFICIENT_RESOURCES at https://www.sgrc.co.jp/"), { ...FOUND }]);
  const r = await call();
  assert.equal(r.status, 200);
  assert.equal(analyzeCalls, 2);
  const [u] = updates;
  assert.equal(u.values[2], "researched", "status");
  const saved = JSON.parse(u.values[1]);
  assert.ok(saved.analysisWarnings.some((w) => /再試行/.test(w) && /ERR_INSUFFICIENT_RESOURCES/.test(w)));
});

test("やり直しも失敗したら、従来どおり error として保存する(やり直しは1回だけ)", async () => {
  reset([err("Attempted to use detached Frame 'A'"), err("Attempted to use detached Frame 'B'"), { ...FOUND }]);
  await call();
  assert.equal(analyzeCalls, 2);
  assert.equal(updates[0].values[2], "error");
  assert.match(JSON.parse(updates[0].values[1]).error, /detached Frame 'B'/);
});

test("サイト側の問題(ドメインが無い)はやり直さず error", async () => {
  reset([err("net::ERR_NAME_NOT_RESOLVED at https://x/"), { ...FOUND }]);
  await call();
  assert.equal(analyzeCalls, 1);
  assert.equal(updates[0].values[2], "error");
  assert.equal(JSON.parse(updates[0].values[1]).errorType, "connection_error");
});

test("1回目で成功したらやり直さない", async () => {
  reset([{ ...FOUND }]);
  await call();
  assert.equal(analyzeCalls, 1);
  assert.equal(updates[0].values[2], "researched");
});
