// ブラウザを確実に閉じる処理と診断の表示(lib/browser.js)のテスト。本物のブラウザは起動しない(偽のブラウザを使う)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { closeBrowserSafely, collectDiagnostics, formatDiagnostics, formatCloseInfo } = require("../lib/browser");

// 偽のブラウザ。closeMode: "ok" | "reject" | "hang"、procExited: プロセスが既に終わっているか
function fakeBrowser({ closeMode = "ok", procExited = true, withProfile = true } = {}) {
  const proc = { exitCode: procExited ? 0 : null, signalCode: null, killedWith: null, kill(sig) { this.killedWith = sig; } };
  const b = {
    proc,
    close() {
      if (closeMode === "ok") { proc.exitCode = 0; return Promise.resolve(); }
      if (closeMode === "reject") return Promise.reject(new Error("Protocol error: Target closed"));
      return new Promise(() => {}); // 終わらない
    },
    process() { return proc; },
  };
  if (withProfile) {
    b.__profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "research-chrome-test-"));
    fs.writeFileSync(path.join(b.__profileDir, "Cookies"), "x".repeat(1000));
  }
  return b;
}

test("正常に閉じられた場合: 強制終了はせず、作業用フォルダを消す", async () => {
  const b = fakeBrowser();
  const info = await closeBrowserSafely(b);
  assert.deepEqual(info, { closed: true, killed: false, profileRemoved: true, error: null });
  assert.equal(fs.existsSync(b.__profileDir), false);
  assert.equal(b.proc.killedWith, null);
});

test("close() が失敗した場合: プロセスを強制終了し、作業用フォルダも消す", async () => {
  const b = fakeBrowser({ closeMode: "reject", procExited: false });
  const info = await closeBrowserSafely(b);
  assert.equal(info.closed, false);
  assert.equal(info.killed, true);
  assert.equal(b.proc.killedWith, "SIGKILL");
  assert.equal(info.profileRemoved, true);
  assert.match(info.error, /Target closed/);
  assert.equal(fs.existsSync(b.__profileDir), false);
});

test("close() が終わらない場合: 上限時間で諦めて強制終了する", async () => {
  const b = fakeBrowser({ closeMode: "hang", procExited: false });
  const t0 = Date.now();
  const info = await closeBrowserSafely(b, { timeoutMs: 100 });
  assert.ok(Date.now() - t0 < 2000, "長く待たない");
  assert.equal(info.closed, false);
  assert.equal(info.killed, true);
  assert.match(info.error, /100ms/);
  assert.equal(info.profileRemoved, true);
});

test("close() は失敗したがプロセスは既に終わっている場合: 強制終了しない", async () => {
  const b = fakeBrowser({ closeMode: "reject", procExited: true });
  const info = await closeBrowserSafely(b);
  assert.equal(info.killed, false);
  assert.equal(info.profileRemoved, true);
});

test("作業用フォルダを指定していない(従来の起動)場合と、ブラウザが無い場合", async () => {
  const b = fakeBrowser({ withProfile: false });
  assert.deepEqual(await closeBrowserSafely(b), { closed: true, killed: false, profileRemoved: false, error: null });
  assert.deepEqual(await closeBrowserSafely(null), { closed: false, killed: false, profileRemoved: false, error: null });
});

test("診断は例外を出さず、読めない値は「不明」と表示する", async () => {
  const d = await collectDiagnostics();
  assert.equal(typeof d.memFreeMb, "number");
  for (const key of ["chromium", "fds", "tmpMb", "profiles"]) assert.ok(key in d, key);
  const text = formatDiagnostics({ chromium: null, fds: 120, tmpMb: 180, tmpTruncated: true, profiles: 3, memFreeMb: 900 });
  assert.equal(text, "Chromiumプロセス=不明 開いているファイル=120 /tmp=180MB以上(作業用フォルダ3) 空きメモリ=900MB");
  assert.equal(formatDiagnostics(null), "取得できず");
});

test("終了の結果の表示", () => {
  assert.equal(formatCloseInfo({ closed: true, killed: false, profileRemoved: true, error: null }), "正常に終了・作業用フォルダ削除");
  assert.equal(formatCloseInfo({ closed: false, killed: true, profileRemoved: true, error: "close()が5000msで終わりませんでした" }),
    "close失敗・強制終了・作業用フォルダ削除・(close()が5000msで終わりませんでした)");
  assert.equal(formatCloseInfo(null), "ブラウザ未起動");
});
