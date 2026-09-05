const { launchBrowser } = require("./browser");
const { extractCompanyInfo } = require("./company-info-extractor");

const CONTACT_LINK_KEYWORDS = [
  "お問い合わせ", "お問合せ", "お問合わせ", "おといあわせ", "ご相談", "ご依頼",
  "ご連絡", "資料請求",
  "contact", "inquiry", "inquiries", "get in touch", "コンタクト",
  "contact-us", "contactus", "form", "resemble",
];

// 「採用に関するお問い合わせ」のように求人ページの文言にも「お問い合わせ」が
// 含まれることがあり、一般の問い合わせページとスコアが同点になって求人ページが
// 誤って選ばれることがあった。求人・採用系のリンクはこのキーワードで除外し、
// 一般の問い合わせページを優先する
const RECRUITMENT_LINK_KEYWORDS = ["求人", "採用", "recruit", "career", "careers"];

function isRecruitmentLink(link) {
  const lowerHref = (link.href || "").toLowerCase();
  return RECRUITMENT_LINK_KEYWORDS.some((kw) => link.text.includes(kw) || lowerHref.includes(kw));
}

function scoreContactLinks(candidateLinks, keywords) {
  let best = null;
  let bestScore = 0;
  for (const link of candidateLinks) {
    let score = 0;
    for (const kw of keywords) {
      const kwLower = kw.toLowerCase();
      if (link.text.includes(kwLower)) score += 2;
      if (link.href.toLowerCase().includes(kwLower)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = link.href;
    }
  }
  return best;
}

// page.evaluate/frame.evaluateは、ページがクライアントサイド遷移(JSリダイレクト等)の
// 途中だと「Execution context was destroyed」「Navigating frame was detached」等の
// 一過性エラーで例外を投げることがある
const TRANSIENT_NAVIGATION_ERROR_RE = /execution context was destroyed|detached frame|cannot find context with specified id|navigating frame was detached/i;

function isTransientNavigationError(err) {
  return !!(err && TRANSIENT_NAVIGATION_ERROR_RE.test(err.message || ""));
}

// page.evaluate/frame.evaluateをナビゲーション競合に強くするラッパー。
// 一過性のナビゲーションエラーの場合のみ少し待って1回だけリトライし、
// それでも失敗した場合や別種のエラーの場合は例外を投げずfallbackを返して
// warningsに記録する(analyzeForm全体がクラッシュするのを防ぐため)
async function safeEvaluate(target, evaluateFn, args, { warnings, label, fallback }) {
  try {
    return await target.evaluate(evaluateFn, ...args);
  } catch (err) {
    if (!isTransientNavigationError(err)) {
      warnings.push(`${label}: ${err.message}`);
      return fallback;
    }
    try {
      await new Promise((r) => setTimeout(r, 800));
      return await target.evaluate(evaluateFn, ...args);
    } catch (err2) {
      warnings.push(`${label}: ${err2.message}(リトライ後も失敗)`);
      return fallback;
    }
  }
}

const REJECTION_PATTERNS = [
  "営業はお断り", "営業お断り", "セールスはお断り",
  "営業目的はお断り", "営業目的でのお問い合わせはお断り",
  "同業他社からのお問い合わせはお断り",
  "we do not accept sales", "no solicitation",
  "solicitations are not accepted",
  // 「勧誘・広告・セールスを目的とした営業メールは固くお断りいたします」のように、
  // 「は」と「お断り」の間に修飾語(固く/堅く/厳に等)が入る言い回しに未対応だったため追加。
  // 「固くお断り」は営業・勧誘拒否の文脈以外ではほぼ使われないため、それ単体でも
  // 強いシグナルとして扱う
  "固くお断り", "堅くお断り", "厳にお断り",
  "勧誘・広告・セールス", "勧誘や広告、セールス", "広告・勧誘目的",
  "セールスのご連絡はご遠慮", "営業のご連絡はご遠慮", "勧誘のご連絡はご遠慮",
  "unsolicited sales", "unsolicited commercial", "we do not solicit",
  // 追加バリエーション(ユーザー指摘分)
  "勧誘、広告、セールス", "セールスを目的とした",
  "営業メールは固くお断り", "営業目的のメールは固くお断り",
  "営業・勧誘目的でのご連絡はお断り", "商品やサービスの勧誘",
  "営業活動を目的とした", "業者からの営業", "セールス・勧誘の電話",
];

// 完全一致パターンでは拾えない言い回し向けの近接共起検出。
// 「固くお断り」等の断定的な拒否表現と、「営業」等の営業関連キーワードが
// 前後50文字以内に共に出現する場合も、営業お断りの文脈とみなす
const REFUSAL_KEYWORDS = [
  "固くお断り", "堅くお断り", "厳にお断り", "お断りいたします", "お断りします",
  "お断り申し上げます", "ご遠慮ください", "ご遠慮願います", "ご遠慮申し上げます",
];
const SALES_KEYWORDS = ["営業", "勧誘", "セールス", "広告"];
const PROXIMITY_WINDOW_CHARS = 50;

function findProximityRejection(text) {
  for (const refusal of REFUSAL_KEYWORDS) {
    let idx = text.indexOf(refusal);
    while (idx !== -1) {
      const windowStart = Math.max(0, idx - PROXIMITY_WINDOW_CHARS);
      const windowEnd = Math.min(text.length, idx + refusal.length + PROXIMITY_WINDOW_CHARS);
      const surrounding = text.slice(windowStart, windowEnd);
      const salesHit = SALES_KEYWORDS.find((k) => surrounding.includes(k));
      if (salesHit) {
        return `${salesHit}+${refusal}(近接共起)`;
      }
      idx = text.indexOf(refusal, idx + refusal.length);
    }
  }
  return null;
}

const CANONICAL_FIELD_ROLES = [
  "company_name",
  "contact_person_name",
  "contact_person_name_kana",
  "email",
  "phone",
  "department",
  "postal_code",
  "address",
  "subject",
  "message",
  "budget",
  "url_website",
  "agreement_checkbox",
  "other",
];

// セキュリティプラグイン(WAF)がbot的なアクセスを403等で明示的に拒否している場合の
// 検出パターン。403等のステータスコードに加え、可能であれば製品名まで特定する
const WAF_PRODUCT_SIGNATURES = [
  { name: "NinjaFirewall", pattern: /ninjafirewall/i },
  { name: "Wordfence", pattern: /wordfence/i },
  { name: "Sucuri", pattern: /sucuri\s*(website\s*firewall|waf)/i },
  { name: "Incapsula/Imperva", pattern: /incapsula|imperva/i },
  { name: "Cloudflare", pattern: /attention required[!,.]?\s*\|\s*cloudflare|cloudflare ray id/i },
];
const WAF_BLOCK_HTTP_STATUSES = [401, 403, 406, 429];

async function detectAccessBlocked(page, response) {
  const status = response ? response.status() : null;
  if (!WAF_BLOCK_HTTP_STATUSES.includes(status)) return null;

  const pageText = await page
    .evaluate(() => `${document.title || ""} ${document.body ? document.body.innerText : ""}`)
    .catch(() => "");
  const matchedProduct = WAF_PRODUCT_SIGNATURES.find((p) => p.pattern.test(pageText));

  if (matchedProduct) {
    return `セキュリティにより自動アクセスがブロックされています(検出: ${matchedProduct.name}, HTTP ${status})。手動対応が必要です`;
  }
  // 具体的な製品名までは特定できなくても、403等はサイト側が明示的にアクセスを
  // 拒否していることを示す強いシグナルのため、同様に「要手動対応」として扱う
  return `セキュリティにより自動アクセスがブロックされています(HTTP ${status})。手動対応が必要です`;
}

async function analyzeForm(url) {
  let targetUrl;
  try {
    targetUrl = new URL(url).toString();
  } catch {
    throw new Error("urlの形式が正しくありません");
  }

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    );
    await page.setViewport({ width: 1280, height: 900 });

    const topResponse = await page.goto(targetUrl, { waitUntil: "networkidle2", timeout: 20000 });

    // NinjaFirewall/Wordfence等のセキュリティプラグインが自動アクセスを403等で遮断している
    // 場合、いくら再試行してもコード側では解決できないため、早期に判定して「要手動対応」として扱う
    const accessBlockedReason = await detectAccessBlocked(page, topResponse);
    if (accessBlockedReason) {
      return {
        sourceUrl: targetUrl,
        formPageUrl: targetUrl,
        formFound: false,
        forms: [],
        captchaDetected: false,
        automatable: false,
        rejection_detected: false,
        rejection_text: null,
        fieldMapping: null,
        mappingSource: "heuristic",
        aiError: null,
        extractedEmail: null,
        companyInfo: null,
        iframeFormDetected: false,
        iframeUrls: [],
        analysisWarnings: [],
        accessBlocked: true,
        accessBlockedReason,
      };
    }

    // page.evaluate系の呼び出しでナビゲーション競合等の例外が起きても
    // analyzeForm全体をクラッシュさせず、内容をここに記録して結果に含める
    const warnings = [];

    // 会社概要情報の抽出はフォーム解析と並行して別タブで実行する
    const companyInfoPromise = extractCompanyInfoSafely(browser, targetUrl);

    const contactUrl = await findContactLink(page, targetUrl, false, warnings);
    let formPageUrl = targetUrl;

    if (contactUrl && contactUrl !== targetUrl) {
      try {
        await page.goto(contactUrl, { waitUntil: "networkidle2", timeout: 20000 });
        formPageUrl = contactUrl;
      } catch {
        // 遷移に失敗してもトップページの解析結果で続行する
      }
    }

    let forms = await extractFormsWithRetry(page, warnings);
    if (forms.length === 0 && contactUrl === null) {
      const fallbackUrl = await findContactLink(page, targetUrl, true, warnings);
      if (fallbackUrl && fallbackUrl !== formPageUrl) {
        try {
          await page.goto(fallbackUrl, { waitUntil: "networkidle2", timeout: 20000 });
          formPageUrl = fallbackUrl;
          forms = await extractFormsWithRetry(page, warnings);
        } catch {
          // 失敗時は無視
        }
      }
    }

    // 最終確認: ここまでの手順(トップページ→お問い合わせリンク→広義キーワード探索)で
    // フォームが見つからなかった場合、まだ訪問していない「お問い合わせ/contact/form」系
    // リンクがもう無いか改めて探し、あれば最後にもう1回だけ追加でアクセスする
    if (forms.length === 0) {
      const lastResortUrl = await findContactLink(page, targetUrl, true, warnings);
      if (lastResortUrl && lastResortUrl !== formPageUrl) {
        try {
          await page.goto(lastResortUrl, { waitUntil: "networkidle2", timeout: 20000 });
          formPageUrl = lastResortUrl;
          forms = await extractFormsWithRetry(page, warnings);
        } catch {
          // 失敗時は無視
        }
      }
    }

    // それでも見つからない場合、最後にiframe内も確認する
    let iframeForms = [];
    let iframeUrls = [];
    if (forms.length === 0) {
      const iframeResult = await findFormsInFrames(page, warnings).catch(() => ({ iframeForms: [], inaccessibleIframes: [] }));
      iframeForms = iframeResult.iframeForms;
      iframeUrls = iframeResult.inaccessibleIframes;
      if (iframeForms.length > 0) {
        forms = iframeForms;
      }
    }
    // アクセスできたiframe内フォームは通常のformFoundとして扱うが、クロスオリジン等で
    // 中身を解析できなかったiframeが見つかった場合は「手動確認推奨」の目印として残す
    const iframeFormDetected = forms.length === 0 && iframeUrls.length > 0;

    const captchaDetected = await detectCaptcha(page, warnings);
    const rejection = await detectRejection(page, warnings);
    const automatable = forms.length > 0 && !captchaDetected && !rejection.detected;
    const extractedEmail = await extractEmailFromPage(page, warnings);

    // まずキーワードベースで推定（APIキーなしで常に動く）
    let fieldMapping = forms.length > 0 ? heuristicFieldMapping(forms) : null;
    let mappingSource = "heuristic";
    let aiError = null;

    // ANTHROPIC_API_KEYが設定されていればAIでの推定を試みて、成功すれば上書きする
    if (forms.length > 0 && process.env.ANTHROPIC_API_KEY) {
      try {
        fieldMapping = await mapFieldsWithAI(forms);
        mappingSource = "ai";
      } catch (err) {
        aiError = err.message;
      }
    }

    const companyInfo = await companyInfoPromise;

    return {
      sourceUrl: targetUrl,
      formPageUrl,
      formFound: forms.length > 0,
      forms,
      captchaDetected,
      automatable,
      rejection_detected: rejection.detected,
      rejection_text: rejection.text,
      fieldMapping,
      mappingSource,
      aiError,
      extractedEmail,
      companyInfo,
      iframeFormDetected,
      iframeUrls,
      analysisWarnings: warnings,
    };
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
}

