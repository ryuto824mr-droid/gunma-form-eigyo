// リサーチ(lib/form-analyzer.js の analyzeForm)が、画像認証の欄があるフォームを CAPTCHA として扱い、
// 自動送信不可にすることの通しテスト(1987 と同じ作り: dt のラベル「画像認証 ※必須」・画像・1行入力の欄)。
// 127.0.0.1 にテスト用ページを立て、本物のブラウザでリサーチする。外部には一切アクセスしない。
// 実行: npm run test:e2e
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");

delete process.env.ANTHROPIC_API_KEY; // 項目対応はキーワード推定で行う(外部APIを呼ばない)
const { analyzeForm } = require("../../lib/form-analyzer");

const PIXEL = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
const page = (body) => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>お問い合わせ</title></head><body><h1>お問い合わせ</h1>${body}</body></html>`;
const row = (dt, input) => `<div class="form-item-box"><dl><dt class="cell1">${dt}</dt><dd class="cell2"><div class="form-item">${input}</div></dd></dl></div>`;
const PAGES = {
  "/imageauth/": page(`<form method="post" action="/done">
    ${row("お名前 ※必須", '<input type="text" name="data[Block59_2][item][13]">')}
    ${row("メールアドレス ※必須", '<input type="email" name="data[Block59_2][item][21][1]">')}
    ${row("内容 ※必須", '<textarea name="data[Block59_2][item][22]"></textarea>')}
    ${row("画像認証 ※必須", `<img src="${PIXEL}" width="120" height="40" alt=""><input type="text" name="data[Block59_2][img_auth]">`)}
    <p><button type="submit">送信</button></p></form>`),
  // メールの確認の再入力・郵便番号がある普通のフォーム
  "/normal/": page(`<form method="post" action="/done">
    ${row("お名前", '<input type="text" name="name">')}
    ${row("郵便番号", '<input type="text" name="zipcode">')}
    ${row("メールアドレス", '<input type="email" name="email">')}
    ${row("メールアドレス（確認用）", '<input type="email" name="email_confirm" placeholder="確認のためもう一度入力してください">')}
    ${row("お問い合わせ内容", '<textarea name="body"></textarea>')}
    <p><button type="submit">送信</button></p></form>`),
};

let server;
let base;
test.before(() => new Promise((resolve) => {
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    const body = PAGES[req.url.split("?")[0]];
    if (!body) { res.statusCode = 404; return res.end(page("")); }
    res.end(body);
  }).listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => server.close());

test("画像認証の欄があるフォームは CAPTCHA として扱い、自動送信不可にする", { timeout: 90000 }, async () => {
  const r = await analyzeForm(base + "/imageauth/");
  assert.equal(r.formFound, true);
  assert.equal(r.captchaDetected, true);
  assert.deepEqual(r.imageAuthFields, ["画像認証 ※必須"]);
  assert.equal(r.automatable, false);
  assert.ok(r.analysisWarnings.includes("⚠ 画像認証などの欄(画像認証 ※必須)があるため、自動送信できません"));
});

test("メールの確認の再入力・郵便番号だけのフォームは CAPTCHA にしない", { timeout: 90000 }, async () => {
  const r = await analyzeForm(base + "/normal/");
  assert.equal(r.captchaDetected, false);
  assert.deepEqual(r.imageAuthFields, []);
  assert.equal(r.automatable, true);
});
