const { sql } = require("../../../lib/db");

const VALID = ["interested", "declined", "question", "other"];

module.exports = async function handler(req, res) {
  const id = parseInt(req.query.id, 10);
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: "有効なidが必要です" });
  }

  if (req.method === "GET") {
    const responses = await sql`
      SELECT * FROM responses
      WHERE send_log_id = ${id}
      ORDER BY received_at DESC
    `;
    return res.status(200).json(responses);
  }

  if (req.method === "POST") {
    const { classification, raw_excerpt } = req.body || {};

    if (!classification || !VALID.includes(classification)) {
      return res.status(400).json({
        error: "classificationはinterested/declined/question/otherのいずれかです",
      });
    }

    const [log] = await sql`SELECT id FROM send_logs WHERE id = ${id}`;
    if (!log) {
      return res.status(404).json({ error: "送信ログが見つかりません" });
    }

    const [created] = await sql`
      INSERT INTO responses (send_log_id, received_at, classification, raw_excerpt)
      VALUES (${id}, NOW(), ${classification}, ${raw_excerpt?.trim() || null})
      RETURNING *
    `;
    return res.status(201).json(created);
  }

  return res.status(405).json({ error: "GET/POSTメソッドのみ対応しています" });
};
