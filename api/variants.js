const { sql } = require("../lib/db");

// /api/variants/:id(文面の編集 PATCH・削除 DELETE)は、vercel.json の書き換えで /api/variants?id=:id として
// ここに届く。以前は api/variants/[id].js という別の関数だったが、Hobby プランの関数の数の上限(12)に
// ミドルウェアを入れる枠を作るため、1つの関数にまとめた(動きは同じ。tests/variants-api.test.js)
module.exports = async function handler(req, res) {
  if (req.query && req.query.id !== undefined) return handleById(req, res);

  if (req.method === "GET") {
    const project = req.query.project;
    const hasProjectFilter = project === "locle" || project === "ozukanzukan";
    const variants = hasProjectFilter
      ? await sql`
          SELECT v.*, EXISTS(SELECT 1 FROM send_logs sl WHERE sl.variant_id = v.id) AS has_logs
          FROM message_variants v WHERE v.project = ${project} ORDER BY v.created_at DESC
        `
      : await sql`
          SELECT v.*, EXISTS(SELECT 1 FROM send_logs sl WHERE sl.variant_id = v.id) AS has_logs
          FROM message_variants v ORDER BY v.created_at DESC
        `;
    return res.status(200).json(variants);
  }

  if (req.method === "POST") {
    const { copy_from_id, project } = req.body || {};
    const projectToSet = project === "ozukanzukan" ? "ozukanzukan" : "locle";

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
        INSERT INTO message_variants (name, channel, subject_template, body_template, tags, project, created_at)
        VALUES (
          ${source.name + " (コピー)"},
          ${source.channel},
          ${source.subject_template},
          ${source.body_template},
          ${JSON.stringify(source.tags || {})},
          ${projectToSet},
          NOW()
        )
        RETURNING *
      `;
      return res.status(201).json(copied);
    }

    const { name, channel, subject_template, body_template, tags, attachment_id, sender_account_id } = req.body || {};

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
    const senderAccountId = sender_account_id ? parseInt(sender_account_id, 10) || null : null;

    const [created] = await sql`
      INSERT INTO message_variants (name, channel, subject_template, body_template, tags, attachment_id, sender_account_id, project, created_at)
      VALUES (
        ${name.trim()},
        ${channel},
        ${subject_template?.trim() || null},
        ${body_template.trim()},
        ${tagsJson},
        ${attachmentId},
        ${senderAccountId},
        ${projectToSet},
        NOW()
      )
      RETURNING *
    `;
    return res.status(201).json(created);
  }

  return res.status(405).json({ error: "GET/POSTメソッドのみ対応しています" });
};

async function handleById(req, res) {
  const id = parseInt(req.query.id, 10);
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: "有効なidが必要です" });
  }

  if (req.method === "DELETE") {
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
  }

  if (req.method === "PATCH") {
    // 送信ログで参照されている(=送信実績がある)バリアントは、過去の送信内容と表示内容が
    // 食い違ってしまうため編集を拒否する(削除と同じガード方式)。コピーして新規作成を促す
    const logs = await sql`SELECT id FROM send_logs WHERE variant_id = ${id} LIMIT 1`;
    if (logs.length > 0) {
      return res.status(409).json({
        error: "送信履歴があるバリアントは編集できません。コピーして新しいバリアントを作成してください",
        type: "has_logs",
      });
    }

    const [existing] = await sql`SELECT * FROM message_variants WHERE id = ${id}`;
    if (!existing) {
      return res.status(404).json({ error: "バリアントが見つかりません" });
    }

    const { name, channel, subject_template, body_template, tags, attachment_id, sender_account_id } = req.body || {};

    if (name !== undefined && (typeof name !== "string" || !name.trim())) {
      return res.status(400).json({ error: "nameは空にできません" });
    }
    if (channel !== undefined && !["email", "form"].includes(channel)) {
      return res.status(400).json({ error: "channelはemailまたはformのみ有効です" });
    }
    if (body_template !== undefined && (typeof body_template !== "string" || !body_template.trim())) {
      return res.status(400).json({ error: "body_templateは空にできません" });
    }

    // 一部項目のみの更新にも対応するため、指定されなかった項目は既存値を引き継ぐ
    const newName            = name !== undefined ? name.trim() : existing.name;
    const newChannel         = channel !== undefined ? channel : existing.channel;
    const newSubjectTemplate = subject_template !== undefined ? (subject_template?.trim() || null) : existing.subject_template;
    const newBodyTemplate    = body_template !== undefined ? body_template.trim() : existing.body_template;
    const newTags            = tags !== undefined
      ? ((tags && typeof tags === "object") ? JSON.stringify(tags) : "{}")
      : JSON.stringify(existing.tags || {});
    const newAttachmentId    = attachment_id !== undefined
      ? (attachment_id ? parseInt(attachment_id, 10) || null : null)
      : existing.attachment_id;
    const newSenderAccountId = sender_account_id !== undefined
      ? (sender_account_id ? parseInt(sender_account_id, 10) || null : null)
      : existing.sender_account_id;

    const [updated] = await sql`
      UPDATE message_variants
      SET name = ${newName},
          channel = ${newChannel},
          subject_template = ${newSubjectTemplate},
          body_template = ${newBodyTemplate},
          tags = ${newTags},
          attachment_id = ${newAttachmentId},
          sender_account_id = ${newSenderAccountId}
      WHERE id = ${id}
      RETURNING *
    `;
    return res.status(200).json(updated);
  }

  return res.status(405).json({ error: "DELETE/PATCHメソッドのみ対応しています" });
}
