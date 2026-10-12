const { sql } = require("./db");

const MODEL = "claude-haiku-4-5-20251001";

const APPEAL_POINTS = ["SNS映え", "知名度の高さ", "福利厚生充実", "若手活躍", "ユニークな事業内容"];

const INFO_LABELS = {
  representative:       "代表者",
  founded_year:          "設立",
  employee_count_text:  "従業員数",
  business_description: "事業内容",
  capital:                "資本金",
};

function buildInfoText(companyInfo) {
  if (!companyInfo || typeof companyInfo !== "object") return "";
  const lines = Object.entries(INFO_LABELS)
    .filter(([key]) => companyInfo[key])
    .map(([key, label]) => `${label}: ${companyInfo[key]}`);
  if (companyInfo.hiring_status?.hasHiringPage) lines.push("採用ページ: あり");
  return lines.join("\n");
}

function buildPrompt(companyName, infoText) {
  return `以下の企業情報をもとに、下記の「訴求ポイント」のうち当てはまるものをすべて選んでください（複数選択可、当てはまるものがなければ選ばなくてよい）。

# 訴求ポイントの選択肢
- SNS映え: ビジュアル要素の強い事業、店舗系・飲食・アパレルなど
- 知名度の高さ: 大企業・上場企業・有名ブランドなど
- 福利厚生充実: 福利厚生に関する記述が読み取れる場合
- 若手活躍: 採用ページの内容や設立年数が浅いことなどから、若手が活躍していそうな場合
- ユニークな事業内容: 業種・事業内容が特徴的な場合

# 企業情報
企業名: ${companyName || "不明"}
${infoText}

判定材料が不足している場合は無理に選ばず、空配列を返してください。

# 出力形式
以下のJSON配列形式のみを出力してください（説明文やMarkdownのコードブロック記法は不要）。選択肢に無い文字列は含めないこと。
["SNS映え", "若手活躍"]`;
}

// 訴求ポイントを推定する。戻り値: { points, error }
//   points: 当てはまる訴求ポイント(無ければ空配列)
//   error:  AIの呼び出しに失敗した理由(成功・「該当なし」・判定材料なしで呼ばなかった場合は null)
// 以前は失敗しても黙って空配列を返していたため、クレジット不足等で推定が止まっていても
// 「該当なし」と区別できなかった。失敗の理由はリサーチの記録に警告として残す
async function classifyAppealPointsDetailed(company) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { points: [], error: null };

  const infoText = buildInfoText(company?.company_info);
  if (!infoText) return { points: [], error: null };

  const prompt = buildPrompt(company?.name, infoText);

  let response;
  try {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 200,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch (err) {
    return { points: [], error: `通信エラー: ${String(err && err.message || err).slice(0, 200)}` };
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    return { points: [], error: `Claude APIエラー (status ${response.status}): ${bodyText.slice(0, 300)}` };
  }

  const data = await response.json();

  try {
    const inputTokens = data.usage?.input_tokens ?? null;
    const outputTokens = data.usage?.output_tokens ?? null;
    await sql`
      INSERT INTO api_usage_logs (provider, endpoint, input_tokens, output_tokens)
      VALUES ('anthropic', 'classify_appeal', ${inputTokens}, ${outputTokens})
    `;
  } catch {
    // 利用量ログの記録失敗は本体の判定処理には影響させない
  }

  const textBlock = (data.content || []).find(c => c.type === "text");
  if (!textBlock) return { points: [], error: "Claude APIのレスポンスにテキストが含まれていません" };

  let parsed;
  try {
    const cleaned = textBlock.text.replace(/```json\n?|```/g, "").trim();
    parsed = JSON.parse(cleaned);
  } catch {
    return { points: [], error: `訴求タグの出力をJSONとして解析できませんでした: ${textBlock.text.slice(0, 200)}` };
  }

  const points = Array.isArray(parsed) ? parsed.filter(p => APPEAL_POINTS.includes(p)) : [];
  return { points, error: null };
}

// 従来どおり訴求ポイントの配列だけを返す(失敗時は空配列)
async function classifyAppealPoints(company) {
  return (await classifyAppealPointsDetailed(company)).points;
}

module.exports = { classifyAppealPoints, classifyAppealPointsDetailed, APPEAL_POINTS };
