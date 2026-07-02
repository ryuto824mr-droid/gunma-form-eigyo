const { launchBrowser } = require("./browser");

async function submitForm(url, fieldValues) {
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    );
    await page.setViewport({ width: 1280, height: 900 });

    await page.goto(url, { waitUntil: "networkidle2", timeout: 20000 });

    for (const field of fieldValues) {
      if (field.value === null || field.value === undefined || field.value === "") continue;
      await fillField(page, field).catch(() => {});
    }

    const submitted = await clickSubmitButton(page);
    if (!submitted) throw new Error("送信ボタンが見つかりませんでした");

    // 送信後の遷移を待つ
    await new Promise(r => setTimeout(r, 3000));

    return {
      resultUrl:   page.url(),
      resultTitle: await page.title(),
    };
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
}

async function fillField(page, field) {
  const selectors = [];
  if (field.name) selectors.push(`[name="${field.name}"]`);
  if (field.id)   selectors.push(`#${field.id}`);
  if (selectors.length === 0) return;

  for (const selector of selectors) {
    const el = await page.$(selector);
    if (!el) continue;

    const info = await el.evaluate(e => ({
      tag:  e.tagName.toLowerCase(),
      type: (e.getAttribute("type") || "").toLowerCase(),
    }));

    if (info.type === "checkbox") {
      if (field.value === true || field.value === "true") {
        await el.evaluate(e => {
          if (!e.checked) {
            e.checked = true;
            e.dispatchEvent(new Event("change", { bubbles: true }));
          }
        });
      }
      return;
    }

    if (info.tag === "select") {
      await fillSelect(page, selector, field);
      return;
    }

    // text / email / tel / textarea: 直接値をセットしてイベントを発火
    await el.evaluate((e, v) => {
      e.value = v;
      e.dispatchEvent(new Event("input",  { bubbles: true }));
      e.dispatchEvent(new Event("change", { bubbles: true }));
    }, String(field.value));
    return;
  }
}

async function fillSelect(page, selector, field) {
  const options = await page.$$eval(`${selector} option`, opts =>
    opts
      .filter(o => o.value !== "")
      .map(o => ({ value: o.value, text: o.textContent.trim() }))
  );
  if (options.length === 0) return;

  let targetValue;
  if (field.role === "subject") {
    const kws = ["お問い合わせ", "問合", "contact", "inquiry", "その他", "general", "一般"];
    const hit = options.find(o =>
      kws.some(kw => o.text.toLowerCase().includes(kw.toLowerCase()))
    );
    targetValue = hit ? hit.value : options[0].value;
  } else {
    targetValue = options[0].value;
  }

  await page.select(selector, targetValue).catch(() => {});
}

async function clickSubmitButton(page) {
  const SUBMIT_TEXTS = ["送信", "確認", "submit", "send", "送る", "次へ", "confirm", "確認する"];

  // 優先1: type=submit の button/input
  const submitEls = await page.$$('button[type="submit"], input[type="submit"]');
  if (submitEls.length > 0) {
    try { await submitEls[0].click(); return true; } catch {}
  }

  // 優先2: 送信系テキストを持つ button
  const allButtons = await page.$$("button");
  for (const btn of allButtons) {
    const text = await btn.evaluate(e => e.textContent.trim());
    if (SUBMIT_TEXTS.some(t => text.includes(t))) {
      try { await btn.click(); return true; } catch { continue; }
    }
  }

  return false;
}

module.exports = { submitForm };
