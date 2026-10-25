// 各ページの上部の説明と、初めて開いたときの案内(public/nav-menu.js)の表示の通しテスト。
// 127.0.0.1 で public/ を配り、API には空の答えを返す(DB・本番には一切つながない)。
// 実行: npm run test:e2e
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

const PUBLIC = path.join(__dirname, "..", "..", "public");
let server;
let browser;
let base;

test.before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      res.setHeader("content-type", "application/json");
      return res.end("[]");
    }
    const file = path.join(PUBLIC, url.pathname === "/" ? "index.html" : url.pathname);
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) { res.statusCode = 404; return res.end(); }
    const type = file.endsWith(".html") ? "text/html; charset=utf-8" : file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "application/octet-stream";
    res.setHeader("content-type", type);
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
});
test.after(async () => {
  if (browser) await browser.close();
  if (server) server.close();
});

test("初めて開くと案内が出て、役割を選んで「はじめる」を押すと、次からは出ない", { timeout: 60000 }, async () => {
  const page = await browser.newPage();
  await page.goto(`${base}/help.html`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#onboarding .onboarding-role");
  const roles = await page.$$eval("#onboarding .onboarding-role strong", (els) => els.map((e) => e.textContent));
  assert.deepEqual(roles, ["管理者", "営業担当", "全員"]);
  await page.click('#onboarding .onboarding-role[data-role="sales"]');
  await page.waitForSelector("#onboarding .onboarding-done");
  const text = await page.$eval("#onboarding", (e) => e.innerText);
  assert.match(text, /営業担当の方へ/);
  assert.match(text, /送れたか不明/);
  assert.ok(await page.$('#onboarding a[href="/help.html#role-sales"]'));
  await page.click("#onboarding .onboarding-done");
  assert.equal(await page.$("#onboarding"), null);
  assert.equal(await page.evaluate(() => localStorage.getItem("gfe_role")), "sales");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".page-nav .nav-hamburger-btn");
  assert.equal(await page.$("#onboarding"), null, "2回目は出ない");
  // メニューの「はじめての案内」で開き直せる
  await page.click("#navHamburgerBtn");
  await page.click('#navDrawer [data-page="onboarding"]');
  await page.waitForSelector("#onboarding .onboarding-role");
  await page.close();
});

test("各ページの上部に説明が出て、閉じると小さな「このページの説明」だけになり、押すとまた出る", { timeout: 60000 }, async () => {
  const page = await browser.newPage();
  // 案内は見たことにしておく
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem("gfe_onboarding_v1", "1"); } catch (e) {} });
  await page.goto(`${base}/later.html`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#pageIntro");
  const introText = await page.$eval("#pageIntro", (e) => e.innerText);
  assert.match(introText, /このページでできること（あとで送る）/);
  assert.ok(await page.$('#pageIntro a[href="/help.html#later"]'));
  assert.equal(await page.$("#onboarding"), null);
  await page.click("#pageIntro .page-intro-close");
  assert.equal(await page.$eval("#pageIntro", (e) => e.hidden), true);
  assert.equal(await page.$eval(".page-intro-mini", (e) => e.hidden), false);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".page-intro-mini");
  assert.equal(await page.$eval("#pageIntro", (e) => e.hidden), true, "閉じたことを覚えている");
  await page.click(".page-intro-mini");
  assert.equal(await page.$eval("#pageIntro", (e) => e.hidden), false);
  await page.close();
});
