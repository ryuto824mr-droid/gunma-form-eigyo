// リサーチ(lib/form-analyzer.js の analyzeForm)が、問い合わせページの入力例のアドレス
// (「例: sample@xxx.co.jp」)を拾わず、本物のアドレスを拾うことの通しテスト。
// 127.0.0.1 にテスト用ページを立て、本物のブラウザでリサーチする。外部には一切アクセスしない。
// 実行: npm run test:e2e
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");

delete process.env.ANTHROPIC_API_KEY; // 項目対応はキーワード推定で行う(外部APIを呼ばない)
const { analyzeForm } = require("../../lib/form-analyzer");

const page = (title, extra) => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${title}</title></head>
<body><h1>${title}</h1>
<p><a href="/contact">お問い合わせ</a></p>
${extra.top || ""}
</body></html>`;
const contact = (extra) => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>お問い合わせ</title></head>
<body><h1>お問い合わせ</h1>
<form method="post" action="/done">
<p><label>お名前<input type="text" name="name"></label></p>
<p><label>メールアドレス<input type="email" name="email" placeholder="sample@xxx.co.jp"></label></p>
<p class="note">メールアドレスは半角で入力してください(例: sample@xxx.co.jp)</p>
<p><label>お問い合わせ内容<textarea name="message"></textarea></label></p>
<p><button type="submit">送信</button></p>
</form>
${extra.contact || ""}
</body></html>`;

const SITES = {
  // 入力例と本物の両方がある(本物を拾う)
  both: { top: "", contact: '<p>メールでのお問い合わせ: <a href="mailto:office@takasaki-test-kogyo.co.jp">office@takasaki-test-kogyo.co.jp</a></p>' },
  // 入力例しか無い(拾わない)
  only_example: { top: "", contact: "<p>ひな形: info@mysite.com</p>" },
};

let server;
let base;
test.before(() => new Promise((resolve) => {
  server = http.createServer((req, res) => {
    const [, site, sub] = req.url.split("/");
    const s = SITES[site];
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (!s) { res.statusCode = 404; return res.end(); }
    if (sub === "contact") return res.end(contact(s));
    return res.end(page(`テスト工業(${site})`, s).replace('href="/contact"', `href="/${site}/contact"`));
  }).listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => server.close());

test("入力例(sample@xxx.co.jp)と本物があれば、本物を拾う", { timeout: 90000 }, async () => {
  const r = await analyzeForm(`${base}/both/`);
  assert.equal(r.formFound, true);
  assert.equal(r.extractedEmail, "office@takasaki-test-kogyo.co.jp");
});

test("入力例・ひな形のアドレスしか無ければ、何も拾わない", { timeout: 90000 }, async () => {
  const r = await analyzeForm(`${base}/only_example/`);
  assert.equal(r.formFound, true);
  assert.equal(r.extractedEmail, null);
});
