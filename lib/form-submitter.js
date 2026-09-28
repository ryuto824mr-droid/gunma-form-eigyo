const { launchBrowser } = require("./browser");

// 送信ボタンのクリックはページ遷移を引き起こすことがあり、遷移中にpage.$()/
// page.evaluate()を呼ぶと「Execution context was destroyed」「detached Frame」等の
// 一過性エラーで例外を投げることがある
const TRANSIENT_NAVIGATION_ERROR_RE = /execution context was destroyed|detached frame|cannot find context with specified id|navigating frame was detached/i;

function isTransientNavigationError(err) {
  return !!(err && TRANSIENT_NAVIGATION_ERROR_RE.test(err.message || ""));
}

// page.$()をナビゲーション競合に強くするラッパー。一過性エラーの場合のみ
// 少し待って1回だけリトライし、それでも失敗する場合はnullを返す
// (遷移が実際に起きていることの裏付けでもあるため、クラッシュさせる理由にはならない)
async function safeQuerySelector(page, selector) {
  try {
    return await page.$(selector);
  } catch (err) {
    if (!isTransientNavigationError(err)) return null;
    await new Promise((r) => setTimeout(r, 1000));
    try {
      return await page.$(selector);
    } catch {
      return null;
    }
  }
}

// page.evaluate()の同種のラッパー
async function safeEvaluate(page, fn, fallback, ...args) {
  try {
    return await page.evaluate(fn, ...args);
  } catch (err) {
    if (!isTransientNavigationError(err)) return fallback;
    await new Promise((r) => setTimeout(r, 1000));
    try {
      return await page.evaluate(fn, ...args);
    } catch {
      return fallback;
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 「入力→確認→送信」型フォームの1段目のボタン(押しても送信はされず確認画面に進むだけ)
const CONFIRM_BUTTON_RE = /確認|次へ|進む|confirm|next/i;
// 確認画面上の最終送信ボタン。「送信内容を確認する」「戻る」等は除外する
const FINAL_SEND_BUTTON_RE = /送\s*信|この内容で|上記の内容で|以上の内容で|申し?込|send|submit/i;
const NON_FINAL_BUTTON_RE = /確認|戻る|修正|訂正|back|reset|リセット|クリア|clear|検索|search|ログイン|login/i;

// 最終的な送信完了ページであることを示す文言。以前は「完了」「担当者」「確認メール」等の
// 単語単体でも成功扱いにしていたため、「入力→確認→完了」の手順表示や「担当者より折り返し
// ご連絡します」といった送信前から表示されている案内文に反応し、確認画面に進んだだけで
// 成功と誤判定していた(確認画面型フォームの最終送信ボタンが押されないまま終わっていた)。
// 送信完了を明確に示す言い回しに限定し、さらに送信前のページ(および確認画面)に既に
// 含まれていた文言は判定に使わない(hasNewFinalSuccessText参照)
const FINAL_SUCCESS_TEXTS = [
  "送信が完了", "送信完了しました", "送信を完了", "送信しました", "送信されました",
  "受け付けました", "受付けました", "受付いたしました", "受け付けいたしました", "受付が完了",
  "ありがとうございました", "後日担当者より", "担当者よりご連絡", "折り返しご連絡",
  "ご連絡いたします", "ご連絡させていただきます",
  "message has been sent", "your message was sent", "thank you for your", "thank you for contacting",
];

function hasNewFinalSuccessText(text, baselineTexts) {
  const lower = (text || "").toLowerCase();
  const baselines = baselineTexts.map((t) => (t || "").toLowerCase());
  const isNew = (phrase) => lower.includes(phrase) && !baselines.some((b) => b.includes(phrase));
  if (FINAL_SUCCESS_TEXTS.some((t) => isNew(t.toLowerCase()))) return true;
  // 「送信/受付」+「完了」+「ありがとう」の組み合わせ(個々の語が送信前から散在していた場合は除く)
  const hasCombo = (s) => /送信|受付|受け付/.test(s) && s.includes("完了") && s.includes("ありがとう");
  return hasCombo(lower) && !baselines.some(hasCombo);
}

// ページの状態を1回のevaluateで取得する(本文テキスト、本文欄が編集可能なまま表示されているか、
// 検索フォーム以外にある最終送信ボタン候補のDOM上のインデックス)
const BUTTON_SELECTOR = 'input[type="submit"], input[type="button"], input[type="image"], button, a[href^="javascript"], a[onclick]';

async function getPageState(page, messageSelectors) {
  return safeEvaluate(page, (args) => {
    const finalRe = new RegExp(args.finalSrc, "i");
    const nonFinalRe = new RegExp(args.nonFinalSrc, "i");
    const isVisible = (e) => {
      const r = e.getBoundingClientRect();
      const s = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };
    const isEditable = (e) => !e.readOnly && !e.disabled && (e.getAttribute("type") || "").toLowerCase() !== "hidden";
    const isSearchForm = (f) => {
      if ((f.getAttribute("role") || "").toLowerCase() === "search") return true;
      if (/(^|\s)search(form)?(\s|$)/.test((f.className || "").toLowerCase())) return true;
      const fields = Array.from(f.querySelectorAll("input, textarea, select")).filter((el) =>
        !["hidden", "submit", "button", "image", "reset"].includes((el.getAttribute("type") || "").toLowerCase()));
      if (fields.length !== 1) return false;
      const el = fields[0];
      return (el.getAttribute("type") || "").toLowerCase() === "search" ||
        /検索|search/i.test(el.getAttribute("placeholder") || "") ||
        (el.getAttribute("name") || "").toLowerCase() === "s";
    };

    let messageEls = [];
    for (const sel of args.messageSelectors) {
      try { messageEls.push(...document.querySelectorAll(sel)); } catch {}
    }
    // 本文欄の特定ができない場合は、表示中の編集可能なtextareaがあるかで代用する
    if (args.messageSelectors.length === 0) messageEls = Array.from(document.querySelectorAll("textarea"));
    const messageEditable = messageEls.some((e) => isVisible(e) && isEditable(e));

    const finalButtons = [];
    const visibleButtonTexts = [];
    Array.from(document.querySelectorAll(args.buttonSelector)).forEach((e, index) => {
      const form = e.closest("form");
      if (form && isSearchForm(form)) return;
      if (!isVisible(e)) return;
      const text = (e.tagName === "INPUT" ? (e.value || e.alt || "") : (e.innerText || e.textContent || ""))
        .replace(/\s+/g, " ").trim();
      visibleButtonTexts.push(text);
      if (finalRe.test(text) && !nonFinalRe.test(text)) finalButtons.push({ index, text, inForm: !!form });
    });

    const text = document.body ? document.body.innerText : "";
    return { url: location.href, text, messageEditable, finalButtons, visibleButtonTexts, hasConfirmWord: text.includes("確認") };
  }, null, {
    messageSelectors,
    buttonSelector: BUTTON_SELECTOR,
    finalSrc: FINAL_SEND_BUTTON_RE.source,
    nonFinalSrc: NON_FINAL_BUTTON_RE.source,
  });
}

// 確認画面かどうか: 「確認」という文言があり、まだ押していない最終送信ボタンが表示されていて、
// かつ入力画面から先に進んでいる(URLが変わった、または本文欄が編集可能な状態で表示されていない)
function isConfirmPage(state, inputPageUrl) {
  return state.finalButtons.length > 0 && state.hasConfirmWord &&
    (state.url !== inputPageUrl || !state.messageEditable);
}

// クリック後の結果を最大8秒(500ms間隔)待って判定する
// - "confirm": 確認画面に到達した(allowConfirmのときのみ)
// - "success": 送信完了を示す文言が新たに現れた、またはURLが変わり入力欄も送信ボタンも無くなった
//   (requirePhrase=trueのときは文言のみで判定する)
// - "none":    どちらも確認できなかった
async function waitForOutcome(page, ctx, { prevUrl, allowConfirm, requirePhrase }) {
  let state = null;
  for (let i = 0; i < 16; i++) {
    await sleep(500);
    state = (await getPageState(page, ctx.messageSelectors)) || state;
    if (!state) continue;
    // 確認画面上にも「担当者よりご連絡いたします」等の案内文が出ることがあるため、確認画面の判定を先に行う
    if (allowConfirm && isConfirmPage(state, prevUrl)) return { kind: "confirm", state };
    if (hasNewFinalSuccessText(state.text, ctx.baselineTexts)) return { kind: "success", state };
    if (!requirePhrase && state.url !== prevUrl && !state.messageEditable && state.finalButtons.length === 0) {
      return { kind: "success", state };
    }
  }
  return { kind: "none", state };
}

async function getButtonText(handle) {
  return handle.evaluate((e) =>
    (e.tagName === "INPUT" ? (e.value || e.alt || "") : (e.innerText || e.textContent || "")).replace(/\s+/g, " ").trim()
  ).catch(() => "");
}

// options.dryRun: 動作確認用。1段目のボタンが確認画面へ進むボタン(CONFIRM_BUTTON_RE)の場合のみ
// クリックし、確認画面で最終送信ボタンを検出した時点で押さずに終了する。1段目のボタンが
// 最終送信ボタンの場合(押すと実際に送信されてしまう)はクリックせずに終了する
async function submitForm(url, fieldValues, options = {}) {
  const dryRun = !!options.dryRun;
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    // 確認画面・送信時の「送信してよろしいですか？」等のダイアログは、放置するとページが
    // 止まってしまうため応答する(dryRun時は送信を確定させないよう必ずキャンセルする)
    page.on("dialog", (dialog) => (dryRun ? dialog.dismiss() : dialog.accept()).catch(() => {}));
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    );
    await page.setViewport({ width: 1280, height: 900 });

    await page.goto(url, { waitUntil: "networkidle2", timeout: 25000 });

    let fillResult = await fillAndSubmit(page, fieldValues, { dryRun });
    if (fillResult.dryRunStopped) return dryRunResult(page, "dry_run_first_button_is_final", fillResult);
    if (fillResult.missingCritical || !fillResult.submitted) {
      // 必須項目(本文/送信者名)が埋まらない、または送信ボタンのクリックに失敗した場合、
      // ページ読み込みが完全でなかった可能性を考慮して3秒待って1回だけリトライする
      // (ここで1回リトライした後は、それでも失敗すれば下記のthrowで確実にfailedとして扱う)
      await sleep(3000);
      fillResult = await fillAndSubmit(page, fieldValues, { dryRun });
      if (fillResult.dryRunStopped) return dryRunResult(page, "dry_run_first_button_is_final", fillResult);
    }
    // 本文(message)、および送信者名(company_name/contact_person_nameのいずれか)が
    // 入力できなかった場合、実質的に意味のない(空欄だらけの)問い合わせを送ってしまう
    // ことになるため、送信ボタンをクリックする前に中止する(fillAndSubmit内でガード済み)
    if (fillResult.missingCritical) {
      throw new Error("必須項目(本文または送信者名)が入力できなかったため、送信を中止しました");
    }
    if (!fillResult.submitted) throw new Error("送信ボタンが見つかりませんでした");

    const { inputPageUrl, baselineText, firstButtonText } = fillResult;
    const firstClickWasConfirm = CONFIRM_BUTTON_RE.test(firstButtonText);
    const ctx = {
      messageSelectors: messageSelectorsOf(fieldValues),
      baselineTexts: [baselineText],
    };

    // 送信ボタンのクリックは確認画面等への本当のページ遷移を引き起こすことがある。
    // 遷移が始まった直後にpage.$()等を呼ぶと「Execution context was destroyed」で
    // クラッシュすることがあるため、遷移が始まる/完了するのを少し待つ。
    // AJAX送信等でそもそも遷移が起きないフォームもあるため、一定時間で必ず打ち切る
    await waitForNavigationBriefly(page);

    // 1段目のボタンが「確認」系だった場合、URLが変わっただけでは送信完了とみなさない
    // (確認画面への遷移と区別できないため、完了を示す文言の出現を必須とする)
    const first = await waitForOutcome(page, ctx, {
      prevUrl: inputPageUrl, allowConfirm: true, requirePhrase: firstClickWasConfirm,
    });

    if (dryRun && first.kind !== "confirm") {
      // 確認系ボタンを押したのに確認画面を検出できなかった(検出ロジックの改善材料として状態を返す)
      return dryRunResult(page, first.kind === "success" ? "dry_run_unexpected_success" : "dry_run_confirm_not_detected", {
        firstButtonText, pageState: summarizeState(first.state),
      });
    }
    if (first.kind === "success") return finalResult(page, "success", { confirmStep: false });
    if (first.kind === "none") return finalResult(page, "uncertain", { confirmStep: false });

    // 確認画面に到達した: 最終送信ボタンを押して、改めて完了判定を行う
    const confirmState = first.state;
    const finalButton = pickFinalButton(confirmState.finalButtons);
    if (dryRun) {
      return dryRunResult(page, "dry_run_confirm_detected", {
        firstButtonText, finalButtonText: finalButton.text, confirmUrl: confirmState.url,
        finalButtonCandidates: confirmState.finalButtons.map((b) => b.text),
      });
    }

    const clicked = await clickButtonByIndex(page, finalButton.index);
    if (!clicked) {
      return finalResult(page, "uncertain", { confirmStep: true, finalButtonText: finalButton.text, note: "確認画面の送信ボタンをクリックできませんでした" });
    }
    await waitForNavigationBriefly(page);

    ctx.baselineTexts.push(confirmState.text);
    const second = await waitForOutcome(page, ctx, {
      prevUrl: confirmState.url, allowConfirm: false, requirePhrase: false,
    });
    return finalResult(page, second.kind === "success" ? "success" : "uncertain", {
      confirmStep: true, finalButtonText: finalButton.text,
    });
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
}

function summarizeState(state) {
  if (!state) return null;
  return {
    url: state.url,
    messageEditable: state.messageEditable,
    hasConfirmWord: state.hasConfirmWord,
    visibleButtons: (state.visibleButtonTexts || []).slice(0, 15),
    textHead: (state.text || "").replace(/\s+/g, " ").slice(0, 200),
  };
}

async function waitForNavigationBriefly(page) {
  await Promise.race([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 8000 }).catch(() => null),
    sleep(1500),
  ]);
}

