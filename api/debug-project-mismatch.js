// 一時的な確認用エンドポイント。send_logsのcompany_idとvariant_idが指すprojectが
// 食い違っていないかを読み取り専用で確認する。用済み後は削除する。
// db-setupと同じSETUP_SECRET(debug_key)で保護する。

const { sql } = require("../lib/db");

module.exports = async function handler(req, res) {
  const authorized = !!process.env.SETUP_SECRET && req.query.debug_key === process.env.SETUP_SECRET;
  if (!authorized) {
    return res.status(401).json({ error: "debug_keyが正しくありません" });
  }
  try {
    const mismatches = await sql`
      SELECT
        sl.id            AS send_log_id,
        c.id             AS company_id,
        c.name           AS company_name,
        c.project        AS company_project,
        mv.id            AS variant_id,
        mv.name          AS variant_name,
        mv.project       AS variant_project,
        sl.sent_at
      FROM send_logs sl
      JOIN companies c         ON c.id  = sl.company_id
      JOIN message_variants mv ON mv.id = sl.variant_id
      WHERE c.project != mv.project
      ORDER BY sl.sent_at DESC
    `;
    const [{ total_send_logs }] = await sql`SELECT COUNT(*)::int AS total_send_logs FROM send_logs`;
    return res.status(200).json({
      mismatch_count: mismatches.length,
      total_send_logs,
      mismatches,
    });
  } catch (err) {
    return res.status(500).json({ error: `確認エラー: ${err.message}` });
  }
};
