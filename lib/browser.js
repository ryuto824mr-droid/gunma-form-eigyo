const path = require("path");
const fs = require("fs");
const os = require("os");

// options.isolatedProfile: true のとき、ブラウザの作業用フォルダ(閲覧データ・キャッシュ)を
// /tmp に自分で作って指定し、closeBrowserSafely() で必ず消せるようにする(リサーチ用)。
// 指定しない場合の動きは従来どおり(フォーム送信の lib/form-submitter.js はこちらを使う)
async function launchBrowser(options = {}) {
  const profileDir = options.isolatedProfile
    ? await fs.promises.mkdtemp(path.join(os.tmpdir(), "research-chrome-"))
    : null;
  const extra = profileDir ? { userDataDir: profileDir } : {};
  let browser;
  if (process.env.VERCEL) {
    const chromium = (await import("@sparticuz/chromium")).default;
    const puppeteer = (await import("puppeteer-core")).default;
    const executablePath = await chromium.executablePath();
    process.env.LD_LIBRARY_PATH = `${path.dirname(executablePath)}:${process.env.LD_LIBRARY_PATH || ""}`;
    browser = await puppeteer.launch({
      // @sparticuz/chromiumの既定argsには--disable-dev-shm-usageが含まれておらず、
      // Vercelの関数内で複数のリサーチが同時実行されると/dev/shmの共有メモリが
      // 不足してChromiumの起動自体に失敗することがある(一括CAPTCHA再リサーチで
      // 実際に発生・再現済み)。共有メモリではなくディスクを使うようにする
      args: [...chromium.args, "--disable-dev-shm-usage"],
      executablePath,
      headless: chromium.headless,
      ...extra,
    });
  } else {
    const puppeteer = (await import("puppeteer")).default;
    browser = await puppeteer.launch({ headless: "new", ...extra });
  }
  if (profileDir) browser.__profileDir = profileDir;
  return browser;
}

// ブラウザを確実に閉じる(リサーチ用)。
// 2026-10の再リサーチでは、ブラウザが途中で落ちた(detached Frame 等)直後から、同じ実行環境で
// ERR_INSUFFICIENT_RESOURCES(資源不足)が連続した。close() の失敗を無視していたため、落ちた
// ブラウザのプロセスや作業用フォルダが実行環境に残り続けたことが最も有力な原因と考えられる。
//   1. close() を上限時間つきで試す
//   2. 閉じられなかった(失敗・時間切れ)、またはプロセスが残っていれば強制終了する
//   3. 作業用フォルダ(isolatedProfile で作ったもの)を消す
// 戻り値: { closed, killed, profileRemoved, error }(診断の記録に使う)
async function closeBrowserSafely(browser, { timeoutMs = 5000 } = {}) {
  const info = { closed: false, killed: false, profileRemoved: false, error: null };
  if (!browser) return info;
  let timer;
  try {
    await Promise.race([
      browser.close(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`close()が${timeoutMs}msで終わりませんでした`)), timeoutMs); }),
    ]);
    info.closed = true;
  } catch (err) {
    info.error = String(err && err.message || err).slice(0, 120);
  } finally {
    clearTimeout(timer);
  }

  let proc = null;
  try { proc = typeof browser.process === "function" ? browser.process() : null; } catch {}
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    try {
      proc.kill("SIGKILL");
      info.killed = true;
    } catch (err) {
      info.error = [info.error, `強制終了に失敗: ${String(err.message).slice(0, 80)}`].filter(Boolean).join(" / ");
    }
  }

  if (browser.__profileDir) {
    try {
      await fs.promises.rm(browser.__profileDir, { recursive: true, force: true, maxRetries: 2 });
      info.profileRemoved = true;
    } catch (err) {
      info.error = [info.error, `作業用フォルダの削除に失敗: ${String(err.message).slice(0, 80)}`].filter(Boolean).join(" / ");
    }
  }
  return info;
}

