// 稼働報告書の印刷用ページ(public/work-report.html)の通しテスト。
// 127.0.0.1 で public/ を配り、稼働記録の GET(work-sessions・work-logs)は偽のデータを返す。
// ブラウザで実際に PDF を作り、長い業務内容でも A4 1枚に収まることを確かめる。DB・本番には一切つながない。
// 実行: npm run test:e2e
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

const PUBLIC = path.join(__dirname, "..", "..", "public");
const requests = [];
let longTasks = false;
let server;
let browser;
let base;

// 2026年10月: 平日すべてに 9:00〜18:00(10/2 は2回)、10/30 は勤務中
function sessions() {
  const rows = [];
  for (let d = 1; d <= 31; d++) {
    const date = `2026-10-${String(d).padStart(2, "0")}`;
    const wd = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (wd === 0 || wd === 6 || date === "2026-10-12") continue;
    if (date === "2026-10-02") {
      rows.push({ id: 1, user_name: "りゅうと", date, clock_in: "09:00:00", clock_out: "12:00:00", work_hours: "3.00" });
      rows.push({ id: 2, user_name: "りゅうと", date, clock_in: "13:00:00", clock_out: "18:00:00", work_hours: "5.00" });
    } else if (date === "2026-10-30") {
      rows.push({ id: 3, user_name: "りゅうと", date, clock_in: "09:00:00", clock_out: null, work_hours: null });
    } else {
      rows.push({ id: 10 + d, user_name: "りゅうと", date, clock_in: "09:00:00", clock_out: "18:00:00", work_hours: "9.00" });
    }
  }
  return rows;
}
function logs() {
  const text = longTasks
    ? "企業リストのリサーチと問い合わせフォームの確認、送信結果の確認、議事録の作成、資料の修正、打ち合わせの準備。".repeat(6)
    : "リサーチ";
  return sessions().map((s) => ({ date: `${s.date}T00:00:00.000Z`, tasks_done: text }));
}

test.before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      requests.push({ method: req.method, action: url.searchParams.get("action"), user: url.searchParams.get("user_name"), from: url.searchParams.get("from"), to: url.searchParams.get("to") });
      res.setHeader("Content-Type", "application/json");
      if (req.method === "GET" && url.searchParams.get("action") === "work-sessions") {
        return res.end(JSON.stringify({ sessions: sessions(), total_hours: 0 }));
      }
      if (req.method === "GET" && url.searchParams.get("action") === "work-logs") {
        return res.end(JSON.stringify({ logs: logs() }));
      }
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: "テスト用サーバーにはありません" }));
    }
    const file = path.join(PUBLIC, decodeURIComponent(url.pathname));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.statusCode = 404;
      return res.end("not found");
    }
    const ext = path.extname(file);
    res.setHeader("Content-Type", { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" }[ext] || "application/octet-stream");
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
});

test.after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise((r) => server.close(r));
});

