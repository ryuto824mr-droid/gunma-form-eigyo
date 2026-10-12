const { sql } = require("./db");

// 企業探しの検索結果から、企業の公式サイトと思われるものだけをAIで選ぶ。戻り値: { results, error }
//   results: AIが選んだ結果(失敗した場合は元の結果のまま)
//   error:   失敗した理由(成功した場合は null)
// 以前は失敗(クレジット不足等)しても黙って元の結果を全部返していたため、2026-09-08〜10-12 の
// クレジット不足の間、ポータル・自治体・Wikidata等の企業ではないページが多数登録された
// (企業ではないとしてアーカイブした27社のうち25社がこの期間の登録)。
// 失敗をどう扱うか(自動パイプラインはその日の登録を止める等)は呼び出し元で決める
async function filterResultsWithAIDetailed(results, region, keyword) {
  if (!results || results.length === 0) return { results: results || [], error: null };
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { results, error: "ANTHROPIC_API_KEY が環境変数に設定されていません" };

  try {
    const prompt = `以下の検索結果から、${region}の${keyword}に該当する企業の公式サイトと思われるものだけをJSON配列(name, urlのみ)で返してください。それ以外（ニュース記事・まとめサイト・求人サイト・無関係業種など）は除外してください。説明文は不要です。JSON配列のみ出力してください。

検索結果:
${JSON.stringify(results.map(r => ({ name: r.name, url: r.url })), null, 2)}`;

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
          model: "claude-sonnet-4-6",
          max_tokens: 1000,
          messages: [{ role: "user", content: prompt }],
        }),
      });
    } catch (err) {
      return { results, error: `通信エラー: ${String(err && err.message || err).slice(0, 200)}` };
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      return { results, error: `Claude APIエラー (status ${response.status}): ${bodyText.slice(0, 300)}` };
    }

    const data = await response.json();

    try {
      const inputTokens = data.usage?.input_tokens ?? null;
      const outputTokens = data.usage?.output_tokens ?? null;
      await sql`
        INSERT INTO api_usage_logs (provider, endpoint, input_tokens, output_tokens)
        VALUES ('anthropic', 'filter_results', ${inputTokens}, ${outputTokens})
      `;
    } catch {
      // 利用量ログの記録失敗は本体のフィルタ処理には影響させない
    }

    if (data.stop_reason === "max_tokens") {
      return { results, error: "AIの出力が上限(1000トークン)で切れました(企業探しの絞り込み)" };
    }
    const textBlock = (data.content || []).find(c => c.type === "text");
    if (!textBlock) return { results, error: "Claude APIのレスポンスにテキストが含まれていません" };

    const cleaned = textBlock.text.replace(/```json|```/g, "").trim();
    let filtered;
    try {
      filtered = JSON.parse(cleaned);
    } catch {
      return { results, error: `絞り込みの出力をJSONとして解析できませんでした: ${cleaned.slice(0, 200)}` };
    }
    if (!Array.isArray(filtered)) {
      return { results, error: `絞り込みの出力をJSONとして解析できませんでした(配列ではありません): ${cleaned.slice(0, 200)}` };
    }

    // 元の source フィールドを引き継ぐ
    const picked = filtered.filter(f => f && f.url).map(f => {
      const original = results.find(r => r.url === f.url);
      return original || { name: f.name, url: f.url, source: "web" };
    });
    return { results: picked, error: null };
  } catch (err) {
    return { results, error: `絞り込みでエラー: ${String(err && err.message || err).slice(0, 200)}` };
  }
}

// 従来どおり結果だけを返す(失敗時は元の結果のまま)
async function filterResultsWithAI(results, region, keyword) {
  return (await filterResultsWithAIDetailed(results, region, keyword)).results;
}

module.exports = { filterResultsWithAI, filterResultsWithAIDetailed };
