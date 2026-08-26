const { sql, isExcludedDomain, getSettings } = require("../lib/db");
const { sendEmail, ensureLabel, addLabelToMessage } = require("../lib/gmail-sender");

const SENT_LABEL_NAME = "LOCLE営業/送信済み";

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POSTメソッドのみ対応しています" });
  }

  const { company_id, variant_id, force, tags, attachment_id, sender_id, trigger_source, is_followup } = req.body || {};
  const tagsJson = Array.isArray(tags) && tags.length > 0 ? JSON.stringify(tags) : null;
  if (!company_id || !variant_id) {
    return res.status(400).json({ error: "company_id, variant_idは必須です" });
  }
  const triggerSource = trigger_source === "auto_pipeline" ? "auto_pipeline" : "manual";
  // sender_id未指定時はundefinedのままsendEmail()等に渡す(環境変数のデフォルトアカウントを使う)
  let senderId;
  if (sender_id !== undefined && sender_id !== null && sender_id !== "") {
    senderId = parseInt(sender_id, 10);
    if (!senderId || isNaN(senderId)) {
      return res.status(400).json({ error: "有効なsender_idを指定してください" });
    }
  }

  const settings = await getSettings();

  // 1日の送信上限チェック(自動パイプラインのみ適用。手動送信は上限なし)
  if (triggerSource === "auto_pipeline") {
    const dailyLimit = parseInt(settings.daily_send_limit, 10) || 20;
    const [{ count: todaySendCount }] = await sql`
      SELECT COUNT(*)::int AS count FROM send_logs WHERE sent_at::date = CURRENT_DATE
    `;
    if (todaySendCount >= dailyLimit) {
      return res.status(429).json({ error: `本日の送信上限(${dailyLimit}件)に達しました` });
    }
  }

  // 再送信ガード: 同一チャネル(このAPIではemail固定)への status='sent' の送信が
  // 期間を問わず過去に1件でもあれば拒否する(以前は24時間以内のみのチェックだった)。
  // フォローアップメール機能からの意図的な再送信(is_followup: true)と、強制送信(force: true)は
  // このチェックをスキップする
  if (!force && !is_followup) {
    const [sentLog] = await sql`
      SELECT id FROM send_logs
      WHERE company_id = ${company_id} AND channel = 'email' AND status = 'sent'
      LIMIT 1
    `;
    if (sentLog) {
      return res.status(400).json({
        error: "このチャネル(フォーム/メール)には既に送信済みです。フォローアップとして送りたい場合は、送信管理の「未返信フォローアップ」機能をご利用いただくか、強制送信をオンにしてください",
      });
    }
  }

  // 企業情報取得 (emailカラムはmigrate-add-email.jsで追加済みであること)
  const [company] = await sql`SELECT * FROM companies WHERE id = ${company_id}`;
  if (!company) return res.status(404).json({ error: "企業が見つかりません" });

  if (await isExcludedDomain(company.url)) {
    return res.status(400).json({ error: "除外ドメインに登録されています", type: "excluded_domain" });
  }

  if (settings.skip_rejection_sites !== "false" && company.research_result?.rejection_detected) {
    return res.status(400).json({ error: "このサイトは営業お断りの文言が検出されています", type: "rejection_detected" });
  }

  const toEmail = company.email;
  if (!toEmail) {
    return res.status(400).json({ error: "この企業にメールアドレスが登録されていません。企業リストから編集して追加してください。" });
  }

  // バリアント取得
  const [variant] = await sql`SELECT * FROM message_variants WHERE id = ${variant_id}`;
  if (!variant) return res.status(404).json({ error: "バリアントが見つかりません" });

  if (company.project !== variant.project) {
    return res.status(400).json({ error: "企業とバリアントのプロジェクトが一致しません" });
  }

  // テンプレート置換
  const replace = s => (s || "").replace(/\{\{company_name\}\}/g, company.company_info?.official_name || company.name);
  const subject = replace(variant.subject_template);
  const body    = replace(variant.body_template);

  // 添付ファイル取得(指定があれば)
  let attachment = null;
  if (attachment_id) {
    const attachmentId = parseInt(attachment_id, 10);
    if (attachmentId) {
      const [row] = await sql`SELECT filename, content_type, file_data FROM attachments WHERE id = ${attachmentId}`;
      if (row) attachment = row;
    }
  }

  // メール送信
  let result;
  try {
    result = await sendEmail({ to: toEmail, subject, body, attachment, senderId });
  } catch (err) {
    await sql`
      INSERT INTO send_logs (company_id, variant_id, channel, status, trigger_mode, sent_at, tags)
      VALUES (${company_id}, ${variant_id}, 'email', 'failed', 'manual', NOW(), ${tagsJson})
    `;
    return res.status(500).json({ error: `メール送信に失敗しました: ${err.message}` });
  }

  if (!result.configured) {
    return res.status(400).json({
      error: "Gmail APIが設定されていません。Vercel環境変数にGMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKENを設定してください。",
    });
  }

  // 送信済みラベルを付与(失敗しても送信自体は成功として扱う)
  try {
    const labelId = await ensureLabel(SENT_LABEL_NAME, senderId);
    if (labelId && result.messageId) {
      await addLabelToMessage(result.messageId, labelId, senderId);
    }
  } catch (err) {
    console.error("送信済みラベル付与に失敗しました:", err.message);
  }

  const [logEntry] = await sql`
    INSERT INTO send_logs (company_id, variant_id, channel, status, trigger_mode, sent_at, tags)
    VALUES (${company_id}, ${variant_id}, 'email', 'sent', 'manual', NOW(), ${tagsJson})
    RETURNING *
  `;

  return res.status(200).json({ success: true, log: logEntry, messageId: result.messageId });
};
