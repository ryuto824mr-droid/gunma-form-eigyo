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
    // CSVインポート
    if (typeof (req.body || {}).csv === "string") {
      return handleImport(req.body.csv, res);
    }

    // 単件追加
    const { name, url, email } = req.body || {};
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
        INSERT INTO companies (name, url, email, status)
        VALUES (${name.trim()}, ${url.trim()}, ${email?.trim() || null}, 'pending')
        RETURNING *
      `;
      return res.status(201).json(company);
    } catch (err) {
      return res.status(500).json({ error: `DB登録エラー: ${err.message}` });
    }
  }

  return res.status(405).json({ error: "GET / POST のみ対応しています" });
};

async function handleImport(csvText, res) {
  const lines = csvText.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) {
    return res.status(400).json({ error: "CSVにデータ行がありません（ヘッダー行のみ）" });
  }

  const headers  = parseCSVLine(lines[0]).map(h => h.toLowerCase().trim());
  const nameIdx  = headers.indexOf("name");
  const urlIdx   = headers.indexOf("url");
  const emailIdx = headers.indexOf("email");

  if (nameIdx === -1 || urlIdx === -1) {
    return res.status(400).json({ error: "CSVヘッダーにname, urlが必要です" });
  }

  let imported = 0;
  let skipped  = 0;

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const name   = (values[nameIdx]  || "").trim();
    const url    = (values[urlIdx]   || "").trim();
    const email  = emailIdx !== -1 ? ((values[emailIdx] || "").trim() || null) : null;

    if (!name || !url) { skipped++; continue; }
    try { new URL(url); } catch { skipped++; continue; }

    const [existing] = await sql`SELECT id FROM companies WHERE url = ${url} LIMIT 1`;
    if (existing) { skipped++; continue; }

    try {
      await sql`
        INSERT INTO companies (name, url, email, status)
        VALUES (${name}, ${url}, ${email}, 'pending')
      `;
      imported++;
    } catch {
      skipped++;
    }
  }

  return res.status(200).json({ imported, skipped });
}

function parseCSVLine(line) {
  const result = [];
  let current  = "";
  let inQuotes = false;

  for (const ch of line) {
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}
