const path = require("path");

async function launchBrowser() {
  if (process.env.VERCEL) {
    const chromium = (await import("@sparticuz/chromium")).default;
    const puppeteer = (await import("puppeteer-core")).default;
    const executablePath = await chromium.executablePath();
    process.env.LD_LIBRARY_PATH = `${path.dirname(executablePath)}:${process.env.LD_LIBRARY_PATH || ""}`;
    return puppeteer.launch({
      // @sparticuz/chromiumの既定argsには--disable-dev-shm-usageが含まれておらず、
      // Vercelの関数内で複数のリサーチが同時実行されると/dev/shmの共有メモリが
      // 不足してChromiumの起動自体に失敗することがある(一括CAPTCHA再リサーチで
      // 実際に発生・再現済み)。共有メモリではなくディスクを使うようにする
      args: [...chromium.args, "--disable-dev-shm-usage"],
      executablePath,
      headless: chromium.headless,
    });
  }
  const puppeteer = (await import("puppeteer")).default;
  return puppeteer.launch({ headless: "new" });
}

module.exports = { launchBrowser };
