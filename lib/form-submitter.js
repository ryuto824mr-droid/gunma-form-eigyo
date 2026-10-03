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
// options.profile: 送信者情報({ companyName, personName, personNameKana, email, phone })。
//   項目対応(fieldValues)に含まれない欄(確認用メールアドレス、3分割の電話番号等)の補完や、
//   お名前/ふりがなの取り違え補正に使う。未指定の場合はfieldValuesの値から推定する
// 戻り値のstatusが"rejection_checkbox"の場合、「営業目的ではありません」等の確認チェックを
// 求めるフォーム(実質的な営業お断り)のため、何も入力・クリックせずに中止している
async function submitForm(url, fieldValues, options = {}) {
  const dryRun = !!options.dryRun;
  const profile = resolveProfile(fieldValues, options.profile);
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

    let fillResult = await fillAndSubmit(page, fieldValues, { dryRun, profile });
    if (fillResult.rejectionText) {
      return dryRun
        ? dryRunResult(page, "dry_run_rejection_checkbox", { rejectionText: fillResult.rejectionText })
        : finalResult(page, "rejection_checkbox", { rejectionText: fillResult.rejectionText });
    }
    if (fillResult.dryRunStopped) return dryRunResult(page, "dry_run_first_button_is_final", fillResult);
    if (fillResult.missingCritical || !fillResult.submitted) {
      // 必須項目(本文/送信者名)が埋まらない、または送信ボタンのクリックに失敗した場合、
      // ページ読み込みが完全でなかった可能性を考慮して3秒待って1回だけリトライする
      // (ここで1回リトライした後は、それでも失敗すれば下記のthrowで確実にfailedとして扱う)
      await sleep(3000);
      fillResult = await fillAndSubmit(page, fieldValues, { dryRun, profile });
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
    inputNotes:  inputNotesByPage.get(page) || null,
    ...extra,
  };
}

async function dryRunResult(page, status, extra) {
  const { baselineText, ...rest } = extra; // 本文テキストは結果に含めない
  return finalResult(page, status, { dryRun: true, ...rest });
}

// ==================== 入力補完(項目対応に含まれない欄の補完・取り違え補正) ====================

// 入力処理の補足情報(補完した欄・補正した値)をページ単位で保持し、結果に含める
const inputNotesByPage = new WeakMap();

// 送信者情報。options.profileが無い場合は項目対応の値から推定する
function resolveProfile(fieldValues, given) {
  const byRole = (role) => {
    const f = fieldValues.find((v) => v.role === role && typeof v.value === "string" && v.value);
    return f ? f.value : "";
  };
  const p = given || {};
  return {
    companyName:    p.companyName    || byRole("company_name"),
    personName:     p.personName     || byRole("contact_person_name"),
    personNameKana: p.personNameKana || byRole("contact_person_name_kana"),
    email:          p.email          || byRole("email"),
    phone:          p.phone          || byRole("phone"),
  };
}

// 電話番号を3分割する(ハイフン区切りを優先。ハイフンが無い場合は桁数から推定)
function splitPhone(phone) {
  if (!phone) return null;
  const hyphenParts = phone.split(/[-‐－ー―]/).map((s) => s.trim()).filter(Boolean);
  if (hyphenParts.length === 3) return hyphenParts;
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 11) return [digits.slice(0, 3), digits.slice(3, 7), digits.slice(7)];
  if (digits.length === 10) return [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6)];
  return null;
}

const KANA_LABEL_RE = /ふりがな|フリガナ|ﾌﾘｶﾞﾅ|よみがな|ヨミガナ|かな|カナ|kana|furigana|yomi/i;
const HIRAGANA_LABEL_RE = /ふりがな|ひらがな|よみがな/;
const PERSON_LABEL_RE = /お名前|氏名|名前|ご担当者|担当者名|name/i;
const COMPANY_LABEL_RE = /会社|企業|法人|団体|社名|貴社|御社|組織|屋号|company|corp|organization/i;
const NAME_ROLES = ["contact_person_name", "contact_person_name_kana", "company_name"];

