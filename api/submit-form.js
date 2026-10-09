const { sql, isExcludedDomain, getSettings } = require("../lib/db");
const { submitForm } = require("../lib/form-submitter");
const { loadSenderProfile, validateProfile, checkBodyName } = require("../lib/sender-profile");
const { hiraganaToKatakana } = require("../lib/sender-format");

// vercel.jsonでこの関数のmaxDurationは60秒に設定されている。送信しても画面遷移しない
// JS発火型フォーム等でPuppeteerの処理が長引きこれを超えると、Vercelに強制終了され、
// ブラウザ側には応答が届かず「Failed to fetch」になってしまう(send_logsへの記録も
// 保証されない)。api/companies/[id]/research.jsと同様に、maxDurationの90%(54秒)が
// 経過した時点で自ら諦めてstatus='failed'を記録し、必ずJSONで応答を返すようにする。
// 前段のDB問い合わせにかかった時間も含めるため、ハンドラ開始時刻から計測する
const SUBMIT_TIMEOUT_MS = 54000;
const SUBMIT_TIMEOUT_SENTINEL = "__SUBMIT_TIMEOUT__";

module.exports = async function handler(req, res) {
  const startedAt = Date.now();

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

  // 企業情報取得
  const [company] = await sql`SELECT * FROM companies WHERE id = ${company_id}`;
  if (!company) return res.status(404).json({ error: "企業が見つかりません" });

  // アーカイブ済み、またはアクションステータスが「クローズ」の企業は営業対象から除外されている。
  // 以前は営業お断りの判定(research_result.rejection_detected)しか見ておらず、
  // rejection_detectedが更新されていない除外済み企業(花山うどん等)に手動送信できてしまったため、
  // rejection_detected・強制送信(force)・skip_rejection_sitesの設定に関わらず必ず拒否する
  if (company.archived === true || company.action_status === "closed") {
    return res.status(400).json({
      error: "この企業は営業対象から除外されています(アーカイブ済み、またはアクションステータスが「クローズ」)",
      type: "excluded_company",
    });
  }

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

  // 送信者プロフィール(フォームで名乗る名前・会社名・連絡先)。以前は環境変数1組を既定値付きで
  // 使っており、別人の名前で送信していたため、プロジェクトごとにDBで管理し、未登録・空欄・
  // 形式不正のときは既定値で送らずに止める(type: "sender_profile_missing"。何も入力しないため
  // send_logsにも記録しない。送信キュー側はこのtypeを見て処理を中断し、pendingのまま残す)
  let senderProfileRow = null;
  try {
    senderProfileRow = await loadSenderProfile(sql, variant.project);
  } catch (err) {
    if (!(/sender_profiles/.test(err.message) && /does not exist/.test(err.message))) throw err;
  }
  const senderCheck = validateProfile(senderProfileRow || {});
  if (!senderProfileRow || !senderCheck.ok) {
    const detail = !senderProfileRow
      ? "未登録です"
      : `不完全です(${[...senderCheck.missing.map(m => `${m}が未入力`), ...senderCheck.invalid.map(i => `${i.field}: ${i.reason}`)].join(" / ")})`;
    return res.status(400).json({
      error: `このプロジェクト(${variant.project})の送信者プロフィールが${detail}。CRMの設定画面で登録してください`,
      type: "sender_profile_missing",
      project: variant.project,
      missing: senderProfileRow ? senderCheck.missing : null,
      invalid: senderProfileRow ? senderCheck.invalid : null,
    });
  }
  const sender = senderCheck.profile;
  const bodyNameCheck = checkBodyName(`${variant.subject_template || ""}\n${variant.body_template || ""}`, sender);
  const senderSnapshot = {
    project:          variant.project,
    person_name:      sender.person_name,
    person_name_kana: sender.person_name_kana,
    company_name:     sender.company_name,
    email:            sender.email,
    phone:            sender.phone,
    body_name_check:  bodyNameCheck,
  };
  const warnings = bodyNameCheck === "mismatch"
    ? [`本文の署名と送信者名(${sender.person_name})が一致しません。フォームの「お名前」欄には${sender.person_name}が入ります`]
    : [];

  // フィールド値の組み立て
  const replace      = s => (s || "").replace(/\{\{company_name\}\}/g, company.company_info?.official_name || company.name);
  const fieldMapping = researchResult.fieldMapping || [];

  const VALUE_MAP = {
    company_name:             sender.company_name,
    contact_person_name:      sender.person_name,
    // ふりがなの既定はカタカナ(lib/form-submitter.jsがラベルを見て、ひらがな指定の欄だけひらがなにする)
    contact_person_name_kana: hiraganaToKatakana(sender.person_name_kana),
    email:                    sender.email,
    phone:                    sender.phone,
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
  let timeoutId;
  let rejectionText = null;

  // 項目対応に含まれない欄(確認用メールアドレス・3分割の電話番号)の補完や、お名前/ふりがなの
  // 取り違え補正に使う送信者情報
  const profile = {
    companyName:    VALUE_MAP.company_name,
    personName:     VALUE_MAP.contact_person_name,
    personNameKana: VALUE_MAP.contact_person_name_kana,
    email:          VALUE_MAP.email,
    phone:          VALUE_MAP.phone,
  };

  try {
    const remainingMs = Math.max(0, SUBMIT_TIMEOUT_MS - (Date.now() - startedAt));
    const result = await Promise.race([
      submitForm(contactFormUrl, fieldValues, { profile }),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(SUBMIT_TIMEOUT_SENTINEL)), remainingMs);
      }),
    ]);
    if (result.status === "rejection_checkbox") rejectionText = result.rejectionText;
    // "success" → "sent" / "uncertain" → "uncertain" / throw → "failed"
    logStatus = result.status === "success" ? "sent" : "uncertain";
    logExtra  = { resultUrl: result.resultUrl, resultTitle: result.resultTitle, submitStatus: result.status, filledFields: result.filledFields || null };
  } catch (err) {
    if (err.message === SUBMIT_TIMEOUT_SENTINEL) {
      logExtra = { error: "送信処理がタイムアウトしました", timedOut: true };
    } else {
      logExtra = { error: err.message };
    }
  } finally {
    clearTimeout(timeoutId);
  }

  // 「営業目的ではありません」等の確認チェックを求めるフォームだった(実質的な営業お断り)。
  // 何も入力・送信していないためsend_logsには記録せず、以後の送信も止まるよう
  // research_result.rejection_detectedをtrueにする(リサーチ時の営業お断り検出と同じ扱い)
  if (rejectionText) {
    const note = `営業目的でないことの確認チェックを検出: ${rejectionText}`;
    await sql`
      UPDATE companies
      SET research_result = jsonb_set(
            jsonb_set(COALESCE(research_result, '{}'::jsonb), '{rejection_detected}', 'true'::jsonb),
            '{rejection_text}', to_jsonb(${note}::text)),
          updated_at = NOW()
      WHERE id = ${company_id}
    `;
    return res.status(400).json({ error: `このサイトは営業お断りとみなされます(${note})`, type: "rejection_detected" });
  }

  // send_logsに記録
  const tagsJson = Array.isArray(tags) && tags.length > 0 ? JSON.stringify(tags) : null;
  const [logEntry] = await sql`
    INSERT INTO send_logs (company_id, variant_id, channel, status, trigger_mode, sent_at, tags, is_followup,
                           sender_profile_id, sender_snapshot, filled_fields)
    VALUES (${company_id}, ${variant_id}, 'form', ${logStatus}, 'auto', NOW(), ${tagsJson}, ${!!is_followup},
            ${senderProfileRow.id}, ${JSON.stringify(senderSnapshot)}, ${logExtra.filledFields ? JSON.stringify(logExtra.filledFields) : null})
    RETURNING *
  `;

  if (logStatus === "failed") {
    return res.status(500).json({
      error: `自動送信に失敗しました: ${logExtra.error}`,
      log:   logEntry,
      warnings,
      ...(logExtra.timedOut ? { type: "submit_timeout" } : {}),
    });
  }

  return res.status(200).json({ success: true, log: logEntry, result: logExtra, submitStatus: logStatus, warnings });
};
