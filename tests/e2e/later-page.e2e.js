// 「あとで送る」画面(public/later.html)の3区分・★候補・「選んだ企業を送信待ちへ」の表示と操作の通しテスト。
// 127.0.0.1 で public/ を配り、一覧の API(later-list)は lib/later-status.js で作った偽のデータを返す。
// 送信待ちへの追加(send-queue)は受け取った内容を記録するだけで、DB・本番・送信APIには一切つながない。
// 実行: npm run test:e2e
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");
const { buildLaterList } = require("../../lib/later-status");

const PUBLIC = path.join(__dirname, "..", "..", "public");
const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

function company(id, over = {}) {
  return {
    id, name: `株式会社テスト${id}`, official_name: null, url: `https://test${id}.co.jp/`,
    contact_form_url: `https://test${id}.co.jp/contact/`, email: `info@test${id}.co.jp`,
    status: "researched", archived: false, action_status: "none", project: "ozukanzukan",
    automatable: "true", rejection_detected: "false", mapping_source: "ai", ai_error: null, appeal_error: null,
    captcha_detected: "false", needs_review: [], image_auth_fields: [], phone_number: "027-123-4567",
    updated_at: new Date(NOW - 2 * DAY).toISOString(), ...over,
  };
}
const qrow = (id, companyId, status) => ({
  id, company_id: companyId, variant_id: 7, variant_name: "動画付き", variant_project: "ozukanzukan", channel: "form",
  status, created_at: new Date(NOW - DAY).toISOString(), updated_at: null, error_message: status === "dismissed" ? "[停止] テスト" : null,
});

function laterListBody() {
  const { items, counts } = buildLaterList({
    companies: [
      company(1),                                   // 送れる・★候補
      company(2, { phone_number: null }),           // 送れる・候補外(電話番号なし)
      company(3, { name: "株式会社へ" }),           // 要確認(宛名)
      company(4),                                   // 保留中・送れる・★候補
      company(5),                                   // 停止中(却下)の行と、停止の履歴ありの未送信(要確認)
      company(6),                                   // 送信待ち
    ],
    sendLogSummary: [], responses: [],
    queueRows: [qrow(40, 4, "on_hold"), qrow(50, 5, "dismissed"), qrow(60, 6, "pending")],
    scheduledRows: [], senderProfileValid: true, lastFailures: [], now: NOW,
  });
  return {
    project: "ozukanzukan", generated_at: new Date().toISOString(), sender_profile_valid: true,
    ai_status: { failed_7d: 0, by_kind: {}, failing: false, blocking: false, discover_failed_7d: 0 },
    counts, items, variants: [{ id: 7, name: "動画付き", channel: "form", project: "ozukanzukan" }],
  };
}

const requests = [];
let server;
let browser;
let base;

test.before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        requests.push({ method: req.method, path: url.pathname, action: url.searchParams.get("action"), body: body ? JSON.parse(body) : null });
        res.setHeader("Content-Type", "application/json");
        if (url.pathname === "/api/crm" && url.searchParams.get("action") === "later-list") {
          return res.end(JSON.stringify(laterListBody()));
        }
        if (url.pathname === "/api/crm" && url.searchParams.get("action") === "send-queue") {
          res.statusCode = req.method === "POST" ? 201 : 200;
          return res.end(JSON.stringify({ ok: true }));
        }
        res.statusCode = 404;
        return res.end(JSON.stringify({ error: "テスト用サーバーにはありません" }));
      });
      return;
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

