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
    // 検索結果のタイトルはサイトの説明文やページ名を含むことが多く、そのまま企業名として登録すると
    // 宛名が壊れていた(「群馬総合保険株式会社は損害保険・生命保険を…」等)。公式サイトかどうかと一緒に、
    // 正式な会社名(分からなければ null)も返させる。出力を短くするため番号(i)で選ばせる
    const prompt = `以下の検索結果(i は番号、title はページのタイトル)から、${region}の${keyword}に該当する企業の公式サイトと思われるものだけを選んでください。それ以外（ニュース記事・まとめサイト・ランキング・求人サイト・ポータル・無関係業種など）は除外してください。
選んだものについて、ページのタイトルやURLから分かる正式な会社名(例: 株式会社〇〇、〇〇株式会社、〇〇工業。説明文・地域名・ページ名は含めない)を company に入れてください。確信が持てなければ null にしてください。

検索結果:
${JSON.stringify(results.map((r, i) => ({ i, title: r.name, url: r.url })))}

出力形式: 次の形のJSON配列のみを出力してください(説明文やコードブロックの記号は不要)。
[{"i":0,"company":"株式会社〇〇"},{"i":3,"company":null}]`;

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

    // 選ばれた番号の元の結果に、AIが返した正式な会社名(company_name)を付ける
    const picked = [];
    for (const f of filtered) {
      if (!f || !Number.isInteger(f.i) || !results[f.i]) continue;
      const company = typeof f.company === "string" ? f.company.trim() : "";
      picked.push({ ...results[f.i], company_name: company || null });
    }
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
