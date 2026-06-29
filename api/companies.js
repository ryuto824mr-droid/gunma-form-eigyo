const { sql } = require("../lib/db");

module.exports = async function handler(req, res) {
  if (req.method === "GET") {
    try {
      const companies = await sql`SELECT * FROM companies ORDER BY created_at DESC`;
      return res.status(200).json(companies);
    } catch (err) {
      return res.status(500).json({ error: `DB取得エラー: ${err.message}` });
    }
  }

  if (req.method === "POST") {
    const { name, url } = req.body || {};
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "name（文字列）が必要です" });
    }
    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "url（文字列）が必要です" });
    }
    try {
      new URL(url);
    } catch {
      return res.status(400).json({ error: "urlの形式が正しくありません" });
    }

    try {
      const [company] = await sql`
        INSERT INTO companies (name, url, status)
        VALUES (${name.trim()}, ${url.trim()}, 'pending')
        RETURNING *
      `;
      return res.status(201).json(company);
    } catch (err) {
      return res.status(500).json({ error: `DB登録エラー: ${err.message}` });
    }
  }

  return res.status(405).json({ error: "GET / POST のみ対応しています" });
};