async function openReport(query) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // 外部(フォント等)へは出さない
  await page.setRequestInterception(true);
  page.on("request", (r) => (r.url().startsWith(base) ? r.continue() : r.abort()));
  await page.goto(`${base}/work-report.html?${query}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.getElementById("printBtn").disabled);
  return { page, errors };
}

test("見出し・31日分の行・合計・タイトルを表示し、土日祝に色が付く", async () => {
  longTasks = false;
  requests.length = 0;
  const { page, errors } = await openReport("user=%E3%82%8A%E3%82%85%E3%81%86%E3%81%A8&month=2026-10");
  assert.equal(await page.title(), "稼働記録_りゅうと_2026-10");
  const head = await page.$eval(".report-head", (e) => e.textContent.replace(/\s+/g, " "));
  assert.match(head, /稼働報告書/);
  assert.match(head, /株式会社LOCLE/);
  assert.match(head, /氏名: りゅうと/);
  assert.match(head, /対象期間: 2026年10月1日\(木\)〜10月31日\(土\)/);
  assert.equal(await page.$$eval("#reportBody tr[data-date]", (trs) => trs.length), 31);
  // 平日21日(10/12 祝日を除く)のうち: 19日 × 9:00 + 10/2 の 8:00 = 179:00(10/30 の勤務中は入れない)
  assert.match(await page.$eval("#totalLabel", (e) => e.textContent), /^179時間00分\(179\.00時間\)$/);
  assert.equal(await page.$eval("#workDays", (e) => e.textContent), "20日");
  const row = (date) => page.$eval(`tr[data-date="${date}"]`, (tr) => ({
    cls: tr.className, cells: [...tr.cells].map((c) => c.textContent.trim()), bg: getComputedStyle(tr.cells[0]).backgroundColor,
  }));
  const d2 = await row("2026-10-02");
  assert.deepEqual(d2.cells.slice(0, 5), ["10/2", "金", "9:00 / 13:00", "12:00 / 18:00", "8:00"]);
  assert.equal(d2.cls, "");
  const d12 = await row("2026-10-12");
  assert.equal(d12.cls, "off");
  assert.match(d12.cells[5], /スポーツの日/);
  assert.notEqual(d12.bg, d2.bg, "土日祝は薄い色");
  assert.equal((await row("2026-10-03")).cls, "off");
  assert.equal((await row("2026-10-30")).cells[3], "勤務中");
  const total = await page.$eval("tr.total", (tr) => tr.textContent.replace(/\s+/g, " ").trim());
  assert.match(total, /合計 179:00 179\.00時間/);
  // 署名欄・押印欄の場所はあるが、今は表示しない
  assert.equal(await page.$eval("#reportStamps", (e) => getComputedStyle(e).display), "none");
  // 読むだけ(GET)。月の初日〜末日で取る
  assert.ok(requests.length >= 2);
  assert.ok(requests.every((r) => r.method === "GET"));
  assert.ok(requests.every((r) => r.user === "りゅうと" && r.from === "2026-10-01" && r.to === "2026-10-31"));
  assert.deepEqual(errors, []);
  await page.close();
});

test("長い業務内容でも、PDF が A4 縦の1枚に収まる", async () => {
  longTasks = true;
  const { page, errors } = await openReport("user=%E3%82%8A%E3%82%85%E3%81%86%E3%81%A8&month=2026-10");
  // 1ページ目は作れて、2ページ目は無い(ページ数を超える範囲を指定するとブラウザが断る)
  const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: false, pageRanges: "1" });
  assert.ok(pdf.length > 1000);
  await assert.rejects(page.pdf({ preferCSSPageSize: true, printBackground: false, pageRanges: "2" }));
  // 印刷時の紙面の高さが、A4 縦から上下の余白(12mm×2)を引いた 273mm 以内
  await page.emulateMediaType("print");
  await page.setViewport({ width: Math.round(186 * 96 / 25.4), height: 1200 });
  const heightMm = await page.$eval("#sheet", (e) => e.getBoundingClientRect().height * 25.4 / 96);
  assert.ok(heightMm <= 273, `紙面の高さ ${heightMm.toFixed(1)}mm`);
  await page.emulateMediaType("screen");
  // 業務内容は2行で切る(セルの高さが2行分を超えない)
  const maxLines = await page.$$eval("td .tasks", (els) => Math.max(...els.map((e) => {
    const lh = parseFloat(getComputedStyle(e).lineHeight);
    return Math.round(e.getBoundingClientRect().height / lh);
  })));
  assert.ok(maxLines <= 2, `業務内容の行数 ${maxLines}`);
  assert.deepEqual(errors, []);
  await page.close();
});

test("氏名・月を選び直すと読み直し、URL とタイトルも変わる。操作部分は印刷しない", async () => {
  longTasks = false;
  requests.length = 0;
  const { page, errors } = await openReport("user=%E5%AE%AE%E7%94%B0&month=2026-02");
  assert.equal(await page.$eval("#userSelect", (e) => e.value), "宮田");
  assert.equal(await page.$$eval("#reportBody tr[data-date]", (trs) => trs.length), 28);
  await page.select("#userSelect", "岡田");
  await page.waitForFunction(() => document.title === "稼働記録_岡田_2026-02");
  assert.match(page.url(), /month=2026-02/);
  assert.ok(requests.some((r) => r.user === "岡田"));
  await page.emulateMediaType("print");
  assert.equal(await page.$eval(".toolbar", (e) => getComputedStyle(e).display), "none");
  assert.deepEqual(errors, []);
  await page.close();
});
