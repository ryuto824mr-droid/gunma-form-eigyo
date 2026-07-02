const { sql } = require("../../lib/db");

module.exports = async function handler(req, res) {
  if (req.method !== "DELETE") {
    return res.status(405).json({ error: "DELETEメソッドのみ対応しています" });
  }

  const id = parseInt(req.query.id, 10);
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: "有効なidが必要です" });
  }

  // 送信ログで参照されていれば削除を拒否
  const logs = await sql`SELECT id FROM send_logs WHERE variant_id = ${id} LIMIT 1`;
  if (logs.length > 0) {
    return res.status(409).json({ error: "このバリアントは送信ログで参照されているため削除できません" });
  }

  const [deleted] = await sql`DELETE FROM message_variants WHERE id = ${id} RETURNING id`;
  if (!deleted) {
    return res.status(404).json({ error: "バリアントが見つかりません" });
  }

  return res.status(200).json({ id: deleted.id, deleted: true });
};
