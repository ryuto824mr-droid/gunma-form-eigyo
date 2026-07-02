const { sql } = require("../lib/db");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "GETメソッドのみ対応しています" });
  }

  try {
    const variants_stats = await sql`
      SELECT
        mv.id                                                             AS variant_id,
        mv.name                                                           AS variant_name,
        COUNT(DISTINCT sl.id)::int                                        AS send_count,
        COUNT(DISTINCT r.id)::int                                         AS response_count,
        COUNT(DISTINCT CASE WHEN r.classification = 'interested'
          THEN r.id END)::int                                             AS interested_count,
        CASE
          WHEN COUNT(DISTINCT sl.id) > 0
          THEN ROUND(COUNT(DISTINCT r.id)::numeric / COUNT(DISTINCT sl.id) * 100, 1)
          ELSE 0
        END                                                               AS response_rate
      FROM message_variants mv
      LEFT JOIN send_logs sl ON sl.variant_id  = mv.id
      LEFT JOIN responses  r  ON r.send_log_id = sl.id
      GROUP BY mv.id, mv.name
      ORDER BY send_count DESC, mv.name
    `;

    const tags_stats = await sql`
      SELECT
        kv.key                                                            AS tag_key,
        kv.value                                                          AS tag_value,
        COUNT(DISTINCT sl.id)::int                                        AS send_count,
        COUNT(DISTINCT r.id)::int                                         AS response_count,
        CASE
          WHEN COUNT(DISTINCT sl.id) > 0
          THEN ROUND(COUNT(DISTINCT r.id)::numeric / COUNT(DISTINCT sl.id) * 100, 1)
          ELSE 0
        END                                                               AS response_rate
      FROM message_variants mv
      CROSS JOIN LATERAL jsonb_each_text(COALESCE(mv.tags, '{}'::jsonb)) kv
      LEFT JOIN send_logs sl ON sl.variant_id  = mv.id
      LEFT JOIN responses  r  ON r.send_log_id = sl.id
      GROUP BY kv.key, kv.value
      ORDER BY send_count DESC, kv.key, kv.value
    `;

    return res.status(200).json({ variants_stats, tags_stats });
  } catch (err) {
    return res.status(500).json({ error: `集計エラー: ${err.message}` });
  }
};
