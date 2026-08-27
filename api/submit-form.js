const { sql, isExcludedDomain, getSettings } = require("../lib/db");
const { submitForm } = require("../lib/form-submitter");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POSTメソッドのみ対応しています" });
  }

  const { company_id, variant_id, force, tags, trigger_source, is_followup } = req.body || {};
  if (!company_id || !variant_id) {
    return res.status(400).json({ error: "company_id, variant_idは必須です" });
  }
  const triggerSource = trigger_source === "auto_pipeline" ? "auto_pipeline" : "manual";

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

  // 再送信ガード: 同一チャネル(このAPIではform固定)への status='sent' の送信が
  // 期間を問わず過去に1件でもあれば拒否する(以前は24時間以内のみのチェックだった)。
  // フォローアップメール機能からの意図的な再送信(is_followup: true)と、強制送信(force: true)は
  // このチェックをスキップする
  if (!force && !is_followup) {
    const [sentLog] = await sql`
      SELECT id FROM send_logs
      WHERE company_id = ${company_id} AND channel = 'form' AND status = 'sent'
      LIMIT 1
    `;
    if (sentLog) {
      return res.status(400).json({
        error: "このチャネル(フォーム/メール)には既に送信済みです。フォローアップとして送りたい場合は、送信管理の「未返信フォローアップ」機能をご利用いただくか、強制送信をオンにしてください",
      });
    }
  }

  const senderEmail = process.env.SENDER_EMAIL;
  if (!senderEmail) {
    return res.status(400).json({
      error: "SENDER_EMAILが設定されていません。Vercelダッシュボードの環境変数に SENDER_EMAIL を追加してください。",
    });
  }

  // 企業情報取得
  const [company] = await sql`SELECT * FROM companies WHERE id = ${company_id}`;
  if (!company) return res.status(404).json({ error: "企業が見つかりません" });

  if (await isExcludedDomain(company.url)) {
    return res.status(400).json({ error: "除外ドメインに登録されています", type: "excluded_domain" });
  }

  const researchResult = company.research_result;

  if (settings.skip_rejection_sites !== "false" && researchResult?.rejection_detected) {
    return res.status(400).json({ error: "このサイトは営業お断りの文言が検出されています", type: "rejection_detected" });
  }

  if (!researchResult?.automatable) {
    return res.status(400).json({
      error: "この企業はフォーム自動送信に対応していません(automatable=false)。先にリサーチを実行してください。",
    });
  }

  const contactFormUrl = company.contact_form_url;
  if (!contactFormUrl) {
    return res.status(400).json({
      error: "お問い合わせフォームURLが記録されていません。先にリサーチを実行してください。",
    });
  }

  // バリアント取得
  const [variant] = await sql`SELECT * FROM message_variants WHERE id = ${variant_id}`;
  if (!variant) return res.status(404).json({ error: "バリアントが見つかりません" });

  if (company.project !== variant.project) {
    return res.status(400).json({ error: "企業とバリアントのプロジェクトが一致しません" });
  }

  // フィールド値の組み立て
  const replace      = s => (s || "").replace(/\{\{company_name\}\}/g, company.company_info?.official_name || company.name);
  const fieldMapping = researchResult.fieldMapping || [];

  const VALUE_MAP = {
    company_name:             process.env.SENDER_COMPANY_NAME      || "株式会社LOCLE",
    contact_person_name:      process.env.SENDER_PERSON_NAME       || "営業担当",
    contact_person_name_kana: process.env.SENDER_PERSON_NAME_KANA  || "エイギョウタントウ",
    email:                    senderEmail,
    phone:                    process.env.SENDER_PHONE || "",
    subject:                  replace(variant.subject_template),
    message:                  replace(variant.body_template),
    agreement_checkbox:       true,
    other:                    "",
  };

  const fieldValues = fieldMapping
    .filter(f => f.role && f.role in VALUE_MAP)
    .map(f => ({
      name:  f.name  || "",
      id:    f.id    || "",
      role:  f.role,
      value: VALUE_MAP[f.role],
    }));

  // フォーム自動送信
  let logStatus = "failed";
  let logExtra  = {};

  try {
    const result = await submitForm(contactFormUrl, fieldValues);
    // "success" → "sent" / "uncertain" → "uncertain" / throw → "failed"
    logStatus = result.status === "success" ? "sent" : "uncertain";
    logExtra  = { resultUrl: result.resultUrl, resultTitle: result.resultTitle, submitStatus: result.status };
  } catch (err) {
    logExtra = { error: err.message };
  }

  // send_logsに記録
  const tagsJson = Array.isArray(tags) && tags.length > 0 ? JSON.stringify(tags) : null;
  const [logEntry] = await sql`
    INSERT INTO send_logs (company_id, variant_id, channel, status, trigger_mode, sent_at, tags, is_followup)
    VALUES (${company_id}, ${variant_id}, 'form', ${logStatus}, 'auto', NOW(), ${tagsJson}, ${!!is_followup})
    RETURNING *
  `;

  if (logStatus === "failed") {
    return res.status(500).json({
      error: `自動送信に失敗しました: ${logExtra.error}`,
      log:   logEntry,
    });
  }

  return res.status(200).json({ success: true, log: logEntry, result: logExtra, submitStatus: logStatus });
};
