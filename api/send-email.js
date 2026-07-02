const { sql } = require("../lib/db");
const { sendEmail } = require("../lib/gmail-sender");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POSTメソッドのみ対応しています" });
  }

  const { company_id, variant_id } = req.body || {};
  if (!company_id || !variant_id) {
    return res.status(400).json({ error: "company_id, variant_idは必須です" });
  }

  // 企業情報取得 (emailカラムはmigrate-add-email.jsで追加済みであること)
  const [company] = await sql`SELECT * FROM companies WHERE id = ${company_id}`;
  if (!company) return res.status(404).json({ error: "企業が見つかりません" });

  const toEmail = company.email;
  if (!toEmail) {
    return res.status(400).json({ error: "この企業にメールアドレスが登録されていません。企業リストから編集して追加してください。" });
  }

  // バリアント取得
  const [variant] = await sql`SELECT * FROM message_variants WHERE id = ${variant_id}`;
  if (!variant) return res.status(404).json({ error: "バリアントが見つかりません" });

  // テンプレート置換
  const replace = s => (s || "").replace(/\{\{company_name\}\}/g, company.name);
  const subject = replace(variant.subject_template);
  const body    = replace(variant.body_template);

  // メール送信
  let result;
  try {
    result = await sendEmail({ to: toEmail, subject, body });
  } catch (err) {
    await sql`
      INSERT INTO send_logs (company_id, variant_id, channel, status, trigger_mode, sent_at)
      VALUES (${company_id}, ${variant_id}, 'email', 'failed', 'manual', NOW())
    `;
    return res.status(500).json({ error: `メール送信に失敗しました: ${err.message}` });
  }

  if (!result.configured) {
    return res.status(400).json({
      error: "Gmail APIが設定されていません。Vercel環境変数にGMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKENを設定してください。",
    });
  }

  const [logEntry] = await sql`
    INSERT INTO send_logs (company_id, variant_id, channel, status, trigger_mode, sent_at)
    VALUES (${company_id}, ${variant_id}, 'email', 'sent', 'manual', NOW())
    RETURNING *
  `;

  return res.status(200).json({ success: true, log: logEntry, messageId: result.messageId });
};
