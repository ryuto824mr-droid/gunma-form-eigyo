const { sql } = require("../lib/db");

module.exports = async function handler(req, res) {
  if (req.method === "GET") {
    // ?id=<ID>: 1件の詳細(送信者プロフィールの写し・実際の入力値・送信結果を含む)。読み取り専用。
    // 列の追加(db-setup)の前後どちらでも動くよう、send_logsは sl.* でそのまま返す
    if (req.query.id !== undefined) {
      const id = parseInt(req.query.id, 10);
      if (!(id > 0) || String(id) !== String(req.query.id).trim()) {
        return res.status(400).json({ error: "idは正の整数で指定してください" });
      }
      const [log] = await sql`
        SELECT sl.*, c.name AS company_name, mv.name AS variant_name
        FROM send_logs sl
        LEFT JOIN companies c        ON c.id  = sl.company_id
        LEFT JOIN message_variants mv ON mv.id = sl.variant_id
        WHERE sl.id = ${id}
      `;
      if (!log) return res.status(404).json({ error: "送信記録が見つかりません" });
      return res.status(200).json(log);
    }

    const project = req.query.project;
    const hasProjectFilter = project === "locle" || project === "ozukanzukan";

    const logs = hasProjectFilter
      ? await sql`
          SELECT
            sl.id,
            sl.company_id,
            c.name  AS company_name,
            sl.variant_id,
            mv.name AS variant_name,
            sl.channel,
            sl.status,
            sl.trigger_mode,
            sl.sent_at,
            sl.sender_snapshot->>'person_name'  AS sender_person_name,
            sl.sender_snapshot->>'company_name' AS sender_company_name,
            (
              SELECT classification FROM responses
              WHERE send_log_id = sl.id
              ORDER BY received_at DESC LIMIT 1
            ) AS latest_response
          FROM send_logs sl
          JOIN companies c        ON c.id  = sl.company_id
          JOIN message_variants mv ON mv.id = sl.variant_id
          WHERE c.project = ${project}
          ORDER BY sl.sent_at DESC
        `
      : await sql`
          SELECT
            sl.id,
            sl.company_id,
            c.name  AS company_name,
            sl.variant_id,
            mv.name AS variant_name,
            sl.channel,
            sl.status,
            sl.trigger_mode,
            sl.sent_at,
            sl.sender_snapshot->>'person_name'  AS sender_person_name,
            sl.sender_snapshot->>'company_name' AS sender_company_name,
            (
              SELECT classification FROM responses
              WHERE send_log_id = sl.id
              ORDER BY received_at DESC LIMIT 1
            ) AS latest_response
          FROM send_logs sl
          JOIN companies c        ON c.id  = sl.company_id
          JOIN message_variants mv ON mv.id = sl.variant_id
          ORDER BY sl.sent_at DESC
        `;
    return res.status(200).json(logs);
  }

  if (req.method === "POST") {
    const { company_id, variant_id, channel, trigger_mode } = req.body || {};

    if (!company_id || !variant_id || !channel) {
      return res.status(400).json({ error: "company_id, variant_id, channelは必須です" });
    }
    if (!["email", "form"].includes(channel)) {
      return res.status(400).json({ error: "channelはemailまたはformのみ有効です" });
    }

    const [created] = await sql`
      INSERT INTO send_logs (company_id, variant_id, channel, status, trigger_mode, sent_at)
      VALUES (
        ${company_id},
        ${variant_id},
        ${channel},
        'sent',
        ${trigger_mode || "manual"},
        NOW()
      )
      RETURNING *
    `;
    return res.status(201).json(created);
  }

  return res.status(405).json({ error: "GET/POSTメソッドのみ対応しています" });
};
