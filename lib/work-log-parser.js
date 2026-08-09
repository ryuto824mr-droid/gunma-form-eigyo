const { sql } = require("./db");

const MODEL = "claude-sonnet-4-6";

function buildPrompt({ text, existingTasksDone, existingTasksRemaining, nowTimeStr }) {
  const existingDoneBlock = existingTasksDone
    ? `\n# 既存の「やったこと」(この内容に今回の内容を追記・統合して整形すること)\n${existingTasksDone}\n`
    : "";
  const existingRemainingBlock = existingTasksRemaining
    ? `\n# 既存の「残タスク」(この内容に今回の内容を追記・統合して整形すること。今回の発言で完了したと分かるタスクは取り除くこと)\n${existingTasksRemaining}\n`
    : "";

  return `あなたは業務日報の入力アシスタントです。
以下はスタッフが話した、または入力した自由な文章です。この内容から「やったこと」と「残タスク」を抽出し、
それぞれ簡潔な箇条書き(1行1項目、「・」始まり)のテキストに整形してください。

複数のプロジェクト(LOCLE、群馬お仕事図鑑など)に言及している場合は、項目ごとにどちらの作業か分かるように
書き分けてください(例:「・LOCLE: 企業リサーチ20社」)。

また、退勤する旨の発言(例:「もう帰ります」「今日はここまでです」「退勤します」「上がります」等)が
含まれていれば、退勤時刻として現在時刻(${nowTimeStr})を検出したものとして扱ってください。
含まれていなければnullとしてください。

# 今回の入力テキスト
${text}
${existingDoneBlock}${existingRemainingBlock}
# 出力形式
以下のJSON形式のみを出力してください。前後に説明文やMarkdownのコードブロック記法は付けないでください。
{"tasks_done": "整形された「やったこと」箇条書きテキスト", "tasks_remaining": "整形された「残タスク」箇条書きテキスト", "detected_clock_out": "HH:MM形式の時刻文字列、またはnull"}`;
}

async function parseWorkLogText({ text, existingTasksDone, existingTasksRemaining } = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { configured: false };

  if (!text || typeof text !== "string" || !text.trim()) {
    throw new Error("textが必要です");
  }

  const nowTimeStr = new Date().toLocaleTimeString("ja-JP", {
    timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false,
  });

  const prompt = buildPrompt({
    text: text.trim(),
    existingTasksDone: existingTasksDone || "",
    existingTasksRemaining: existingTasksRemaining || "",
    nowTimeStr,
  });

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 800,
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
    throw new Error("解析結果をJSONとして解析できませんでした");
  }

  try {
    const inputTokens = data.usage?.input_tokens ?? null;
    const outputTokens = data.usage?.output_tokens ?? null;
    await sql`
      INSERT INTO api_usage_logs (provider, endpoint, input_tokens, output_tokens)
      VALUES ('anthropic', 'parse_work_log', ${inputTokens}, ${outputTokens})
    `;
  } catch {
    // 利用量ログの記録失敗は本体の解析処理には影響させない
  }

  const detectedClockOut =
    typeof parsed.detected_clock_out === "string" && /^\d{2}:\d{2}$/.test(parsed.detected_clock_out)
      ? parsed.detected_clock_out
      : null;

  return {
    configured: true,
    tasks_done: typeof parsed.tasks_done === "string" ? parsed.tasks_done : (existingTasksDone || ""),
    tasks_remaining: typeof parsed.tasks_remaining === "string" ? parsed.tasks_remaining : (existingTasksRemaining || ""),
    detected_clock_out: detectedClockOut,
  };
}

module.exports = { parseWorkLogText };
