// リサーチ(lib/form-analyzer.js の analyzeForm)の問い合わせページ探しの通しテスト。
// トップページで「Information」「HARUHOMEのリフォーム(/reform/)」のリンクが「お問い合わせ(/toi/)」より
// 先にあっても、/toi/ を開いてフォームを見つけること(2026-10: 1988 が /reform/ を開いてフォームなしになった)。
// 127.0.0.1 にテスト用ページを立て、本物のブラウザでリサーチする。外部には一切アクセスしない。
// 実行: npm run test:e2e
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");

delete process.env.ANTHROPIC_API_KEY; // 項目対応はキーワード推定で行う(外部APIを呼ばない)
const { analyzeForm } = require("../../lib/form-analyzer");

const page = (title, body) => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
const PAGES = {
  "/": page("HARUHOME", `<nav>
    <a href="/information/">Information</a>
    <a href="/reform/">HARUHOMEのリフォーム</a>
    <a href="/works/">施工例</a>
    <a href="/toi/">お問い合わせ</a>
  </nav><h1>注文住宅</h1>`),
  // お問い合わせのリンクが無いトップページ(メニューの読み込みが遅れた場合の形)
  "/nolink/": page("HARUHOME", `<nav><a href="/information/">Information</a><a href="/reform/">リフォーム</a></nav><h1>注文住宅</h1>`),
  "/information/": page("Information", "<p>お知らせ一覧</p>"),
  "/reform/": page("リフォーム", "<p>リフォームのご案内</p>"),
  "/works/": page("施工例", "<p>施工例</p>"),
  "/toi/": page("お問い合わせ", `<form method="post" action="/done">
    <p><label>会社名<input type="text" name="your-company"></label></p>
    <p><label>お名前<input type="text" name="your-name"></label></p>
    <p><label>メールアドレス<input type="email" name="your-email"></label></p>
    <p><label>お問い合わせ内容<textarea name="your-message"></textarea></label></p>
    <p><button type="submit">送信</button></p></form>`),
};

let server;
let base;
const visited = [];
test.before(() => new Promise((resolve) => {
  server = http.createServer((req, res) => {
    const path = req.url.split("?")[0];
    visited.push(path);
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (!PAGES[path]) { res.statusCode = 404; return res.end(page("Not Found", "")); }
    res.end(PAGES[path]);
  }).listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => server.close());

test("Information・/reform/ が先にあっても /toi/ を開いてフォームを見つける", { timeout: 90000 }, async () => {
  visited.length = 0;
  const r = await analyzeForm(base + "/");
  assert.equal(r.formPageUrl, base + "/toi/");
  assert.equal(r.formFound, true);
  assert.equal(r.automatable, true);
  assert.ok(!visited.includes("/reform/"), "リフォームのページは開かない");
});

test("お問い合わせのリンクが無いときも、/reform/ や /information/ を問い合わせページとして選ばない", { timeout: 90000 }, async () => {
  visited.length = 0;
  const r = await analyzeForm(base + "/nolink/");
  assert.equal(r.formFound, false);
  assert.equal(r.formPageUrl, base + "/nolink/");
  assert.ok(!visited.includes("/reform/") && !visited.includes("/information/"));
});
