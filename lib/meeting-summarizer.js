const { sql } = require("./db");

const MODEL = "claude-sonnet-4-6";

const MEETING_TYPE_LABELS = { "1on1": "1on1", "全体定例": "全体定例", other: "その他" };

function buildPrompt({ rawText, meetingType }) {
  const typeLabel = MEETING_TYPE_LABELS[meetingType] || "その他";
  return `あなたは議事録の要約アシスタントです。
以下は「${typeLabel}」の会議で取られた議事録の生テキストです。この内容から要約とTodoリストを抽出してください。

# 議事録本文
${rawText}

# 抽出条件
- summary: 3〜5行程度で、話し合われた内容・決定事項の要点をまとめてください
- todos: 会議中に決まったアクションアイテム・宿題事項を、実行可能な短い文の配列として抽出してください
  (担当者が分かる場合は文中に含めてください)。該当が無ければ空配列にしてください

# 出力形式
以下のJSON形式のみを出力してください。前後に説明文やMarkdownのコードブロック記法は付けないでください。
{"summary": "要約テキスト", "todos": ["Todo項目1", "Todo項目2"]}`;
}

async function summarizeMeeting({ rawText, meetingType } = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { configured: false };

  if (!rawText || typeof rawText !== "string" || !rawText.trim()) {
    throw new Error("rawTextが必要です");
  }

  const prompt = buildPrompt({ rawText: rawText.trim(), meetingType });

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
    throw new Error("要約結果をJSONとして解析できませんでした");
  }

  try {
    const inputTokens = data.usage?.input_tokens ?? null;
    const outputTokens = data.usage?.output_tokens ?? null;
    await sql`
      INSERT INTO api_usage_logs (provider, endpoint, input_tokens, output_tokens)
      VALUES ('anthropic', 'summarize_meeting', ${inputTokens}, ${outputTokens})
    `;
  } catch {
    // 利用量ログの記録失敗は本体の要約処理には影響させない
  }

  return {
    configured: true,
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    todos: Array.isArray(parsed.todos) ? parsed.todos.filter(t => typeof t === "string") : [],
  };
}

module.exports = { summarizeMeeting };
