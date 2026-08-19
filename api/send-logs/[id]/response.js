const { sql } = require("../../../lib/db");
const { ensureLabel, addLabelToMessage } = require("../../../lib/gmail-sender");

const VALID = ["interested", "declined", "question", "other"];

const CLASSIFICATION_LABELS = {
  interested: "LOCLE営業/興味あり",
  question:   "LOCLE営業/質問あり",
  declined:   "LOCLE営業/お断り",
  other:      "LOCLE営業/その他",
};

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
    const { classification, raw_excerpt, message_id } = req.body || {};

    if (!classification || !VALID.includes(classification)) {
      return res.status(400).json({
        error: "classificationはinterested/declined/question/otherのいずれかです",
      });
    }

    const [log] = await sql`SELECT id, status FROM send_logs WHERE id = ${id}`;
    if (!log) {
      return res.status(404).json({ error: "送信ログが見つかりません" });
    }
    // 送信が成功していない(failed/uncertain)ログは相手に届いていないため、反応があり得ない。
    // UI側でもボタンを無効化しているが、APIを直接叩かれた場合の保険として二重にガードする
    if (log.status !== "sent") {
      return res.status(400).json({
        error: `送信が成功していない送信ログ(status: ${log.status})には反応を記録できません`,
      });
    }

    const [created] = await sql`
      INSERT INTO responses (send_log_id, received_at, classification, raw_excerpt, message_id)
      VALUES (${id}, NOW(), ${classification}, ${raw_excerpt?.trim() || null}, ${message_id?.trim() || null})
      RETURNING *
    `;

    // Gmailのメッセージにも分類ラベルを付与(message_idが分かる場合のみ。失敗しても記録自体は成功として扱う)
    if (created.message_id) {
      try {
        const labelName = CLASSIFICATION_LABELS[classification];
        const labelId = await ensureLabel(labelName);
        if (labelId) {
          await addLabelToMessage(created.message_id, labelId);
        }
      } catch (err) {
        console.error("反応分類ラベル付与に失敗しました:", err.message);
      }
    }

    return res.status(201).json(created);
  }

  return res.status(405).json({ error: "GET/POSTメソッドのみ対応しています" });
};
