// リサーチ(lib/form-analyzer.js の analyzeForm)のAIによる欄の判定の通しテスト。
// 127.0.0.1 にテスト用ページを立て、本物のブラウザでリサーチする。Anthropic APIへの呼び出しだけを
// 偽物に差し替え(global.fetch)、外部には一切アクセスしない。
// 実行: npm run test:e2e
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");

process.env.ANTHROPIC_API_KEY = "test-key";
const { analyzeForm } = require("../../lib/form-analyzer");

// ページ全体が1つの<form>のサイト(2161型): サイト内検索の欄 + 150字前後の欄名 + 都道府県のチェックボックス47個(2074型)
const LONG = "dnn$ctr527$ViewMailForm$grdMain$PageID3$repCategory$ctl01$repField$ItemID17$fldValue$";
const prefs = Array.from({ length: 47 }, (_, i) => `<label><input type="checkbox" name="tdfk_cd[]" value="${i + 1}">県${i + 1}</label>`).join("");
const PAGE = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>お問い合わせ</title></head><body>
<form method="post" action="/done">
  <div><input type="text" name="dnn$ctr805$SearchInput$txtSearch" id="dnn_ctr805_SearchInput_txtSearch"><button type="button">検索</button></div>
  <h1>お問い合わせ</h1>
  <p><label for="c">会社名</label><input type="text" id="c" name="${LONG}txtCompany"></p>
  <p><label for="n">お名前</label><input type="text" id="n" name="${LONG}txtName"></p>
  <p><label for="m">メールアドレス</label><input type="email" id="m" name="${LONG}txtMail"></p>
  <p>対応エリア${prefs}</p>
  <p><label for="b">お問い合わせ内容</label><textarea id="b" name="${LONG}txtMultilineTextBox"></textarea></p>
  <p><button type="submit">送信</button></p>
</form></body></html>`;

let server;
let base;
let reply;
let prompts = [];
const realFetch = global.fetch;
test.before(() => new Promise((resolve) => {
  global.fetch = async (url, init) => {
    if (!String(url).startsWith("https://api.anthropic.com/")) return realFetch(url, init);
    prompts.push(JSON.parse(init.body).messages[0].content);
    return reply();
  };
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(PAGE);
  }).listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => {
  global.fetch = realFetch;
  delete process.env.ANTHROPIC_API_KEY;
  server.close();
});
const ok = (text, stop = "end_turn") => () => ({ ok: true, status: 200, json: async () => ({ stop_reason: stop, content: [{ type: "text", text }] }) });

test("大きなフォームでも、AIに渡すのは短い一覧だけで、AIの判定を全部の欄に戻して自動送信可にする", { timeout: 90000 }, async () => {
  prompts = [];
  // AIに渡る欄: 会社名(0)・お名前(1)・メール(2)・都道府県47個をまとめたもの(3)・本文(4)
  reply = ok('[{"i":0,"r":"company_name","c":"h"},{"i":1,"r":"contact_person_name","c":"h"},{"i":2,"r":"email","c":"h"},{"i":3,"r":"other","c":"m"},{"i":4,"r":"message","c":"h"}]');
  const r = await analyzeForm(base + "/");
  assert.equal(r.mappingSource, "ai");
  assert.equal(r.aiError, null);
  assert.equal(r.automatable, true);
  assert.equal(r.fieldMapping.length, 1 + 3 + 47 + 1, "元の全部の欄");
  assert.equal(r.fieldMapping.find((m) => m.name === `${LONG}txtMultilineTextBox`).role, "message");
  assert.equal(r.fieldMapping.find((m) => /SearchInput/.test(m.name)).role, "other");
  assert.ok(!r.analysisWarnings.some((w) => w.startsWith("⚠")));
  assert.equal(prompts.length, 1);
  assert.ok(!prompts[0].includes(LONG), "長い欄名はそのまま渡さない");
  assert.ok(!prompts[0].includes("txtSearch"), "検索の欄は渡さない");
  assert.equal((prompts[0].match(/tdfk_cd/g) || []).length, 1, "選択肢47個は1つにまとめる");
});

test("クレジット不足なら簡易判定で続け、目立つ警告と失敗の種類を残す", { timeout: 90000 }, async () => {
  reply = () => ({ ok: false, status: 400, text: async () => '{"error":{"message":"Your credit balance is too low to access the Anthropic API."}}' });
  const r = await analyzeForm(base + "/");
  assert.equal(r.mappingSource, "heuristic");
  assert.equal(r.aiErrorKind, "credit");
  assert.ok(r.analysisWarnings.includes("⚠ AI判定に失敗(クレジット不足)。簡易判定で代用しました"));
  assert.equal(r.formFound, true);
});

test("出力が上限で切れたら、そのことを記録する", { timeout: 90000 }, async () => {
  reply = ok('[{"i":0,"r":"company_name","c":"h"},{"i":1,', "max_tokens");
  const r = await analyzeForm(base + "/");
  assert.equal(r.aiErrorKind, "truncated");
  assert.match(r.aiError, /AIの出力が上限\(2000トークン\)で切れました/);
  assert.ok(r.analysisWarnings.includes("⚠ AI判定に失敗(出力が上限で切れた)。簡易判定で代用しました"));
});
