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

    await page.goto(url, { waitUntil: "networkidle2", timeout: 25000 });

    let { filledCount, submitted } = await fillAndSubmit(page, fieldValues);
    if (filledCount === 0 && !submitted) {
      // フォーム要素が見つからない場合、3秒待って1回だけリトライ
      await new Promise(r => setTimeout(r, 3000));
      ({ filledCount, submitted } = await fillAndSubmit(page, fieldValues));
    }
    if (!submitted) throw new Error("送信ボタンが見つかりませんでした");

    // 送信後の完了検知 (最大10秒、500msポーリング)
    const initialUrl    = page.url();
    const hadForm       = (await page.$("form")) !== null;
    const SUCCESS_TEXTS = [
      "送信完了", "ありがとうございました", "お問い合わせを受け付けました",
      "送信しました", "完了", "thank you", "received", "success",
      "受け付けました", "受付完了", "送付しました", "確認メール", "折り返し", "担当者", "confirmation", "thank",
    ];

    let status = "uncertain";
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500));

      if (page.url() !== initialUrl) { status = "success"; break; }

      const bodyText = await page.evaluate(() => document.body.innerText).catch(() => "");
      if (SUCCESS_TEXTS.some(t => bodyText.toLowerCase().includes(t.toLowerCase()))) {
        status = "success";
        break;
      }

      if (hadForm && (await page.$("form")) === null) { status = "success"; break; }
    }

    return {
      status,
      resultUrl:   page.url(),
      resultTitle: await page.title(),
    };
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
}

async function fillAndSubmit(page, fieldValues) {
  let filledCount = 0;
  for (const field of fieldValues) {
    if (field.value === null || field.value === undefined || field.value === "") continue;
    const ok = await fillField(page, field).catch(() => false);
    if (ok) filledCount++;
  }
  const submitted = await clickSubmitButton(page);
  return { filledCount, submitted };
}

async function fillField(page, field) {
  const selectors = [];
  if (field.name) selectors.push(`[name="${field.name}"]`);
  if (field.id)   selectors.push(`#${field.id}`);
  if (selectors.length === 0) return false;

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
      return true;
    }

    if (info.tag === "select") {
      await fillSelect(page, selector, field);
      return true;
    }

    const valueStr = String(field.value);

    if (info.tag === "textarea" && valueStr.length > 100) {
      // 長文はpage.evaluate()で直接代入（keyboard.typeは遅いため）
      await el.evaluate((e, v) => { e.value = v; }, valueStr);
    } else {
      // 自然な入力として認識されやすいfocus + keyboard.type方式
      await el.evaluate(e => { e.value = ""; });
      try {
        await page.focus(selector);
      } catch {
        await el.click().catch(() => {});
      }
      await page.keyboard.type(valueStr, { delay: 15 });
    }

    await el.evaluate(e => {
      e.dispatchEvent(new Event("input",  { bubbles: true }));
      e.dispatchEvent(new Event("change", { bubbles: true }));
    });
    return true;
  }
  return false;
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
  const SUBMIT_TEXTS = ["送信", "確認", "submit", "次へ", "続ける", "send", "送る", "confirm", "確認する"];

  // 優先1: input[type="submit"]
  const inputSubmits = await page.$$('input[type="submit"]');
  if (inputSubmits.length > 0) {
    try { await inputSubmits[0].click(); return true; } catch {}
  }

  // 優先2: button[type="submit"]
  const buttonSubmits = await page.$$('button[type="submit"]');
  if (buttonSubmits.length > 0) {
    try { await buttonSubmits[0].click(); return true; } catch {}
  }

  // 優先3: 送信系テキストを持つ button
  const allButtons = await page.$$("button");
  for (const btn of allButtons) {
    const text = await btn.evaluate(e => e.textContent.trim().toLowerCase());
    if (SUBMIT_TEXTS.some(t => text.includes(t.toLowerCase()))) {
      try { await btn.click(); return true; } catch { continue; }
    }
  }

  // 優先4: フォーム内で最後に出現するbutton
  const forms = await page.$$("form");
  for (const form of forms) {
    const buttons = await form.$$("button");
    if (buttons.length > 0) {
      try { await buttons[buttons.length - 1].click(); return true; } catch { continue; }
    }
  }

  return false;
}

module.exports = { submitForm };