async function openPage() {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  // 外部(フォント等)へは出さない
  await page.setRequestInterception(true);
  page.on("request", (r) => (r.url().startsWith(base) ? r.continue() : r.abort()));
  await page.goto(`${base}/later.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelectorAll("#laterBody tr[data-key]").length > 0);
  return { page, errors };
}
// 実際に見えているか(hidden 属性だけでなく、計算後の display で確かめる)
const visible = (page, sel) => page.$eval(sel, (e) => getComputedStyle(e).display !== "none");
const rowKeys = (page) => page.$$eval("#laterBody tr[data-key]", (trs) => trs.map((t) => t.dataset.key));

test("3区分のタブと件数、最初は「送れる」を表示し、★候補の印が付く", async () => {
  const { page, errors } = await openPage();
  const tabs = await page.$$eval(".category-tab", (bs) => bs.map((b) => b.textContent.replace(/\s+/g, " ").trim()));
  assert.equal(tabs.length, 3);
  assert.match(tabs[0], /^送れる 3/);
  assert.match(tabs[1], /^要確認 2/);
  assert.match(tabs[2], /^送れない 1/);
  assert.match(await page.$eval("#activeSummary", (e) => e.textContent), /送信待ち 1件・予約 0件/);
  assert.deepEqual((await rowKeys(page)).sort(), ["company-1", "company-2", "queue-40"]);
  assert.equal(await page.$eval('tr[data-key="company-1"]', (tr) => !!tr.querySelector(".cand-badge")), true);
  assert.match(await page.$eval('tr[data-key="company-2"] .cand-off', (e) => e.title), /電話番号/);
  assert.equal(await visible(page, "#readyBar"), true);
  assert.equal(await visible(page, "#bulkBar"), false);
  // ★候補のみ
  await page.click("#candidateOnly");
  assert.deepEqual((await rowKeys(page)).sort(), ["company-1", "queue-40"]);
  assert.deepEqual(errors, []);
  await page.close();
});

test("要確認は理由で絞り込め、送れないは操作ボタンを出さない", async () => {
  const { page, errors } = await openPage();
  await page.click(".category-tab.cat-review");
  assert.deepEqual((await rowKeys(page)).sort(), ["company-3", "company-5"]);
  assert.equal(await visible(page, "#reasonFilter"), true);
  assert.match(await page.$eval("#reasonFilter", (e) => e.textContent), /宛名が不確か \(1\)/);
  assert.match(await page.$eval("#reasonFilter", (e) => e.textContent), /停止の履歴 \(1\)/);
  await page.select("#reasonFilter", "greeting_uncertain");
  assert.deepEqual(await rowKeys(page), ["company-3"]);
  assert.equal(await visible(page, "#readyBar"), false);
  await page.click(".category-tab.cat-blocked");
  assert.deepEqual(await rowKeys(page), ["queue-50"]);
  assert.equal(await page.$eval('tr[data-key="queue-50"] td.actions', (e) => e.querySelectorAll("button, input").length), 0);
  assert.deepEqual(errors, []);
  await page.close();
});

test("選んだ企業を送信待ちへ: 未送信は ready で追加、保留中は再開。送信APIは呼ばない", async () => {
  requests.length = 0;
  const { page, errors } = await openPage();
  await page.click("#readySelectAll");
  assert.match(await page.$eval("#readyCount", (e) => e.textContent), /3社を選択中/);
  await page.click("#readyAddBtn");
  await page.waitForFunction(() => /送信待ちに入れました/.test(document.getElementById("actionMsg").textContent));
  const sends = requests.filter((r) => r.action === "send-queue");
  assert.deepEqual(
    sends.map((r) => [r.method, r.body.ready || null, r.body.company_id || null, r.body.id || null, r.body.status || null]).sort(),
    [["PATCH", null, null, 40, "pending"], ["POST", true, 1, null, null], ["POST", true, 2, null, null]],
  );
  for (const r of sends.filter((x) => x.method === "POST")) assert.equal(r.body.variant_id, 7);
  assert.equal(requests.filter((r) => /submit-form|send-email|run-scheduled-sends/.test(`${r.path}${r.action}`)).length, 0);
  assert.deepEqual(errors, []);
  await page.close();
});

test("詳細を開くと今の状態別タブに切り替わり、閉じると3区分に戻る", async () => {
  const { page, errors } = await openPage();
  await page.click("#detailTabs > summary");
  await page.waitForFunction(() => document.getElementById("readyBar").hidden);
  assert.ok((await page.$$(".state-tab")).length >= 8);
  assert.equal((await rowKeys(page)).length, 7, "すべてのタブ");
  await page.click('.state-tab[data-tab="unsent"]');
  assert.equal(await visible(page, "#bulkBar"), true);
  await page.click("#detailTabs > summary");
  await page.waitForFunction(() => !document.getElementById("readyBar").hidden);
  assert.deepEqual((await rowKeys(page)).sort(), ["company-1", "company-2", "queue-40"]);
  assert.deepEqual(errors, []);
  await page.close();
});
