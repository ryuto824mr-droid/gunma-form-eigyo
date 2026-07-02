const { launchBrowser } = require("./browser");

const CONTACT_LINK_KEYWORDS = [
  "お問い合わせ", "お問合せ", "おといあわせ", "ご相談", "ご依頼",
  "contact", "inquiry", "inquiries", "get in touch", "コンタクト",
];

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

    await page.goto(targetUrl, { waitUntil: "networkidle2", timeout: 20000 });

    const contactUrl = await findContactLink(page, targetUrl);
    let formPageUrl = targetUrl;

    if (contactUrl && contactUrl !== targetUrl) {
      try {
        await page.goto(contactUrl, { waitUntil: "networkidle2", timeout: 20000 });
        formPageUrl = contactUrl;
      } catch {
        // 遷移に失敗してもトップページの解析結果で続行する
      }
    }

    let forms = await extractForms(page);
    if (forms.length === 0 && contactUrl === null) {
      const fallbackUrl = await findContactLink(page, targetUrl, true);
      if (fallbackUrl && fallbackUrl !== formPageUrl) {
        try {
          await page.goto(fallbackUrl, { waitUntil: "networkidle2", timeout: 20000 });
          formPageUrl = fallbackUrl;
          forms = await extractForms(page);
        } catch {
          // 失敗時は無視
        }
      }
    }

    const captchaDetected = await detectCaptcha(page);
    const automatable = forms.length > 0 && !captchaDetected;

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

    return {
      sourceUrl: targetUrl,
      formPageUrl,
      formFound: forms.length > 0,
      forms,
      captchaDetected,
      automatable,
      fieldMapping,
      mappingSource,
      aiError,
    };
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
}


async function findContactLink(page, baseUrl, broaden = false) {
  const keywords = CONTACT_LINK_KEYWORDS;
  const links = await page.evaluate((kws) => {
    const anchors = Array.from(document.querySelectorAll("a[href]"));
    return anchors
      .map((a) => ({
        href: a.href,
        text: (a.textContent || "").trim().toLowerCase(),
      }))
      .filter((a) => a.href && !a.href.startsWith("javascript:"));
  }, keywords);

  let best = null;
  let bestScore = 0;
  for (const link of links) {
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

  if (best) return best;
  if (!broaden) return null;

  for (const link of links) {
    if (/form|フォーム/i.test(link.text) || /form/i.test(link.href)) {
      return link.href;
    }
  }
  return null;
}

async function extractForms(page) {
  return page.evaluate(() => {
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

    const forms = Array.from(document.querySelectorAll("form"));
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
  });
}

async function detectCaptcha(page) {
  return page.evaluate(() => {
    const html = document.documentElement.innerHTML.toLowerCase();
    const patterns = ["recaptcha", "hcaptcha", "cf-turnstile", "g-recaptcha", "captcha"];
    return patterns.some((p) => html.includes(p));
  });
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
