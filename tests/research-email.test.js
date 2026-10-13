// リサーチ(api/companies/[id]/research.js)のメールアドレスの保存のテスト:
// 登録済みのアドレスが仮(入力例)なら未設定と同じに扱い、本物が見つかれば置き換えて元の値を
// research_result.previousEmail に残す。本物が登録済みなら従来どおり変えない。
// lib/db・lib/form-analyzer はrequireキャッシュで偽物に差し替える
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const updates = [];
let company;
let found;
function fakeSql(strings, ...v) {
  const text = strings.join("?").replace(/\s+/g, " ").trim();
  if (text.startsWith("SELECT * FROM companies WHERE id")) return Promise.resolve([company]);
  if (text.startsWith("UPDATE companies")) {
    updates.push(v);
    return Promise.resolve([{ ...company, research_result: JSON.parse(v[1]), status: v[2], email: v[3] }]);
  }
  return Promise.resolve([]);
}
function stub(rel, exports) {
  const p = require.resolve(path.join(__dirname, "..", rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
stub("lib/db", { sql: fakeSql });
stub("lib/form-analyzer", { analyzeForm: async () => ({ ...found }) });
delete process.env.ANTHROPIC_API_KEY;
const handler = require("../api/companies/[id]/research");

function call() {
  return new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(d) { resolve({ status: this.statusCode, body: d }); return this; } };
    handler({ method: "POST", query: { id: String(company.id) } }, res);
  });
}
const FOUND = { formFound: true, automatable: true, formPageUrl: "https://x.jp/contact/", forms: [{}], analysisWarnings: [] };
const reset = (email, extracted) => {
  updates.length = 0;
  company = { id: 292, url: "https://x.jp/", email, company_info: null, company_tags: [] };
  found = { ...FOUND, extractedEmail: extracted };
};

test("仮アドレスが登録済みで本物が見つかれば置き換え、元の値を previousEmail に残す", async () => {
  reset("toiawase@domain.co.jp", "info@morimaru.co.jp");
  const r = await call();
  assert.equal(r.status, 200);
  assert.equal(updates[0][3], "info@morimaru.co.jp");
  assert.equal(JSON.parse(updates[0][1]).previousEmail, "toiawase@domain.co.jp");
});

test("仮アドレスが登録済みで本物が見つからなければ、仮アドレスのまま(削除しない)", async () => {
  reset("sample@gku.co.jp", null);
  await call();
  assert.equal(updates[0][3], "sample@gku.co.jp");
  assert.equal(JSON.parse(updates[0][1]).previousEmail, undefined);
});

test("本物のアドレスが登録済みなら、別のアドレスが見つかっても従来どおり変えない", async () => {
  reset("info@kaisha.co.jp", "sales@kaisha.co.jp");
  await call();
  assert.equal(updates[0][3], "info@kaisha.co.jp");
  assert.equal(JSON.parse(updates[0][1]).previousEmail, undefined);
});

test("未登録なら従来どおり、見つかったアドレスを保存する", async () => {
  reset(null, "info@kaisha.co.jp");
  await call();
  assert.equal(updates[0][3], "info@kaisha.co.jp");
});
