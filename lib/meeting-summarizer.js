const { sql } = require("./db");

const MODEL = "claude-sonnet-4-6";

const MEETING_TYPE_LABELS = { "1on1": "1on1", "全体定例": "全体定例", other: "その他" };

function buildPrompt({ rawText, meetingType, personalNotes }) {
  const typeLabel = MEETING_TYPE_LABELS[meetingType] || "その他";
  const hasPersonalNotes = !!(personalNotes && personalNotes.trim());

  // 手元メモがある場合は、文字起こしと個人メモの両方を統合して要約させる。個人メモには
  // 文字起こしに拾われていない重要な補足(決定事項の背景、発言者の意図等)が含まれうるため、
  // 優先的に反映するようプロンプトで明示する
  const introAndContent = hasPersonalNotes
    ? `あなたは議事録の要約アシスタントです。
以下は「${typeLabel}」の会議の文字起こしと、参加者の個人的なメモです。両方の情報を統合して要約してください。個人メモには文字起こしに無い重要な補足が含まれている可能性があるため、優先的に反映してください。

【文字起こし】
${rawText}

【個人メモ】
${personalNotes.trim()}`
    : `あなたは議事録の要約アシスタントです。
以下は「${typeLabel}」の会議で取られた議事録の生テキストです。この内容から要約とTodoリストを抽出してください。

# 議事録本文
${rawText}`;

  return `${introAndContent}

# 抽出条件
- summary: 3〜5行程度で、話し合われた内容・決定事項の要点をまとめてください
- todos: 会議中に決まったアクションアイテム・宿題事項を、実行可能な短い文の配列として抽出してください
  (担当者が分かる場合は文中に含めてください)。該当が無ければ空配列にしてください

# 出力形式
以下のJSON形式のみを出力してください。前後に説明文やMarkdownのコードブロック記法は付けないでください。
{"summary": "要約テキスト", "todos": ["Todo項目1", "Todo項目2"]}`;
}

async function summarizeMeeting({ rawText, meetingType, personalNotes } = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { configured: false };

  if (!rawText || typeof rawText !== "string" || !rawText.trim()) {
    throw new Error("rawTextが必要です");
  }

  const prompt = buildPrompt({ rawText: rawText.trim(), meetingType, personalNotes });

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

function buildSpeakerPrompt({ rawText }) {
  return `あなたは議事録の話者分離アシスタントです。
以下の議事録テキストには、複数人の発言が含まれている可能性があります。
「〇〇です、」「〇〇と申します」のような自己紹介・名乗りのパターンを手がかりに、
それ以降の発言を話者名でラベリングしてください。

# 議事録本文
${rawText}

# ラベリングのルール
- 話者が特定できた発言には "話者名: 発言内容" の形式でラベルを付けてください(改行区切り)
- 話者を特定できない部分は "不明: 発言内容" としてください
- 発言内容自体は要約せず、原文の意味を保ったまま整形してください
- 話者が1人も特定できない場合は、speakers_detectedを空配列にし、labeled_textは元のテキストをそのまま返してください

# 出力形式
以下のJSON形式のみを出力してください。前後に説明文やMarkdownのコードブロック記法は付けないでください。
{"labeled_text": "話者ラベル付きテキスト", "speakers_detected": ["話者名1", "話者名2"]}`;
}

// 話者分離の土台機能。ANTHROPIC_API_KEY未設定時は要約と同様{configured:false}を返し、
// 呼び出し元(api/crm.js)はこれをエラー扱いせず、speakers_detected=[]のまま保存を続行する。
async function identifySpeakers({ rawText } = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { configured: false };

  if (!rawText || typeof rawText !== "string" || !rawText.trim()) {
    throw new Error("rawTextが必要です");
  }

  const prompt = buildSpeakerPrompt({ rawText: rawText.trim() });

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
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
    throw new Error("話者分離結果をJSONとして解析できませんでした");
  }

  try {
    const inputTokens = data.usage?.input_tokens ?? null;
    const outputTokens = data.usage?.output_tokens ?? null;
    await sql`
      INSERT INTO api_usage_logs (provider, endpoint, input_tokens, output_tokens)
      VALUES ('anthropic', 'identify_speakers', ${inputTokens}, ${outputTokens})
    `;
  } catch {
    // 利用量ログの記録失敗は本体の処理には影響させない
  }

  return {
    configured: true,
    labeled_text: typeof parsed.labeled_text === "string" ? parsed.labeled_text : rawText,
    speakers_detected: Array.isArray(parsed.speakers_detected)
      ? parsed.speakers_detected.filter(s => typeof s === "string")
      : [],
  };
}

module.exports = { summarizeMeeting, identifySpeakers };
