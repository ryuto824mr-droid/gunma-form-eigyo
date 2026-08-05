const { sql } = require("./db");

const MODEL = "claude-sonnet-4-6";

const TONE_OPTIONS = ["丁寧", "カジュアル", "熱意重視"];
const LENGTH_OPTIONS = ["短文", "長文"];

const COMPANY_INFO_LABELS = {
  representative: "代表者",
  founded_year: "設立",
  employee_count_text: "従業員数",
  business_description: "事業内容",
  capital: "資本金",
};

function buildCompanyInfoText(companyInfo) {
  if (!companyInfo || typeof companyInfo !== "object") return "";
  return Object.entries(COMPANY_INFO_LABELS)
    .filter(([key]) => companyInfo[key])
    .map(([key, label]) => `${label}: ${companyInfo[key]}`)
    .join("\n");
}

function buildPrompt({ companyName, companyInfo, industry, tone, length }) {
  const resolvedTone = TONE_OPTIONS.includes(tone) ? tone : "丁寧";
  const resolvedLength = LENGTH_OPTIONS.includes(length) ? length : "短文";
  const infoText = buildCompanyInfoText(companyInfo);
  const lengthGuide = resolvedLength === "長文"
    ? "400〜600字程度のやや詳しい文章"
    : "150〜250字程度の簡潔な文章";
  const companyLine = companyName
    ? `企業名: ${companyName}`
    : "企業名: (未指定。特定の企業を想定せず、他の企業にも使い回せる汎用的な文面にしてください)";

  return `あなたは営業メール・お問い合わせフォーム文面のプロのコピーライターです。
以下の条件で、新規営業のお問い合わせ文面を作成してください。

# 差出人(自社)情報
LOCLEという、群馬県を中心に地域企業の採用・広報支援(SNSマーケティング)を行う会社です。

# 送信先企業の情報
${companyLine}
${industry ? `業種: ${industry}\n` : ""}${infoText ? `会社概要:\n${infoText}\n` : ""}
# 文面の条件
- トーン: ${resolvedTone}
- 長さ: ${lengthGuide}
- 送信先企業への配慮を感じられる、パーソナライズされた文面にすること
- ただし文面内で企業名に言及する箇所はすべて "{{company_name}}" というプレースホルダーに置き換えること(実際の企業名の文字列を直接書き込まないこと)。この文面は他の企業にも使い回すテンプレートとして保存されます
- 件名も作成すること(メールでの送信を想定)
- 誇大な表現や虚偽の実績は書かないこと

# 出力形式
以下のJSON形式のみを出力してください。前後に説明文やMarkdownのコードブロック記法は付けないでください。
{"subject": "件名", "body": "本文"}`;
}

async function generateMessageDraft({ companyName, companyInfo, industry, tone, length } = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { configured: false };

  const prompt = buildPrompt({ companyName, companyInfo, industry, tone, length });

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1200,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude APIエラー (${response.status}): ${errText.slice(0, 300)}`);
  }

  const data = await response.json();
  const textBlock = (data.content || []).find(c => c.type === "text");
  if (!textBlock) {
    throw new Error("Claude APIから有効なテキストレスポンスが得られませんでした");
  }

  const cleaned = textBlock.text.replace(/```json|```/g, "").trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error("生成結果をJSONとして解析できませんでした");
  }

  if (!parsed.body || typeof parsed.body !== "string") {
    throw new Error("生成結果にbodyが含まれていません");
  }

  try {
    const inputTokens = data.usage?.input_tokens ?? null;
    const outputTokens = data.usage?.output_tokens ?? null;
    await sql`
      INSERT INTO api_usage_logs (provider, endpoint, input_tokens, output_tokens)
      VALUES ('anthropic', 'generate_message', ${inputTokens}, ${outputTokens})
    `;
  } catch {
    // 利用量ログの記録失敗は本体の文面生成処理には影響させない
  }

  return {
    subject: typeof parsed.subject === "string" ? parsed.subject : "",
    body: parsed.body,
  };
}

module.exports = { generateMessageDraft };
