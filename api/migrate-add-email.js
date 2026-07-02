const { sql } = require("../lib/db");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POSTのみ" });
  }
  if (req.headers["x-setup-secret"] !== process.env.SETUP_SECRET) {
    return res.status(401).json({ error: "認証エラー: x-setup-secretヘッダーが不正です" });
  }

  try {
    await sql`ALTER TABLE companies ADD COLUMN IF NOT EXISTS email TEXT`;
    return res.status(200).json({ ok: true, message: "emailカラムを追加しました（または既存）" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
