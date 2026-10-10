// リサーチ(lib/form-analyzer.js の analyzeForm)が、サイト内検索の欄を問い合わせフォームと誤認しないこと、
// 必須の欄(本文 + 会社名かお名前)がそろわないフォームを自動送信不可(理由付き)にすることの通しテスト。
// 127.0.0.1 にテスト用ページを立て、本物のブラウザでリサーチする。外部には一切アクセスしない。
// 実行: npm run test:e2e
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");

delete process.env.ANTHROPIC_API_KEY; // 項目対応はキーワード推定で行う(外部APIを呼ばない)
const { analyzeForm } = require("../../lib/form-analyzer");

const searchBox = `<form action="/search" method="get" class="site-search"><input type="text" name="kw" id="kw" placeholder="キーワードを入力"><button>検索</button></form>`;
const pageOf = (title, body) => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${title}</title></head><body><header>${searchBox}</header><h1>${title}</h1>${body}</body></html>`;

const PAGES = {
  // 検索欄 + 本物の問い合わせフォーム
  both: pageOf("お問い合わせ", `<form method="post" action="/done">
    <p><label>お名前<input type="text" name="your-name"></label></p>
    <p><label>メールアドレス<input type="email" name="your-email"></label></p>
    <p><label>お問い合わせ内容<textarea name="your-message"></textarea></label></p>
    <p><button type="submit">送信</button></p></form>`),
  // 検索欄だけ
  search_only: pageOf("会社案内", "<p>当社は群馬県の会社です。</p>"),
  // 本文の欄が無いフォーム(資料請求のような形)
  no_message: pageOf("資料請求", `<form method="post" action="/done">
    <p><label>お名前<input type="text" name="name"></label></p>
    <p><label>メールアドレス<input type="email" name="email"></label></p>
    <p><label>電話番号<input type="tel" name="tel"></label></p>
    <p><button type="submit">送信</button></p></form>`),
};

let server;
let base;
test.before(() => new Promise((resolve) => {
  server = http.createServer((req, res) => {
    const key = req.url.split("/")[1];
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (!PAGES[key]) { res.statusCode = 404; return res.end("<html><body>not found</body></html>"); }
    res.end(PAGES[key]);
  }).listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => server.close());

test("検索欄と本物のフォームがあるページ: 検索欄を除き、本物のフォームで自動送信できる", { timeout: 90000 }, async () => {
  const r = await analyzeForm(`${base}/both/`);
  assert.equal(r.formFound, true);
  assert.equal(r.forms.length, 1, "検索欄は候補から除く");
  assert.ok(r.forms[0].fields.some((f) => f.name === "your-message"));
  assert.equal(r.automatable, true);
  assert.equal(r.automatableBlockedReason, null);
});

test("検索欄しか無いページ: フォームなし", { timeout: 90000 }, async () => {
  const r = await analyzeForm(`${base}/search_only/`);
  assert.equal(r.formFound, false);
  assert.equal(r.automatable, false);
});

test("本文の欄が無いフォーム: フォームはあるが自動送信不可で、理由を残す", { timeout: 90000 }, async () => {
  const r = await analyzeForm(`${base}/no_message/`);
  assert.equal(r.formFound, true);
  assert.equal(r.automatable, false);
  assert.equal(r.automatableBlockedReason, "本文の欄を特定できない");
});
