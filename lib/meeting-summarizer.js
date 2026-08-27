const { sql } = require("./db");

const MODEL = "claude-sonnet-4-6";

const MEETING_TYPE_LABELS = { "1on1": "1on1", "全体定例": "全体定例", other: "その他" };

// section2(会議の主内容)の見出しは会議種別によって読み替える。1on1/その他は「1on1での内容」、
// 全体定例のみ「議題・共有事項」とする
function section2Label(meetingType) {
  return meetingType === "全体定例" ? "議題・共有事項" : "1on1での内容";
}

function buildPrompt({ rawText, meetingType, personalNotes }) {
  const typeLabel = MEETING_TYPE_LABELS[meetingType] || "その他";
  const hasPersonalNotes = !!(personalNotes && personalNotes.trim());
  const sec2 = section2Label(meetingType);

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
以下は「${typeLabel}」の会議で取られた議事録の生テキストです。この内容を分類・要約し、Todoリストを抽出してください。

# 議事録本文
${rawText}`;

  return `${introAndContent}

# 抽出条件
以下の4項目に分類して要約してください。該当する内容が本文中に見当たらない項目は、無理に埋めず空文字("")にしてください。
1. section1(先週のタスクの達成度): 前回からの進捗・完了したタスクの状況
2. section2(${sec2}): 話し合われた内容の要点
3. section3(今週のタスク): 今後取り組む予定のタスク
4. section4(補足): 上記に当てはまらないその他の連絡事項・所感等

- todos: 会議中に決まったアクションアイテム・宿題事項を、実行可能な短い文の配列として抽出してください
  (担当者が分かる場合は文中に含めてください)。該当が無ければ空配列にしてください

# 出力形式
以下のJSON形式のみを出力してください。前後に説明文やMarkdownのコードブロック記法は付けないでください。
{"summary": {"section1": "...", "section2": "...", "section3": "...", "section4": "..."}, "todos": ["Todo項目1", "Todo項目2"]}`;
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
      // 4項目の要約+todosを合わせた出力は、参加者が多い/議題が多い会議ほど長くなる
      // (todosが議題数に比例して増える)。以前は1200だったが、議題数が多い会議で
      // 出力がmax_tokensに達して途中で切れ、JSON.parseが失敗する実例を確認したため
      // 引き上げる(4096あれば通常の議事録では十分な余裕がある)
      max_tokens: 4096,
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

  // stop_reason==="max_tokens"は、max_tokensに達して出力が途中で打ち切られたことを示す
  // (この場合JSONも必ず不完全になりJSON.parseは失敗する)。JSON解析エラーとして
  // 十把一絡げにせず、原因が分かる専用のエラーメッセージを返す
  if (data.stop_reason === "max_tokens") {
    console.error("summarizeMeeting: 出力がmax_tokensで打ち切られました。生テキスト(先頭1000文字):", textBlock.text.slice(0, 1000));
    throw new Error("要約の生成が長すぎて出力が途中で打ち切られました。議事録本文を分割するか、もう一度お試しください。");
  }

  // ```json ... ``` のコードブロック記法や前後の説明文が混ざる場合に備え、コードフェンスを
  // 除去したうえで、最初の "{" 〜 最後の "}" の範囲だけを取り出す(プロンプトで
  // 「JSON形式のみを出力」と指示しているが、AIが前置き文を付けてしまうケースへの対策)
  const stripped = textBlock.text.replace(/```json|```/g, "").trim();
  const jsonStart = stripped.indexOf("{");
  const jsonEnd = stripped.lastIndexOf("}");
  const cleaned = jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart
    ? stripped.slice(jsonStart, jsonEnd + 1)
    : stripped;
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    // 生のレスポンスをサーバーログに残しつつ(Vercelのランタイムログで確認できる)、
    // エラーメッセージ自体にも冒頭部分を含め、呼び出し元(画面のトースト等)からも
    // 何が返ってきたのか分かるようにする
    console.error("summarizeMeeting: JSON解析エラー。生テキスト全文:", textBlock.text);
    throw new Error(`要約結果をJSONとして解析できませんでした（${err.message}）。AIの応答冒頭: ${textBlock.text.slice(0, 200)}`);
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

  const rawSummary = parsed.summary && typeof parsed.summary === "object" ? parsed.summary : {};
  const summary = {
    section1: typeof rawSummary.section1 === "string" ? rawSummary.section1 : "",
    section2: typeof rawSummary.section2 === "string" ? rawSummary.section2 : "",
    section3: typeof rawSummary.section3 === "string" ? rawSummary.section3 : "",
    section4: typeof rawSummary.section4 === "string" ? rawSummary.section4 : "",
  };

  return {
    configured: true,
    summary,
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

module.exports = { summarizeMeeting, identifySpeakers, section2Label };