function katakanaToHiragana(s) {
  return (s || "").replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

// 項目対応の役割(role)ではなく、実際の欄のラベル文字列を優先して名前系の入力値を決める。
// リサーチ時の項目対応が並び順等で「ふりがな」欄にcontact_person_nameを割り当てていた場合
// (森建コーポレーション等)でも、ラベルが「ふりがな」ならカナを入力する。
// ラベルは表示テキスト(label/th/dt/placeholder等)を優先し、無い場合のみname/id属性を使う
// (name="corp_s"のような属性名に引きずられて「お名前」欄を社名欄と誤認しないため)
function resolveNameValue(field, label, profile) {
  if (!NAME_ROLES.includes(field.role)) return field.value;
  const text = label.visible || label.attrs || "";
  if (!text) return field.value;
  // カナ欄かどうかは表示ラベルとname/id属性の両方で判定する(行見出しが「お名前」だけで
  // name="namekana"のような欄もあるため)。会社名欄かどうかは表示ラベルのみで判定する
  const isKana = KANA_LABEL_RE.test(text) || /kana|furi|yomi/i.test(label.attrs || "");
  const isPerson = PERSON_LABEL_RE.test(text);
  const isCompany = COMPANY_LABEL_RE.test(text);
  const kanaValue = HIRAGANA_LABEL_RE.test(text) && !/カタカナ/.test(text)
    ? katakanaToHiragana(profile.personNameKana)
    : profile.personNameKana;

  // 「企業名(ふりがな)」「御社名：カナ」等の会社名の欄は、担当者名で上書きしない
  if (isCompany && !isPerson) return field.value;

  if (field.role === "company_name") {
    // 「お名前」欄に社名が割り当てられている場合のみ補正する(「会社名」「貴社名」等はそのまま)
    if (isPerson && !isCompany) return isKana ? (kanaValue || field.value) : (profile.personName || field.value);
    return field.value;
  }
  if (isKana) return kanaValue || field.value;
  if (isPerson) return profile.personName || field.value;
  return field.value;
}

function selectorsOfField(field) {
  const selectors = [];
  if (field.name) selectors.push(`[name="${field.name}"]`);
  if (field.id) selectors.push(`#${field.id}`);
  return selectors;
}

// 「□ 営業目的ではありません」のような確認チェックボックス(チェックを入れて送ると虚偽の申告になる)
const REJECTION_CHECKBOX_RE = /営業(目的|メール|活動|行為|電話)?(の(お問い?合わ?せ|ご?連絡|ご?案内))?(では|で)は?(ありません|ない|ございません)|not\s+(a\s+)?(sales|solicitation)/i;

// ページ内で実行する補助処理。puppeteerのevaluateに関数ごと渡すため、補助関数はすべて内側に定義する
//   mode "labels":     args.selectorLists(項目ごとのセレクタ候補)の各要素について { visible, attrs } を返す
//   mode "rejection":  「営業目的ではありません」等の確認チェックボックスの文言を返す(無ければnull)
//   mode "supplement": 同意チェック・必須の選択肢群・3分割電話番号・確認用メールアドレスを補完し、
//                      行った内容の一覧を返す
function formHelpersInPage(args) {
  const FIELD_SEL = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="image"]):not([type="reset"]), textarea, select';
  const clean = (t) => (t || "").replace(/\s+/g, " ").trim();
  const isVisible = (e) => {
    const r = e.getBoundingClientRect();
    const s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  const ownLabel = (e) => (e.id && document.querySelector(`label[for="${CSS.escape(e.id)}"]`)) || e.closest("label");
  // checkbox/radioはCSSで隠してlabel側を装飾表示することが多いため、labelが見えていれば可視とみなす
  const isVisibleField = (e) => isVisible(e) || (!!ownLabel(e) && isVisible(ownLabel(e)));
  const typeOf = (e) => (e.getAttribute("type") || (e.tagName === "TEXTAREA" ? "textarea" : e.tagName === "SELECT" ? "select" : "text")).toLowerCase();
  const fieldCount = (root) => root.querySelectorAll(FIELD_SEL).length;
  const isSearchForm = (f) => {
    if ((f.getAttribute("role") || "").toLowerCase() === "search") return true;
    if (/(^|\s)search(form)?(\s|$)/.test((f.className || "").toLowerCase())) return true;
    const fields = Array.from(f.querySelectorAll(FIELD_SEL));
    if (fields.length !== 1) return false;
    const el = fields[0];
    return typeOf(el) === "search" || /検索|search/i.test(el.getAttribute("placeholder") || "") || (el.getAttribute("name") || "").toLowerCase() === "s";
  };

  // 単一の欄のラベル文字列(表示テキスト)と属性文字列(name/id)
  const labelInfo = (e) => {
    const parts = [e.getAttribute("placeholder"), e.getAttribute("aria-label"), e.getAttribute("title")];
    const own = ownLabel(e);
    if (own) parts.push(own.innerText);
    const tr = e.closest("tr");
    if (tr && tr.querySelector("th")) parts.push(tr.querySelector("th").innerText);
    const dd = e.closest("dd");
    if (dd && dd.previousElementSibling && dd.previousElementSibling.tagName === "DT") parts.push(dd.previousElementSibling.innerText);
    // この欄だけを含む親要素(最大3階層)のテキストもラベルとみなす
    let p = e.parentElement;
    for (let i = 0; i < 3 && p && p !== document.body; i++, p = p.parentElement) {
      if (fieldCount(p) > 1) break;
      parts.push(p.innerText);
    }
    return {
      visible: clean(parts.filter(Boolean).join(" ")).slice(0, 200),
      attrs: clean([e.getAttribute("name"), e.id].filter(Boolean).join(" ")),
    };
  };

  // 選択肢群(同じnameのcheckbox/radio)の見出し文字列
  const groupHeading = (members) => {
    let c = members[0].parentElement;
    while (c && c !== document.body && !members.every((m) => c.contains(m))) c = c.parentElement;
    if (!c) return "";
    const parts = [];
    const fs = c.closest("fieldset");
    if (fs && fs.querySelector("legend")) parts.push(fs.querySelector("legend").innerText);
    const tr = c.closest("tr");
    if (tr && tr.querySelector("th")) parts.push(tr.querySelector("th").innerText);
    const dd = c.closest("dd");
    if (dd && dd.previousElementSibling && dd.previousElementSibling.tagName === "DT") parts.push(dd.previousElementSibling.innerText);
    if (c.previousElementSibling) parts.push((c.previousElementSibling.innerText || "").slice(0, 80));
    if (c.parentElement && fieldCount(c.parentElement) === fieldCount(c)) parts.push((c.parentElement.innerText || "").slice(0, 200));
    return clean(parts.join(" ")).slice(0, 200);
  };

  const optionText = (e) => clean((ownLabel(e) && ownLabel(e).innerText) || e.value || "");

  // 本文欄(表示中のtextarea)を含むフォームを対象にする。無ければ検索フォーム以外で欄が最も多いフォーム
  const forms = Array.from(document.forms).filter((f) => !isSearchForm(f));
  const target =
    forms.find((f) => Array.from(f.querySelectorAll("textarea")).some(isVisible)) ||
    forms.sort((a, b) => fieldCount(b) - fieldCount(a))[0] ||
    document.body;
  const fields = Array.from(target.querySelectorAll(FIELD_SEL));

  if (args.mode === "labels") {
    return args.selectorLists.map((selectors) => {
      for (const sel of selectors) {
        let el = null;
        try { el = document.querySelector(sel); } catch {}
        if (el) return labelInfo(el);
      }
      return { visible: "", attrs: "" };
    });
  }

  const rejectionRe = new RegExp(args.rejectionSrc, "i");
  // 「営業目的ではありません」等の確認チェックボックス(ページ全体のcheckboxが対象。フォームが
  // JavaScriptで後から描画されることがあるため、入力前と補完前の2回呼ばれる)
  const findRejectionCheckbox = () => {
    // 選択肢が1つだけのradioで「営業目的ではありません」を選ばせるフォームもある(Best House)
    for (const e of document.querySelectorAll('input[type="checkbox"], input[type="radio"]')) {
      // 文言がチェックボックス自身のlabelではなく見出し側(「ご確認 必須 営業目的ではありません」等)に
      // 書かれていることもあるため、見出しも含めて判定する
      const text = clean(`${optionText(e)} ${labelInfo(e).visible} ${groupHeading([e])}`);
      const m = text.match(rejectionRe);
      if (m) return clean(optionText(e) || m[0]).slice(0, 80);
    }
    return null;
  };

  if (args.mode === "rejection") return findRejectionCheckbox();

  // ---- mode "supplement" ----
  // 営業目的でないことの確認チェックには絶対にチェックを入れない(検出した時点で補完せずに返す)
  const lateRejection = findRejectionCheckbox();
  if (lateRejection) return { rejectionText: lateRejection, actions: [] };

  const actions = [];
  const AGREE_RE = /同意|承諾|了承|承認|agree|consent|プライバシー|個人情報|規約|ポリシー/i;
  const ACK_OPTION_RE = /^(確認しました|確認した|了解しました|承知しました|同意する|同意します|はい)$/;
  const OPTIN_RE = /メルマガ|メールマガジン|ニュースレター|newsletter|配信を希望|案内を希望|受け取る|受け取りを希望/i;
  const REQUIRED_MARK_RE = /必須|required|\*|※/i;
  const GENERIC_OPTIONS = ["その他", "お問い合わせ", "お問合せ", "問い合わせ", "問合せ", "ご相談", "相談", "ご質問", "質問", "other", "inquiry", "contact"];
  const GENDER_RE = /^(男|女|男性|女性|回答しない|無回答|その他)$/;

  // required属性のほか、class="validate[required]"(jQuery Validation Engine)等のクラス名による必須指定も見る
  const isRequiredField = (e) => e.required || /(^|[\s[,])required(\]|,|\s|$)/i.test(e.className || "");
  const check = (e) => {
    if (e.checked) return;
    e.click();
    if (!e.checked) {
      e.checked = true;
      e.dispatchEvent(new Event("change", { bubbles: true }));
    }
  };
  const setValue = (e, v) => {
    const proto = e.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(e, v);
    for (const type of ["input", "change", "keyup", "blur"]) e.dispatchEvent(new Event(type, { bubbles: true }));
  };

  // 1. 同意チェック・必須の選択肢群(同じnameのcheckbox/radio)
  const groups = new Map();
  for (const e of fields) {
    const t = typeOf(e);
    if ((t !== "checkbox" && t !== "radio") || !isVisibleField(e)) continue;
    const key = e.getAttribute("name") || `__noname_${groups.size}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  // 単独のチェックボックスのうち、自動で入れる対象(同意系・確認系・required)
  const isAckCandidate = (e, heading) =>
    !OPTIN_RE.test(optionText(e)) &&
    (AGREE_RE.test(`${optionText(e)} ${labelInfo(e).visible} ${heading}`) || ACK_OPTION_RE.test(optionText(e)) || isRequiredField(e));
  // 「確認事項1〜9」のように個別の確認事項(利用規約の各条項等、内容がそれぞれ異なるもの)が
  // 3つ以上並ぶフォームでは、内容を読まずに一括で同意することになるため自動チェックしない。
  // 「個人情報の取り扱いに同意する」のような包括的な同意は、この判定から除いて従来どおり入れる
  const COMPREHENSIVE_AGREE_RE = /個人情報|プライバシー|privacy/i;
  const ackSingles = [];
  // (単独のcheckboxのほか、選択肢が1つだけのradioで「確認しました」を選ばせる形式も対象)
  for (const members of groups.values()) {
    if (members.length !== 1 || members[0].checked) continue;
    const heading = groupHeading(members);
    const text = clean(`${heading} ${optionText(members[0])}`);
    if (isAckCandidate(members[0], heading) && !COMPREHENSIVE_AGREE_RE.test(text)) ackSingles.push({ e: members[0], text });
  }
  const individualAcks = new Set(new Set(ackSingles.map((x) => x.text)).size >= 3 ? ackSingles.map((x) => x.e) : []);

  for (const [name, members] of groups) {
    const heading = groupHeading(members);

    if (members.length === 1 && typeOf(members[0]) === "checkbox") {
      const e = members[0];
      if (e.checked || !isAckCandidate(e, heading)) continue;
      if (individualAcks.has(e)) {
        actions.push(`個別の確認事項のため自動チェックしない: ${heading.slice(0, 20) || name}`);
        continue;
      }
      // 同意系、またはrequired属性付きの単独チェックは入れる(メルマガ購読等のオプトインは除く)
      check(e);
      actions.push(`同意チェック: ${optionText(e).slice(0, 30) || name}`);
      continue;
    }

    if (members.some((m) => m.checked)) continue;
    const required = members.some(isRequiredField) || REQUIRED_MARK_RE.test(heading) || args.subjectNames.includes(name);
    if (!required) continue;

    // 選ぶのは、問い合わせの分類として汎用的な選択肢(その他/お問い合わせ等)、希望連絡方法の
    // 「メール」、確認・同意の選択肢(確認しました等)のみ。それ以外(希望エリア・間取り・続柄・
    // 性別等)は事実と異なる回答になるため推測で選ばず、未選択のまま残す
    const options = members.map((m) => ({ m, text: optionText(m) }));
    let pick = null;
    if (options.every((o) => GENDER_RE.test(o.text))) {
      pick = options.find((o) => /回答しない|無回答/.test(o.text));
    } else {
      // 「入居・購入に関して相談したい」のような具体的な選択肢に「相談」が含まれるだけで選ばないよう、
      // 汎用語を含む短い選択肢(「その他」「お問合せ・ご相談」等、10文字以内)に限る
      for (const g of GENERIC_OPTIONS) {
        pick = options.find((o) => o.text.length <= 10 && o.text.toLowerCase().includes(g.toLowerCase()));
        if (pick) break;
      }
      if (!pick) pick = options.find((o) => /^(メール|e-?mail|Eメール|電子メール)$/i.test(o.text)); // 希望連絡方法
      if (!pick && options.length === 1) pick = options.find((o) => ACK_OPTION_RE.test(o.text));
    }
    if (pick && individualAcks.has(pick.m)) {
      actions.push(`個別の確認事項のため自動チェックしない: ${heading.slice(0, 20) || name}`);
      continue;
    }
    if (pick) {
      check(pick.m);
      actions.push(`必須の選択肢: ${heading.slice(0, 20) || name} → ${pick.text.slice(0, 20)}`);
    } else {
      actions.push(`必須の選択肢(未選択のまま): ${heading.slice(0, 20) || name}`);
    }
  }

  // 2. 3分割の電話番号欄(同名・連番の名前・短い桁数のいずれかで分割欄と判定する)
  if (args.phoneParts) {
    const PHONE_RE = /tel|phone|電話|携帯/i;
    const FAX_RE = /fax|ファックス|ＦＡＸ/i;
    const phoneInputs = fields.filter((e) => {
      if (!["text", "tel", "number"].includes(typeOf(e)) || !isVisible(e)) return false;
      const li = labelInfo(e);
      return PHONE_RE.test(`${li.visible} ${li.attrs}`) && !FAX_RE.test(`${li.attrs} ${ownLabel(e) ? ownLabel(e).innerText : ""}`);
    });
    const done = new Set();
    for (const e of phoneInputs) {
      if (done.has(e)) continue;
      let c = e.parentElement;
      for (let i = 0; i < 3 && c && c !== document.body; i++, c = c.parentElement) {
        const inGroup = phoneInputs.filter((x) => c.contains(x));
        if (inGroup.length < 2) continue;
        if (inGroup.length === 3) {
          const names = inGroup.map((x) => x.getAttribute("name") || x.id || "");
          const sameName = names.every((n) => n && n === names[0]);
          const numbered = names.every((n) => /(1|2|3)\]?$|\[(0|1|2)\]$/.test(n));
          const shortBoxes = inGroup.filter((x) => x.maxLength > 0 && x.maxLength <= 5).length >= 2;
          if (sameName || numbered || shortBoxes) {
            inGroup.forEach((x, idx) => { setValue(x, args.phoneParts[idx]); done.add(x); });
            actions.push(`電話番号を3分割入力: ${names.join(",")}`);
          }
        }
        break;
      }
    }
  }

  // 3. 確認用メールアドレス欄
  if (args.email) {
    for (const e of fields) {
      if (!["email", "text"].includes(typeOf(e)) || !isVisible(e)) continue;
      const li = labelInfo(e);
      const text = `${li.visible} ${li.attrs}`;
      const isMail = /mail|メール/i.test(text);
      const isConfirm = /確認|confirm|再入力|もう一度|再度|again|check|conf|re-?enter/i.test(text) ||
        /(e?mail)[_-]?(2|re|conf|confirm|check|again)$|^re[_-]?e?mail/i.test(li.attrs);
      if (isMail && isConfirm && e.value !== args.email) {
        setValue(e, args.email);
        actions.push(`確認用メールアドレス: ${li.attrs || li.visible.slice(0, 20)}`);
      }
    }
  }

  return { actions };
}

// 欠けると実質的に意味のない問い合わせになってしまう項目。
// message(本文)は必須、company_name/contact_person_nameは「どちらか一方」で足りる
const REQUIRED_ROLE_GROUPS = [
  ["message"],
  ["company_name", "contact_person_name"],
];

async function fillAndSubmit(page, fieldValues, { dryRun = false, profile = resolveProfile(fieldValues) } = {}) {
  // 「営業目的ではありません」等の確認チェックを求めるフォームは実質的な営業お断り。
  // 何も入力・クリックせずに中止する
  const rejectionText = await safeEvaluate(page, formHelpersInPage, null, {
    mode: "rejection", rejectionSrc: REJECTION_CHECKBOX_RE.source,
  });
  if (rejectionText) return { rejectionText, submitted: false, missingCritical: false };

  // 名前系の役割は、実際の欄のラベル(ふりがな/お名前/会社名)に合わせて入力値を補正する
  const labels = await safeEvaluate(page, formHelpersInPage, [], {
    mode: "labels", selectorLists: fieldValues.map(selectorsOfField),
  });
  const valueAdjustments = [];
  const adjustedFields = fieldValues.map((field, i) => {
    const label = labels[i] || { visible: "", attrs: "" };
    const value = resolveNameValue(field, label, profile);
    if (value !== field.value) {
      valueAdjustments.push(`${field.name || field.id}: ${field.role} → 「${value}」(ラベル: ${(label.visible || label.attrs).slice(0, 20)})`);
    }
    return { ...field, value };
  });

  let filledCount = 0;
  let attemptedCount = 0;
  const missingFields = [];
  const filledRoles = new Set();
  for (const field of adjustedFields) {
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

  // 項目対応に含まれない欄(同意チェック・必須の選択肢群・3分割電話番号・確認用メールアドレス)を補完する
  const supplement = await safeEvaluate(page, formHelpersInPage, { actions: [] }, {
    mode: "supplement",
    rejectionSrc: REJECTION_CHECKBOX_RE.source,
    phoneParts: splitPhone(profile.phone),
    email: profile.email,
    subjectNames: fieldValues.filter((f) => f.role === "subject" && f.name).map((f) => f.name),
  });
  // 入力前の時点では描画されていなかった確認チェック(JavaScriptで後から描画されるフォーム)
  if (supplement.rejectionText) return { rejectionText: supplement.rejectionText, submitted: false, missingCritical: false };
  const supplementActions = supplement.actions;
  inputNotesByPage.set(page, { valueAdjustments, supplementActions, missingFields });

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
