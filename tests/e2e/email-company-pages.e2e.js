// リサーチ(lib/form-analyzer.js の analyzeForm)の通しテスト:
//   - 問い合わせページにアドレスが無くても、トップページのフッター・会社概要ページのアドレスを拾う(難読化を含む)
//   - 会社のサイトと違うドメインのアドレスには警告を付ける(個人・プロバイダのメールは警告しない)
//   - 問い合わせページ探しで、関係のない外部ドメインのリンクを選ばない
// 127.0.0.1 にテスト用ページを立て、本物のブラウザでリサーチする。外部には一切アクセスしない
// (外部のリンクは .invalid のドメインで、選ばれなければ開かれない)。
// 実行: npm run test:e2e
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");

delete process.env.ANTHROPIC_API_KEY; // 項目対応はキーワード推定で行う(外部APIを呼ばない)
const { analyzeForm } = require("../../lib/form-analyzer");

const page = (title, body) => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
const FORM = `<form method="post" action="/done">
  <p><label>会社名<input type="text" name="company"></label></p>
  <p><label>お名前<input type="text" name="name"></label></p>
  <p><label>メールアドレス<input type="email" name="email"></label></p>
  <p><label>お問い合わせ内容<textarea name="body"></textarea></label></p>
  <p><button type="submit">送信</button></p></form>`;
const PAGES = {
  // A社: 外部(掲載サイトのヘルプ)の「お問い合わせ」リンクが先にある。アドレスはトップのフッターに難読化で
  "/a/": page("A社", `<nav><a href="http://help.portal-example.invalid/contact">お問い合わせ</a>
    <a href="/a/company/">会社概要</a> <a href="/a/contact/">お問い合わせ</a></nav><h1>A社</h1>
    <footer>株式会社A TEL 027-000-0000 MAIL: info★a-kaisha.co.jp</footer>`),
  "/a/contact/": page("お問い合わせ", FORM),
  "/a/company/": page("会社概要", "<h1>会社概要</h1><p>代表者 山田太郎</p>"),
  // B社: アドレスは会社概要ページだけ(個人・プロバイダのメール)
  "/b/": page("B社", `<nav><a href="/b/company/">会社概要</a> <a href="/b/contact/">お問い合わせ</a></nav><h1>B社</h1>`),
  "/b/contact/": page("お問い合わせ", FORM),
  "/b/company/": page("会社概要", "<h1>会社概要</h1><p>代表者 鈴木一郎</p><p>E-mail: b-kaisha（あっと）gmail.com</p>"),
};

let server;
let base;
const visited = [];
test.before(() => new Promise((resolve) => {
  server = http.createServer((req, res) => {
    const p = req.url.split("?")[0];
    visited.push(p);
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (!PAGES[p]) { res.statusCode = 404; return res.end(page("Not Found", "")); }
    res.end(PAGES[p]);
  }).listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => server.close());

test("外部のヘルプへのリンクを選ばず自社の問い合わせを開き、トップのフッターの難読化されたアドレスを拾う(別ドメインの警告付き)", { timeout: 90000 }, async () => {
  const r = await analyzeForm(base + "/a/");
  assert.equal(r.formPageUrl, base + "/a/contact/");
  assert.equal(r.formFound, true);
  // テスト用のサイト(127.0.0.1)と違うドメインのアドレスなので警告が付く
  assert.equal(r.extractedEmail, "info@a-kaisha.co.jp");
  assert.equal(r.emailDomainMismatch, true);
  assert.ok(r.analysisWarnings.includes("⚠ メールアドレスのドメインが会社のサイトと違います(a-kaisha.co.jp)"));
  assert.equal(r.companyInfo.email_candidates, undefined, "メールの候補は company_info に保存しない");
});

test("会社概要ページだけにあるアドレスも拾う。個人・プロバイダのメールは別ドメインの警告を付けない", { timeout: 90000 }, async () => {
  visited.length = 0;
  const r = await analyzeForm(base + "/b/");
  assert.equal(r.extractedEmail, "b-kaisha@gmail.com");
  assert.equal(r.emailDomainMismatch, false);
  assert.ok(visited.includes("/b/company/"), "会社概要ページを開いている");
});
