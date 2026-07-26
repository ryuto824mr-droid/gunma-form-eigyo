const { sql } = require("../lib/db");

module.exports = async function handler(req, res) {
  if (req.method === "GET") {
    const variants = await sql`SELECT * FROM message_variants ORDER BY created_at DESC`;
    return res.status(200).json(variants);
  }

  if (req.method === "POST") {
    const { copy_from_id } = req.body || {};
    if (copy_from_id !== undefined) {
      const sourceId = parseInt(copy_from_id, 10);
      if (!sourceId || isNaN(sourceId)) {
        return res.status(400).json({ error: "有効なcopy_from_idが必要です" });
      }
      const [source] = await sql`SELECT * FROM message_variants WHERE id = ${sourceId}`;
      if (!source) {
        return res.status(404).json({ error: "コピー元のバリアントが見つかりません" });
      }
      const [copied] = await sql`
        INSERT INTO message_variants (name, channel, subject_template, body_template, tags, created_at)
        VALUES (
          ${source.name + " (コピー)"},
          ${source.channel},
          ${source.subject_template},
          ${source.body_template},
          ${JSON.stringify(source.tags || {})},
          NOW()
        )
        RETURNING *
      `;
      return res.status(201).json(copied);
    }

    const { name, channel, subject_template, body_template, tags, attachment_id } = req.body || {};

    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "nameは必須です" });
    }
    if (!channel || !["email", "form"].includes(channel)) {
      return res.status(400).json({ error: "channelはemailまたはformのみ有効です" });
    }
    if (!body_template || typeof body_template !== "string" || !body_template.trim()) {
      return res.status(400).json({ error: "body_templateは必須です" });
    }

    const tagsJson = (tags && typeof tags === "object") ? JSON.stringify(tags) : "{}";
    const attachmentId = attachment_id ? parseInt(attachment_id, 10) || null : null;

    const [created] = await sql`
      INSERT INTO message_variants (name, channel, subject_template, body_template, tags, attachment_id, created_at)
      VALUES (
        ${name.trim()},
        ${channel},
        ${subject_template?.trim() || null},
        ${body_template.trim()},
        ${tagsJson},
        ${attachmentId},
        NOW()
      )
      RETURNING *
    `;
    return res.status(201).json(created);
  }

  return res.status(405).json({ error: "GET/POSTメソッドのみ対応しています" });
};
