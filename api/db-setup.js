// api/db-setup.js
//
// POST /api/db-setup
// Body: { "secret": "<SETUP_SECRET>" }
//
// db/schema.sql を読み込み、Neon(Vercel Postgres)に対してCREATE TABLE文を実行する。
// 本番環境での誤実行を防ぐため、SETUP_SECRET 環境変数によるシークレットチェックを行う。

const fs = require("fs");
const path = require("path");
const { neon } = require("@neondatabase/serverless");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POSTメソッドのみ対応しています" });
  }

  const { secret } = req.body || {};
  const expectedSecret = process.env.SETUP_SECRET;

  if (!expectedSecret) {
    return res.status(500).json({ error: "SETUP_SECRET 環境変数が設定されていません" });
  }
  if (secret !== expectedSecret) {
    return res.status(401).json({ error: "シークレットキーが正しくありません" });
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return res.status(500).json({ error: "DATABASE_URL 環境変数が設定されていません" });
  }

  const schemaPath = path.join(process.cwd(), "db", "schema.sql");
  let schemaSql;
  try {
    schemaSql = fs.readFileSync(schemaPath, "utf-8");
  } catch (err) {
    return res.status(500).json({ error: `schema.sql の読み込みに失敗しました: ${err.message}` });
  }

  const statements = schemaSql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("--"));

  try {
    const sql = neon(databaseUrl);
    for (const statement of statements) {
      await sql.query(statement);
    }
    return res.status(200).json({ message: "スキーマのセットアップが完了しました", tables: statements.length });
  } catch (err) {
    return res.status(500).json({ error: `DB実行エラー: ${err.message}` });
  }
};
