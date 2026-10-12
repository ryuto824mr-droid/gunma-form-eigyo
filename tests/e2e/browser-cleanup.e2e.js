// ブラウザの後始末(lib/browser.js)と、リサーチの診断の記録(lib/form-analyzer.js)の通しテスト。
// 本物のブラウザ(ローカル)を使う。アクセスするのは 127.0.0.1 のテスト用ページだけ。
// 実行: npm run test:e2e
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const http = require("http");
const { launchBrowser, closeBrowserSafely } = require("../../lib/browser");

delete process.env.ANTHROPIC_API_KEY; // 外部APIは呼ばない
const { analyzeForm } = require("../../lib/form-analyzer");

const profileDirs = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("research-chrome-") && !n.startsWith("research-chrome-test-"));

let server;
let base;
test.before(() => new Promise((resolve) => {
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>お問い合わせ</title></head><body>
      <form method="post" action="/done">
      <p><label>お名前<input type="text" name="name"></label></p>
      <p><label>メールアドレス<input type="email" name="email"></label></p>
      <p><label>お問い合わせ内容<textarea name="message"></textarea></label></p>
      <p><button type="submit">送信</button></p></form></body></html>`);
  }).listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => server.close());

test("従来の起動(オプションなし)は作業用フォルダを作らない(フォーム送信の動きは変わらない)", { timeout: 60000 }, async () => {
  const before = profileDirs().length;
  const browser = await launchBrowser();
  assert.equal(browser.__profileDir, undefined);
  assert.equal(profileDirs().length, before);
  await browser.close();
});

test("作業用フォルダを指定して起動し、確実に閉じると、プロセスが終わりフォルダも消える", { timeout: 60000 }, async () => {
  const browser = await launchBrowser({ isolatedProfile: true });
  const dir = browser.__profileDir;
  assert.ok(fs.existsSync(dir));
  const page = await browser.newPage();
  await page.goto(base + "/");
  const info = await closeBrowserSafely(browser);
  assert.equal(info.closed, true);
  assert.equal(info.profileRemoved, true);
  assert.equal(fs.existsSync(dir), false);
  const proc = browser.process();
  assert.ok(proc.exitCode !== null || proc.signalCode !== null, "プロセスが終わっている");
});

test("ブラウザが落ちた(プロセスが強制終了された)後でも、例外を出さずに後始末する", { timeout: 60000 }, async () => {
  const browser = await launchBrowser({ isolatedProfile: true });
  const dir = browser.__profileDir;
  await browser.newPage();
  browser.process().kill("SIGKILL"); // クラッシュの再現
  await new Promise((r) => setTimeout(r, 500));
  const info = await closeBrowserSafely(browser, { timeoutMs: 3000 });
  assert.equal(info.profileRemoved, true);
  assert.equal(fs.existsSync(dir), false);
});

test("リサーチ: 成功時は起動前・終了後の診断を警告に残し、作業用フォルダを残さない", { timeout: 90000 }, async () => {
  const before = profileDirs().length;
  const r = await analyzeForm(base + "/");
  assert.equal(r.formFound, true);
  const diag = r.analysisWarnings.filter((w) => w.startsWith("診断("));
  assert.equal(diag.length, 2);
  assert.match(diag[0], /^診断\(起動前\): Chromiumプロセス=.* 開いているファイル=.* \/tmp=.*\(作業用フォルダ.*\) 空きメモリ=\d+MB$/);
  assert.match(diag[1], /^診断\(終了後\): .* \/ ブラウザの終了: 正常に終了・作業用フォルダ削除$/);
  assert.equal(profileDirs().length, before, "作業用フォルダが残っていない");
});

test("リサーチ: エラー時は例外に診断を付け、作業用フォルダを残さない", { timeout: 90000 }, async () => {
  const before = profileDirs().length;
  const closed = http.createServer();
  await new Promise((r) => closed.listen(0, "127.0.0.1", r));
  const deadUrl = `http://127.0.0.1:${closed.address().port}/`;
  await new Promise((r) => closed.close(r)); // ポートを閉じて接続できない状態にする
  await assert.rejects(analyzeForm(deadUrl), (err) => {
    assert.match(err.message, /ERR_CONNECTION_REFUSED/);
    assert.equal(err.diagnostics.length, 2);
    assert.match(err.diagnostics[1], /ブラウザの終了: 正常に終了・作業用フォルダ削除/);
    return true;
  });
  assert.equal(profileDirs().length, before);
});
