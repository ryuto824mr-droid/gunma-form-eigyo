const { sql } = require("../lib/db");
const { submitForm } = require("../lib/form-submitter");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POSTメソッドのみ対応しています" });
  }

  const { company_id, variant_id, force } = req.body || {};
  if (!company_id || !variant_id) {
    return res.status(400).json({ error: "company_id, variant_idは必須です" });
  }

  // 再送信ガード
  if (!force) {
    const [sentLog] = await sql`
      SELECT id FROM send_logs
      WHERE company_id = ${company_id} AND status = 'sent'
      LIMIT 1
    `;
    if (sentLog) {
      return res.status(400).json({
        error: `この企業にはすでに送信済みです(send_log_id: ${sentLog.id})。再送信する場合はsend.htmlで強制送信フラグを使ってください`,
      });
    }
  }

  // 送信間隔制限(24時間)
  if (!force) {
    const [lastLog] = await sql`
      SELECT id, sent_at FROM send_logs
      WHERE company_id = ${company_id}
      ORDER BY sent_at DESC LIMIT 1
    `;
    if (lastLog) {
      const hoursSince = (Date.now() - new Date(lastLog.sent_at).getTime()) / 3600000;
      if (hoursSince < 24) {
        return res.status(429).json({
          error: `最後の送信から24時間経過していません(最終送信: ${Math.floor(hoursSince)}時間前)`,
        });
      }
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

  const researchResult = company.research_result;
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

  // フィールド値の組み立て
  const replace      = s => (s || "").replace(/\{\{company_name\}\}/g, company.name);
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
  const [logEntry] = await sql`
    INSERT INTO send_logs (company_id, variant_id, channel, status, trigger_mode, sent_at)
    VALUES (${company_id}, ${variant_id}, 'form', ${logStatus}, 'auto', NOW())
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