// ---- 診断(実行環境に残っているもの) ----
// Linux(Vercel)の /proc から、残っているChromiumのプロセス数・このプロセスの開いているファイル数・
// /tmp の使用量・空きメモリを集める。読めない環境(Windows等)では null にする。失敗しても例外は出さない

async function countChromiumProcesses() {
  try {
    const entries = await fs.promises.readdir("/proc");
    let count = 0;
    for (const name of entries) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const cmd = await fs.promises.readFile(`/proc/${name}/cmdline`, "utf8");
        if (/chrom(e|ium)|headless_shell/i.test(cmd)) count++;
      } catch {
        // 読んでいる間に終わったプロセスは数えない
      }
    }
    return count;
  } catch {
    return null;
  }
}

async function countOpenFiles() {
  try {
    return (await fs.promises.readdir("/proc/self/fd")).length;
  } catch {
    return null;
  }
}

// /tmp の合計サイズ(MB)と、残っている作業用フォルダの数。時間がかかりすぎないよう件数に上限を設ける
async function tmpUsage(maxEntries = 20000) {
  const root = os.tmpdir();
  let bytes = 0;
  let seen = 0;
  let truncated = false;
  async function walk(dir, depth) {
    if (seen >= maxEntries) { truncated = true; return; }
    let items;
    try { items = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (seen >= maxEntries) { truncated = true; return; }
      seen++;
      const p = path.join(dir, it.name);
      try {
        if (it.isDirectory()) { if (depth < 12) await walk(p, depth + 1); }
        else if (it.isFile()) bytes += (await fs.promises.stat(p)).size;
      } catch {}
    }
  }
  let profiles = null;
  try {
    const top = await fs.promises.readdir(root);
    profiles = top.filter((n) => /^(research-chrome-|puppeteer_dev_chrome_profile-)/.test(n)).length;
    // Windows等のローカルでは/tmpに他のアプリのファイルが大量にあるため、Linux以外では合計は測らない
    if (process.platform === "linux") await walk(root, 0);
    else return { mb: null, profiles, truncated: false };
  } catch {
    return { mb: null, profiles, truncated: false };
  }
  return { mb: Math.round(bytes / 1024 / 1024), profiles, truncated };
}

async function freeMemoryMb() {
  try {
    const meminfo = await fs.promises.readFile("/proc/meminfo", "utf8");
    const m = meminfo.match(/MemAvailable:\s+(\d+)\s*kB/);
    if (m) return Math.round(Number(m[1]) / 1024);
  } catch {}
  return Math.round(os.freemem() / 1024 / 1024);
}

async function collectDiagnostics() {
  const [chromium, fds, tmp, memFreeMb] = await Promise.all([
    countChromiumProcesses(), countOpenFiles(), tmpUsage(), freeMemoryMb(),
  ]);
  return { chromium, fds, tmpMb: tmp.mb, tmpTruncated: tmp.truncated, profiles: tmp.profiles, memFreeMb };
}

const show = (v) => (v === null || v === undefined ? "不明" : String(v));
function formatDiagnostics(d) {
  if (!d) return "取得できず";
  return `Chromiumプロセス=${show(d.chromium)} 開いているファイル=${show(d.fds)} ` +
    `/tmp=${d.tmpMb === null ? "不明" : `${d.tmpMb}MB${d.tmpTruncated ? "以上" : ""}`}(作業用フォルダ${show(d.profiles)}) ` +
    `空きメモリ=${show(d.memFreeMb)}MB`;
}
function formatCloseInfo(c) {
  if (!c) return "ブラウザ未起動";
  const parts = [c.closed ? "正常に終了" : "close失敗"];
  if (c.killed) parts.push("強制終了");
  parts.push(c.profileRemoved ? "作業用フォルダ削除" : "作業用フォルダ未削除");
  if (c.error) parts.push(`(${c.error})`);
  return parts.join("・");
}

module.exports = { launchBrowser, closeBrowserSafely, collectDiagnostics, formatDiagnostics, formatCloseInfo };