function messageSelectorsOf(fieldValues) {
  const selectors = [];
  for (const f of fieldValues) {
    if (f.role !== "message") continue;
    if (f.name) selectors.push(`[name="${f.name}"]`);
    if (f.id) selectors.push(`#${f.id}`);
  }
  return selectors;
}

// 「この内容で送信」等の明確な文言 > フォーム内のボタン > DOM順 の優先度で選ぶ
function pickFinalButton(buttons) {
  const strong = /この内容で|上記の内容で|以上の内容で|送信する/;
  return buttons.find((b) => strong.test(b.text) && b.inForm) ||
    buttons.find((b) => strong.test(b.text)) ||
    buttons.find((b) => b.inForm) ||
    buttons[0];
}

async function clickButtonByIndex(page, index) {
  try {
    const handles = await page.$$(BUTTON_SELECTOR);
    if (!handles[index]) return false;
    await handles[index].click();
    return true;
  } catch (err) {
    // クリックと同時に遷移が始まった場合はクリック自体は成功している
    return isTransientNavigationError(err);
  }
}

async function finalResult(page, status, extra) {
  return {
    status,
    resultUrl:   page.url(),
    resultTitle: await page.title().catch(() => ""),
    ...extra,
  };
}

async function dryRunResult(page, status, extra) {
  const { baselineText, ...rest } = extra; // 本文テキストは結果に含めない
  return finalResult(page, status, { dryRun: true, ...rest });
}

