const { sql } = require("../lib/db");

module.exports = async function handler(req, res) {
  if (req.method === "GET") {
    const logs = await sql`
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