// フォーム解析用のページとは別タブで会社概要情報を抽出する。
// タブの起動・遷移自体に失敗した場合はnullを返し、呼び出し元で既存データを維持できるようにする
async function extractCompanyInfoSafely(browser, targetUrl) {
  let infoPage;
  try {
    infoPage = await browser.newPage();
    await infoPage.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    );
    await infoPage.setViewport({ width: 1280, height: 900 });
    await infoPage.goto(targetUrl, { waitUntil: "networkidle2", timeout: 20000 });
    return await extractCompanyInfo(infoPage);
  } catch {
    return null;
  } finally {
    if (infoPage) {
      try { await infoPage.close(); } catch {}
    }
  }
}


async function findContactLink(page, baseUrl, broaden = false, warnings = []) {
  const keywords = CONTACT_LINK_KEYWORDS;
  const links = await safeEvaluate(
    page,
    (kws) => {
      const anchors = Array.from(document.querySelectorAll("a[href]"));
      return anchors
        .map((a) => ({
          // SVG内の<a>要素は.hrefがSVGAnimatedString(文字列でない)を返すため、
          // 文字列でない場合は空文字扱いにしてフィルタで除外する
          href: typeof a.href === "string" ? a.href : "",
          text: (a.textContent || "").trim().toLowerCase(),
        }))
        .filter((a) => a.href && !a.href.startsWith("javascript:"));
    },
    [keywords],
    { warnings, label: "findContactLink", fallback: [] }
  );

  // 「採用に関するお問い合わせ」のように求人ページの文言にも「お問い合わせ」が
  // 含まれ、一般の問い合わせページとスコアが同点になって求人ページが誤って
  // 選ばれることがあった。まず求人・採用系を除いた候補から探し、
  // 見つからない場合のみ求人系も含めて再探索する(候補が求人ページしかない
  // サイトでは、それでも一応の手がかりとして返す)
  const nonRecruitmentLinks = links.filter((l) => !isRecruitmentLink(l));
  const best = scoreContactLinks(nonRecruitmentLinks, keywords) || scoreContactLinks(links, keywords);

  if (best) return best;
  if (!broaden) return null;

  const nonRecruitmentBroaden = links.filter((l) => !isRecruitmentLink(l));
  for (const link of nonRecruitmentBroaden) {
    if (/form|フォーム/i.test(link.text) || /form/i.test(link.href)) {
      return link.href;
    }
  }
  for (const link of links) {
    if (/form|フォーム/i.test(link.text) || /form/i.test(link.href)) {
      return link.href;
    }
  }
  return null;
}

