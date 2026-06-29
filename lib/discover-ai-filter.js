async function filterResultsWithAI(results, region, keyword) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || results.length === 0) return results;

  try {
    const prompt = `以下の検索結果から、${region}の${keyword}に該当する企業の公式サイトと思われるものだけをJSON配列(name, urlのみ)で返してください。それ以外（ニュース記事・まとめサイト・求人サイト・無関係業種など）は除外してください。説明文は不要です。JSON配列のみ出力してください。

検索結果:
${JSON.stringify(results.map(r => ({ name: r.name, url: r.url })), null, 2)}`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
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

    if (!response.ok) return results;

    const data = await response.json();
    const textBlock = (data.content || []).find(c => c.type === "text");
    if (!textBlock) return results;

    const cleaned = textBlock.text.replace(/```json|```/g, "").trim();
    const filtered = JSON.parse(cleaned);

    // 元の source フィールドを引き継ぐ
    return filtered.map(f => {
      const original = results.find(r => r.url === f.url);
      return original || { name: f.name, url: f.url, source: "web" };
    });
  } catch {
    return results;
  }
}

module.exports = { filterResultsWithAI };