// 欠けると実質的に意味のない問い合わせになってしまう項目。
// message(本文)は必須、company_name/contact_person_nameは「どちらか一方」で足りる
const REQUIRED_ROLE_GROUPS = [
  ["message"],
  ["company_name", "contact_person_name"],
];

async function fillAndSubmit(page, fieldValues, { dryRun = false } = {}) {
  let filledCount = 0;
  let attemptedCount = 0;
  const missingFields = [];
  const filledRoles = new Set();
  for (const field of fieldValues) {
    if (field.value === null || field.value === undefined || field.value === "") continue;
    attemptedCount++;
    let ok = false;
    try {
      ok = await fillField(page, field);
    } catch {
      ok = false;
    }
    if (ok) {
      filledCount++;
      if (field.role) filledRoles.add(field.role);
    } else {
      missingFields.push(field.name || field.id || "(不明な項目)");
    }
  }

  const missingCritical = REQUIRED_ROLE_GROUPS.some(
    group => !group.some(role => filledRoles.has(role))
  );
  if (missingCritical) {
    // 必須項目が埋まっていないため、送信ボタンはクリックせずに中止する
    return { filledCount, attemptedCount, missingFields, submitted: false, missingCritical: true };
  }

  // クリック前の入力画面のURL・本文テキストを記録しておく(完了判定で「送信前から表示されて
  // いた文言」を除外するため)
  const inputPageUrl = page.url();
  const baselineText = await safeEvaluate(page, () => document.body.innerText, "");

  const candidates = await getSubmitButtonCandidates(page);
  if (dryRun) {
    const text = candidates.length > 0 ? await getButtonText(candidates[0]) : "";
    if (!CONFIRM_BUTTON_RE.test(text)) {
      // 押すと実際に送信されてしまう(確認画面を挟まない)フォームのため、動作確認ではクリックしない
      return { filledCount, attemptedCount, missingFields, submitted: false, missingCritical: false, dryRunStopped: true, firstButtonText: text };
    }
  }

  let submitted = false;
  let firstButtonText = "";
  for (const candidate of candidates) {
    const text = await getButtonText(candidate);
    try {
      await candidate.click();
      submitted = true;
      firstButtonText = text;
      break;
    } catch {
      continue;
    }
  }
  return { filledCount, attemptedCount, missingFields, submitted, missingCritical: false, inputPageUrl, baselineText, firstButtonText };
}