// page.evaluate/frame.evaluateはシリアライズして渡すため、外部の変数・関数を参照しない
// 自己完結した関数にしておく必要がある(iframe内フォームの探索でも同じ関数を再利用するため)
function extractFormsInBrowserContext() {
  function getLabelText(el) {
    if (el.id) {
      const lbl = document.querySelector(`label[for="${el.id}"]`);
      if (lbl) return lbl.textContent.trim();
    }
    const parentLabel = el.closest("label");
    if (parentLabel) return parentLabel.textContent.trim();
    const prev = el.previousElementSibling;
    if (prev && prev.textContent) {
      const t = prev.textContent.trim();
      if (t && t.length < 60) return t;
    }
    return el.getAttribute("aria-label") || el.getAttribute("placeholder") || "";
  }

  // WordPress標準の検索ボックス等、お問い合わせフォームではない<form>を除外する。
  // お問い合わせフォームは通常複数項目を持つため、入力欄が1つだけのケースに限定して
  // 判定することで、複数項目を持つ本物のお問い合わせフォームを誤って除外しないようにする
  function isSearchForm(form) {
    if ((form.getAttribute("role") || "").toLowerCase() === "search") return true;
    const cls = (form.className || "").toLowerCase();
    if (/(^|\s)search(form)?(\s|$)/.test(cls)) return true;

    const fieldEls = Array.from(form.querySelectorAll("input, textarea, select")).filter((el) => {
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
  }

  const forms = Array.from(document.querySelectorAll("form")).filter((f) => !isSearchForm(f));
  return forms.map((form, formIndex) => {
    const fieldEls = Array.from(
      form.querySelectorAll("input, textarea, select")
    ).filter((el) => {
      const type = (el.getAttribute("type") || "").toLowerCase();
      return !["hidden", "submit", "button", "image", "reset"].includes(type);
    });

    const fields = fieldEls.map((el) => ({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type") || (el.tagName.toLowerCase() === "select" ? "select" : "text"),
      name: el.getAttribute("name") || "",
      id: el.getAttribute("id") || "",
      placeholder: el.getAttribute("placeholder") || "",
      required: el.hasAttribute("required"),
      label: getLabelText(el),
      options:
        el.tagName.toLowerCase() === "select"
          ? Array.from(el.querySelectorAll("option")).map((o) => o.textContent.trim())
          : undefined,
    }));

    return {
      formIndex,
      action: form.getAttribute("action") || "",
      method: (form.getAttribute("method") || "get").toLowerCase(),
      fieldCount: fields.length,
      fields,
    };
  }).filter((f) => f.fieldCount > 0);
}

async function extractForms(page, warnings) {
  return safeEvaluate(page, extractFormsInBrowserContext, [], {
    warnings,
    label: "extractForms",
    fallback: [],
  });
}

// フォームが即座に見つからない場合、JavaScriptによる動的なDOM追加を考慮して
// 2.5秒待ってから再度探索する
async function extractFormsWithRetry(page, warnings) {
  let forms = await extractForms(page, warnings);
  if (forms.length === 0) {
    await new Promise((r) => setTimeout(r, 2500));
    forms = await extractForms(page, warnings);
  }
  return forms;
}

// 無関係なiframe(広告・計測タグ・地図埋め込み等)を除外するためのパターン
const IFRAME_IGNORE_PATTERNS = [
  /doubleclick|googlesyndication|googletagmanager|google-analytics|googleadservices/i,
  /facebook\.com\/(tr|plugins)/i,
  /youtube\.com\/embed|player\.vimeo\.com/i,
  /maps\.google|google\.com\/maps/i,
  /twitter\.com\/widgets|platform\.twitter/i,
];

// メインページ・訪問先ページでフォームが見つからなかった場合の最終手段として、
// ページ内のiframeも確認する。同一オリジンやCDP経由でアクセスできるフレームは
// 中のフォームまで解析し、クロスオリジン等でアクセスできないフレームは
// URLにフォーム関連キーワードが含まれる場合のみ「iframe内にフォームがある可能性」
// として記録する(手動確認の目印用。誤検知を避けるため無条件では記録しない)
async function findFormsInFrames(page, warnings) {
  const iframeForms = [];
  const inaccessibleIframes = [];

  const frames = page.frames().filter((f) => f !== page.mainFrame());
  for (const frame of frames) {
    const frameUrl = frame.url();
    if (!frameUrl || frameUrl === "about:blank") continue;
    if (IFRAME_IGNORE_PATTERNS.some((p) => p.test(frameUrl))) continue;

    let forms = null;
    try {
      forms = await frame.evaluate(extractFormsInBrowserContext);
    } catch (err) {
      // 一過性のナビゲーション競合の場合のみ少し待って1回だけリトライする。
      // クロスオリジン制約等の恒久的なエラーはリトライしても無駄なのでそのまま扱う
      if (isTransientNavigationError(err)) {
        try {
          await new Promise((r) => setTimeout(r, 800));
          forms = await frame.evaluate(extractFormsInBrowserContext);
        } catch (err2) {
          warnings.push(`findFormsInFrames(${frameUrl}): ${err2.message}(リトライ後も失敗)`);
        }
      }
    }

    if (forms && forms.length > 0) {
      forms.forEach((f) => iframeForms.push({ ...f, iframeSrc: frameUrl }));
    } else if (forms === null) {
      // クロスオリジン制約・リトライ後も失敗した場合、
      // URLからフォームらしさを推定できるものだけ「手動確認推奨」として拾う
      if (/form|contact|inquiry|toiawase|問い合わせ|お問合せ/i.test(frameUrl)) {
        inaccessibleIframes.push(frameUrl);
      }
    }
  }

  return { iframeForms, inaccessibleIframes };
}

const EMAIL_EXCLUDED_DOMAINS = ["example.com", "test.com", "xxx.com"];
const EMAIL_IMAGE_EXT_RE     = /\.(png|jpe?g|gif|svg|webp|bmp|ico)$/i;
const EMAIL_PRIORITY_PREFIXES = ["info@", "contact@", "inquiry@", "support@", "sales@", "admin@"];

async function extractEmailFromPage(page, warnings) {
  const rawEmails = await safeEvaluate(
    page,
    () => {
      const found = new Set();

      // mailto:リンク
      document.querySelectorAll('a[href^="mailto:"]').forEach((a) => {
        const addr = a.getAttribute("href").replace(/^mailto:/i, "").split("?")[0].trim();
        if (addr) found.add(addr);
      });

      // テキスト内のメールアドレスパターン
      const text = document.body.innerText || "";
      const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
      (text.match(EMAIL_RE) || []).forEach((m) => found.add(m));

      // スクレイピング対策で「@」を別表記に置き換えて難読化されたメールアドレスにも対応する。
      // 「@」に相当する部分だけ通常の「@」に正規化した文字列を作り、同じ正規表現で再抽出する

      // 例: "info[アットマーク]example.com" "info（アットマーク）example.com" "info アットマーク example.com"
      const atMarkNormalized = text
        .replace(/[\(（\[]\s*アットマーク\s*[\)）\]]/g, "@")
        .replace(/\s*アットマーク\s*/g, "@");
      (atMarkNormalized.match(EMAIL_RE) || []).forEach((m) => found.add(m));

      // 例: "info＠example.com"(全角アットマーク)
      const fullwidthAtNormalized = text.replace(/＠/g, "@");
      (fullwidthAtNormalized.match(EMAIL_RE) || []).forEach((m) => found.add(m));

      // 例: "info(at)example.com" "info[at]example.com"
      const atBracketNormalized = text.replace(/[\(（\[]\s*at\s*[\)）\]]/gi, "@");
      (atBracketNormalized.match(EMAIL_RE) || []).forEach((m) => found.add(m));

      // 例: "info at example dot com"(英語のスペース区切り表記)
      const atDotRe = /\b([a-zA-Z0-9._%+-]+)\s+at\s+([a-zA-Z0-9-]+(?:\s+dot\s+[a-zA-Z0-9-]+)+)\b/gi;
      let atDotMatch;
      while ((atDotMatch = atDotRe.exec(text)) !== null) {
        const domain = atDotMatch[2].replace(/\s+dot\s+/gi, ".");
        found.add(`${atDotMatch[1]}@${domain}`);
      }

      // 例: "infoアットexample.com"(括弧や空白を伴わない「アット」単体表記。
      // 「アットマーク」は既に上のブロックで正規化済みだが、"アット"のみに置き換える
      // サイトもあるため別途対応する。置き換え後に正規のメール形式に一致した場合のみ
      // 採用するため、"アットホーム"等の無関係な単語を誤って拾うリスクは低い)
      const atOnlyNormalized = text.replace(/アット/g, "@");
      (atOnlyNormalized.match(EMAIL_RE) || []).forEach((m) => found.add(m));

      return Array.from(found);
    },
    [],
    { warnings, label: "extractEmailFromPage", fallback: [] }
  );

  const candidates = rawEmails
    .map((e) => e.trim().toLowerCase())
    .filter((e) => {
      const domain = (e.split("@")[1] || "").trim();
      if (EMAIL_EXCLUDED_DOMAINS.includes(domain)) return false;
      if (EMAIL_IMAGE_EXT_RE.test(e)) return false;
      return true;
    });

  if (candidates.length === 0) return null;

  const priority = candidates.find((e) =>
    EMAIL_PRIORITY_PREFIXES.some((p) => e.startsWith(p))
  );
  return priority || candidates[0];
}

async function detectCaptcha(page, warnings) {
  return safeEvaluate(
    page,
    () => {
      // Wixなどのプラットフォームが埋め込む内部設定JSON(sitefeatures一覧等)に
      // "captcha"という文字列がたまたま含まれているだけで、実際にはCAPTCHAが
      // 描画されていないケースがある。innerHTML全体の文字列一致では区別できないため、
      // 実際にDOM上へ描画されている(サイズを持つ)CAPTCHA関連要素の有無で判定する
      function isRendered(el) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return false;
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return false;
        return true;
      }

      const CAPTCHA_ELEMENT_SELECTORS = [
        'iframe[src*="recaptcha"]',
        'iframe[src*="hcaptcha"]',
        'iframe[src*="turnstile"]',
        ".g-recaptcha",
        ".h-captcha",
        ".cf-turnstile",
        '[class*="captcha"]',
        '[id*="captcha"]',
      ];

      for (const selector of CAPTCHA_ELEMENT_SELECTORS) {
        const elements = document.querySelectorAll(selector);
        for (const el of elements) {
          if (isRendered(el)) return true;
        }
      }
      return false;
    },
    [],
    { warnings, label: "detectCaptcha", fallback: false }
  );
}

async function detectRejection(page, warnings) {
  const text = await safeEvaluate(page, () => document.body.innerText || "", [], {
    warnings,
    label: "detectRejection",
    fallback: "",
  });
  const lower = text.toLowerCase();
  for (const pattern of REJECTION_PATTERNS) {
    if (lower.includes(pattern.toLowerCase())) {
      return { detected: true, text: pattern };
    }
  }
  const proximityMatch = findProximityRejection(text);
  if (proximityMatch) {
    return { detected: true, text: proximityMatch };
  }
  return { detected: false, text: null };
}

const HEURISTIC_RULES = [
  { role: "email", patterns: [/mail/i, /メール/, /Eメール/i] },
  { role: "phone", patterns: [/tel/i, /phone/i, /電話/, /TEL/] },
  { role: "company_name", patterns: [/company/i, /会社/, /企業/, /法人/, /貴社/] },
  { role: "contact_person_name_kana", patterns: [/kana/i, /フリガナ/, /ふりがな/, /カナ/] },
  { role: "contact_person_name", patterns: [/name/i, /氏名/, /お名前/, /担当者/, /姓/, /名/] },
  { role: "department", patterns: [/department/i, /部署/, /部門/] },
  { role: "postal_code", patterns: [/zip/i, /postal/i, /郵便番号/, /〒/] },
  { role: "address", patterns: [/address/i, /住所/, /所在地/] },
  { role: "subject", patterns: [/subject/i, /件名/, /タイトル/, /種別/, /category/i] },
  { role: "budget", patterns: [/budget/i, /予算/, /金額/] },
  { role: "url_website", patterns: [/url/i, /website/i, /ホームページ/, /サイトURL/i] },
  { role: "agreement_checkbox", patterns: [/agree/i, /privacy/i, /個人情報/, /同意/, /プライバシー/] },
  {
    role: "message",
    patterns: [/message/i, /content/i, /本文/, /内容/, /ご相談/, /お問い合わせ内容/, /詳細/, /comment/i],
  },
];

function guessRole(field) {
  const haystack = [field.name, field.id, field.label, field.placeholder]
    .filter(Boolean)
    .join(" ");
  for (const rule of HEURISTIC_RULES) {
    if (rule.patterns.some((p) => p.test(haystack))) {
      return { role: rule.role, confidence: "medium" };
    }
  }
  if (field.tag === "textarea") {
    return { role: "message", confidence: "low" };
  }
  return { role: "other", confidence: "low" };
}

function heuristicFieldMapping(forms) {
  const result = [];
  for (const form of forms) {
    for (const field of form.fields) {
      const { role, confidence } = guessRole(field);
      result.push({
        formIndex: form.formIndex,
        name: field.name,
        id: field.id,
        role,
        confidence,
      });
    }
  }
  return result;
}

async function mapFieldsWithAI(forms) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY が環境変数に設定されていません");
  }

  const simplifiedForms = forms.map((f) => ({
    formIndex: f.formIndex,
    fields: f.fields.map((field) => ({
      name: field.name,
      id: field.id,
      label: field.label,
      placeholder: field.placeholder,
      type: field.type,
    })),
  }));

  const prompt = `以下はWebページから抽出したフォームのフィールド一覧です。
各フィールドが何を入力する項目か推定し、次のカテゴリのいずれかに分類してください: ${CANONICAL_FIELD_ROLES.join(", ")}

入力データ:
${JSON.stringify(simplifiedForms, null, 2)}

出力形式: 以下のJSON配列のみを出力してください。説明文やコードブロックの記号(\`\`\`)は一切含めないでください。
[
  { "formIndex": 0, "name": "フィールドのname属性", "id": "フィールドのid属性", "role": "上記カテゴリのいずれか", "confidence": "high" | "medium" | "low" }
]`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`Claude APIエラー (status ${response.status}): ${bodyText.slice(0, 300)}`);
  }

  const data = await response.json();
  const textBlock = (data.content || []).find((c) => c.type === "text");
  if (!textBlock) {
    throw new Error("Claude APIのレスポンスにテキストが含まれていません");
  }

  const cleaned = textBlock.text.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error(`Claude APIの出力をJSONとして解析できませんでした: ${cleaned.slice(0, 300)}`);
  }
}

module.exports = { analyzeForm };
