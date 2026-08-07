const { sql } = require("./db");

const MODEL = "claude-sonnet-4-6";

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

function companyLine(companyName) {
  return companyName
    ? `企業名: ${companyName}`
    : "企業名: (未指定。特定の企業を想定せず、汎用的な内容にしてください)";
}

// Claude APIを呼び出し、JSON形式のレスポンスをパースして返す共通処理。
// ANTHROPIC_API_KEY未設定時は { configured: false } を返す(呼び出し元で個別に判定する)。
async function callClaudeForJson(prompt, maxTokens) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { configured: false };

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
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

  return { parsed, usage: data.usage };
}

async function logUsage(endpoint, usage) {
  try {
    const inputTokens = usage?.input_tokens ?? null;
    const outputTokens = usage?.output_tokens ?? null;
    await sql`
      INSERT INTO api_usage_logs (provider, endpoint, input_tokens, output_tokens)
      VALUES ('anthropic', ${endpoint}, ${inputTokens}, ${outputTokens})
    `;
  } catch {
    // 利用量ログの記録失敗は本体の生成処理には影響させない
  }
}

// ==================== Reels台本 ====================

function buildReelsPrompt({ companyName, companyInfo, theme }) {
  const infoText = buildCompanyInfoText(companyInfo);
  return `あなたは採用・広報向けショート動画のプロの構成作家です。
「群馬お仕事図鑑」という、群馬県内の企業で働くリアルな様子を伝えるショート動画メディア向けに、
15〜30秒のReels/TikTok台本を作成してください。

# 送信先企業の情報
${companyLine(companyName)}
${infoText ? `会社概要:\n${infoText}\n` : ""}
# テーマ
${theme || "(未指定。会社概要から適切なテーマを推測してください)"}

# 台本の条件
- 15〜30秒で見きれる分量にすること(シーンは3〜6個程度)
- 冒頭2〜3秒で視聴者の興味を引く「フック」を用意すること
- 若手求職者(10代後半〜20代)が親近感を持てる、明るく自然なトーンにすること
- 誇大な表現や虚偽の実績は書かないこと

# 出力形式
以下のJSON形式のみを出力してください。前後に説明文やMarkdownのコードブロック記法は付けないでください。
{
  "hook": "冒頭のフック文言",
  "scenes": [
    { "description": "映像の説明(どこで何を映すか)", "dialogue": "ナレーション・セリフ", "duration_sec": 5 }
  ],
  "caption": "SNS投稿用キャプション文"
}`;
}

async function generateReelsScript({ companyName, companyInfo, theme } = {}) {
  const prompt = buildReelsPrompt({ companyName, companyInfo, theme });
  const result = await callClaudeForJson(prompt, 1500);
  if (result.configured === false) return { configured: false };

  const { parsed, usage } = result;
  if (!Array.isArray(parsed.scenes) || parsed.scenes.length === 0) {
    throw new Error("生成結果にscenesが含まれていません");
  }

  await logUsage("generate_reels_script", usage);

  return {
    hook: typeof parsed.hook === "string" ? parsed.hook : "",
    scenes: parsed.scenes.map(s => ({
      description: typeof s.description === "string" ? s.description : "",
      dialogue: typeof s.dialogue === "string" ? s.dialogue : "",
      duration_sec: Number.isFinite(Number(s.duration_sec)) ? Number(s.duration_sec) : null,
    })),
    caption: typeof parsed.caption === "string" ? parsed.caption : "",
  };
}

// ==================== SNS投稿文 ====================

const SOCIAL_PLATFORMS = ["Instagram", "TikTok", "X"];

function buildSocialPostPrompt({ companyName, companyInfo, platform, tone }) {
  const infoText = buildCompanyInfoText(companyInfo);
  const resolvedPlatform = SOCIAL_PLATFORMS.includes(platform) ? platform : "Instagram";
  return `あなたはSNS運用のプロのコピーライターです。
「群馬お仕事図鑑」という、群馬県内の企業で働くリアルな様子を伝えるショート動画メディアの
公式アカウント向けに、${resolvedPlatform}の投稿文を作成してください。

# 送信先企業の情報
${companyLine(companyName)}
${infoText ? `会社概要:\n${infoText}\n` : ""}
# 条件
- トーン: ${tone || "親しみやすく、若者に語りかけるようなトーン"}
- ${resolvedPlatform}の文化・文字数感に合わせること(Instagramは改行を活かした読みやすい構成、TikTokは短く勢いのある文章、Xは140字程度で簡潔に)
- ハッシュタグを5〜8個程度、本文とは別に用意すること
- 誇大な表現や虚偽の実績は書かないこと

# 出力形式
以下のJSON形式のみを出力してください。前後に説明文やMarkdownのコードブロック記法は付けないでください。
{
  "text": "投稿本文",
  "hashtags": ["タグ1", "タグ2"]
}`;
}

async function generateSocialPost({ companyName, companyInfo, platform, tone } = {}) {
  const prompt = buildSocialPostPrompt({ companyName, companyInfo, platform, tone });
  const result = await callClaudeForJson(prompt, 800);
  if (result.configured === false) return { configured: false };

  const { parsed, usage } = result;
  if (!parsed.text || typeof parsed.text !== "string") {
    throw new Error("生成結果にtextが含まれていません");
  }

  await logUsage("generate_social_post", usage);

  return {
    text: parsed.text,
    hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags.filter(h => typeof h === "string") : [],
  };
}

// ==================== 取材Q&A ====================

function buildInterviewQAPrompt({ companyName, companyInfo, focusArea }) {
  const infoText = buildCompanyInfoText(companyInfo);
  return `あなたは採用広報インタビューのプロの編集者です。
「群馬お仕事図鑑」の取材インタビューで使う質問リストを作成してください。

# 取材先企業の情報
${companyLine(companyName)}
${infoText ? `会社概要:\n${infoText}\n` : ""}
# 重視するテーマ
${focusArea || "(未指定。会社概要から適切なテーマを推測してください)"}

# 条件
- 若手求職者が知りたいリアルな情報を引き出せる質問にすること
- アイスブレイクから始まり、徐々に本質的な質問に入る流れにすること
- 5問程度にすること
- 各質問について、その質問で何を引き出したいのか「意図」を添えること

# 出力形式
以下のJSON形式のみを出力してください。前後に説明文やMarkdownのコードブロック記法は付けないでください。
{
  "questions": [
    { "question": "質問文", "purpose": "この質問の意図" }
  ]
}`;
}

async function generateInterviewQA({ companyName, companyInfo, focusArea } = {}) {
  const prompt = buildInterviewQAPrompt({ companyName, companyInfo, focusArea });
  const result = await callClaudeForJson(prompt, 1200);
  if (result.configured === false) return { configured: false };

  const { parsed, usage } = result;
  if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) {
    throw new Error("生成結果にquestionsが含まれていません");
  }

  await logUsage("generate_interview_qa", usage);

  return {
    questions: parsed.questions.map(q => ({
      question: typeof q.question === "string" ? q.question : "",
      purpose: typeof q.purpose === "string" ? q.purpose : "",
    })),
  };
}

module.exports = { generateReelsScript, generateSocialPost, generateInterviewQA };