async function fillField(page, field) {
  const selectors = [];
  if (field.name) selectors.push(`[name="${field.name}"]`);
  if (field.id)   selectors.push(`#${field.id}`);
  if (selectors.length === 0) return false;

  for (const selector of selectors) {
    try {
      if (await fillFieldBySelector(page, selector, field)) return true;
    } catch {
      // この項目のDOM構造が想定と異なる(要素が見つからない/操作中に消えた等)場合、
      // クラッシュさせず次の候補セレクタを試す。全滅した場合はfillAndSubmit側で
      // missingFieldsとして記録され、呼び出し元に明確な失敗として伝わる
      continue;
    }
  }
  return false;
}

async function fillFieldBySelector(page, selector, field) {
  const el = await page.$(selector);
  if (!el) return false;

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

// WordPress標準の検索ボックス等、お問い合わせフォームではない<form>を除外する。
// lib/form-analyzer.jsのisSearchForm()と同じ判定基準(入力欄1個限定で判定することで、
// 複数項目を持つ本物のお問い合わせフォームを誤って除外しないようにしている)
async function isSearchForm(form) {
  return form.evaluate((f) => {
    if ((f.getAttribute("role") || "").toLowerCase() === "search") return true;
    const cls = (f.className || "").toLowerCase();
    if (/(^|\s)search(form)?(\s|$)/.test(cls)) return true;

    const fieldEls = Array.from(f.querySelectorAll("input, textarea, select")).filter((el) => {
      const type = (el.getAttribute("type") || "").toLowerCase();
      return !["hidden", "submit", "button", "image", "reset"].includes(type);
    });
    if (fieldEls.length === 1) {
      const el = fieldEls[0];
      const type = (el.getAttribute("type") || "").toLowerCase();
      const placeholder = el.getAttribute("placeholder") || "";
      const name = (el.getAttribute("name") || "").toLowerCase();
      if (type === "search") return true;
      if (/検索|search/i.test(placeholder)) return true;
      if (name === "s") return true; // WordPress標準の検索クエリパラメータ名
    }
    return false;
  }).catch(() => false);
}

// 入力画面の送信(または確認画面へ進む)ボタンの候補を優先度順に返す。クリック失敗時に
// 次の候補を試せるよう、見つかった順にすべて返す
async function getSubmitButtonCandidates(page) {
  const candidates = [];
  const SUBMIT_TEXTS = ["送信", "確認", "submit", "次へ", "続ける", "send", "送る", "confirm", "確認する"];

  // ページ内に検索ボックス等、お問い合わせフォームとは無関係な<form>が別途存在すると、
  // ページ全体から探した最初のinput[type="submit"]等がその無関係なフォームのものに
  // なってしまうことがあった。まず検索フォームを除いたform群を対象に、DOM順で
  // 送信ボタンを探す(除外対象しか無かった場合は誤って本物のフォームまで除外する
  // リスクを避けるため、全formにフォールバックする)
  const forms = await page.$$("form");
  const nonSearchForms = [];
  for (const form of forms) {
    if (!(await isSearchForm(form))) nonSearchForms.push(form);
  }
  const targetForms = nonSearchForms.length > 0 ? nonSearchForms : forms;

  // 優先1: input[type="submit"]
  for (const form of targetForms) {
    const inputSubmits = await form.$$('input[type="submit"]');
    if (inputSubmits.length > 0) {
      candidates.push(inputSubmits[0]);
    }
  }

  // 優先2: button[type="submit"]
  for (const form of targetForms) {
    const buttonSubmits = await form.$$('button[type="submit"]');
    if (buttonSubmits.length > 0) {
      candidates.push(buttonSubmits[0]);
    }
  }

  // 優先3: 送信系テキストを持つ button
  for (const form of targetForms) {
    const buttons = await form.$$("button");
    for (const btn of buttons) {
      const text = await btn.evaluate(e => e.textContent.trim().toLowerCase()).catch(() => "");
      if (SUBMIT_TEXTS.some(t => text.includes(t.toLowerCase()))) {
        candidates.push(btn);
      }
    }
  }

  // 優先4: フォーム内で最後に出現するbutton
  for (const form of targetForms) {
    const buttons = await form.$$("button");
    if (buttons.length > 0) {
      candidates.push(buttons[buttons.length - 1]);
    }
  }

  // 優先5: JS発火型の送信リンク(<button>/<input>を一切使わず、jQueryバリデーション
  // プラグイン等でaタグに送信処理をバインドしているフォーム向け。
  // 例: <a href="javascript:void(0);">入力内容の確認</a>)
  for (const form of targetForms) {
    const anchors = await form.$$("a");
    for (const a of anchors) {
      const info = await a.evaluate(e => ({
        text: (e.textContent || "").trim().toLowerCase(),
        href: e.getAttribute("href") || "",
        hasOnclick: !!e.getAttribute("onclick"),
      })).catch(() => null);
      if (!info) continue;

      const isJsTrigger = /^\s*javascript:/i.test(info.href) || info.hasOnclick;
      if (isJsTrigger && SUBMIT_TEXTS.some(t => info.text.includes(t.toLowerCase()))) {
        candidates.push(a);
      }
    }
  }

  return candidates;
}

module.exports = { submitForm };
