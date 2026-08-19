const { sql }          = require("../lib/db");
const { fetchReplies, testGmailAuth } = require("../lib/gmail-receiver");

module.exports = async function handler(req, res) {
  // --- 送信スケジュール（GET/POST/DELETE） ---
  if (req.query.action === "scheduled-sends") {
    return handleScheduledSends(req, res);
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "GETメソッドのみ対応しています" });
  }

  // --- スケジュール実行（枠のみ・ログ出力のみ） ---
  if (req.query.action === "run-scheduled") {
    return handleRunScheduled(res);
  }

  // --- 返信チェック ---
  if (req.query.action === "check-replies") {
    return handleCheckReplies(req, res);
  }

  // --- Gmail認証デバッグ ---
  if (req.query.action === "debug-gmail") {
    return handleDebugGmail(res);
  }

  // --- 通常の集計 ---
  try {
    const project = req.query.project;
    const hasProjectFilter = project === "locle" || project === "ozukanzukan";

    // response_countは「反応した企業のユニーク数」でカウントする(反応レコードの件数ではない)。
    // LEFT JOINで反応が無いsend_logsもr.id=NULLとして残るため、CASE式でNULLを除外してから
    // company_idをDISTINCTカウントする(単純にCOUNT(DISTINCT r.id)にすると反応レコード自体の
    // 件数になり、同じ企業に複数回反応記録が付いた場合に反応率が実態を超えてしまう)。
    // send_countの分母もstatus='sent'の送信のみに限定する(失敗/不明な送信を含めると
    // 実際に届いた送信の成果という実態と乖離するため)
    const variants_stats = hasProjectFilter
      ? await sql`
          SELECT
            mv.id                                                             AS variant_id,
            mv.name                                                           AS variant_name,
            COUNT(DISTINCT sl.id)::int                                        AS send_count,
            COUNT(DISTINCT CASE WHEN r.id IS NOT NULL THEN sl.company_id END)::int AS response_count,
            COUNT(DISTINCT CASE WHEN r.classification = 'interested'
              THEN r.id END)::int                                             AS interested_count,
            CASE
              WHEN COUNT(DISTINCT sl.id) > 0
              THEN ROUND(COUNT(DISTINCT CASE WHEN r.id IS NOT NULL THEN sl.company_id END)::numeric / COUNT(DISTINCT sl.id) * 100, 1)
              ELSE 0
            END                                                               AS response_rate
          FROM message_variants mv
          LEFT JOIN send_logs sl ON sl.variant_id = mv.id
            AND sl.company_id IN (SELECT id FROM companies WHERE project = ${project})
            AND sl.status = 'sent'
          LEFT JOIN responses  r  ON r.send_log_id = sl.id
          WHERE mv.project = ${project}
          GROUP BY mv.id, mv.name
          ORDER BY send_count DESC, mv.name
        `
      : await sql`
          SELECT
            mv.id                                                             AS variant_id,
            mv.name                                                           AS variant_name,
            COUNT(DISTINCT sl.id)::int                                        AS send_count,
            COUNT(DISTINCT CASE WHEN r.id IS NOT NULL THEN sl.company_id END)::int AS response_count,
            COUNT(DISTINCT CASE WHEN r.classification = 'interested'
              THEN r.id END)::int                                             AS interested_count,
            CASE
              WHEN COUNT(DISTINCT sl.id) > 0
              THEN ROUND(COUNT(DISTINCT CASE WHEN r.id IS NOT NULL THEN sl.company_id END)::numeric / COUNT(DISTINCT sl.id) * 100, 1)
              ELSE 0
            END                                                               AS response_rate
          FROM message_variants mv
          LEFT JOIN send_logs sl ON sl.variant_id  = mv.id AND sl.status = 'sent'
          LEFT JOIN responses  r  ON r.send_log_id = sl.id
          GROUP BY mv.id, mv.name
          ORDER BY send_count DESC, mv.name
        `;

    // チャネル別内訳。hasProjectFilterを無視して常に全プロジェクト集計になっていたため、
    // 他の集計(variants_stats/tags_stats)と同様にproject絞り込みを追加した
    const channelRows = hasProjectFilter
      ? await sql`
          SELECT
            sl.channel                                                        AS channel,
            COUNT(DISTINCT sl.id)::int                                        AS send_count,
            COUNT(DISTINCT CASE WHEN r.id IS NOT NULL THEN sl.company_id END)::int AS response_count,
            CASE
              WHEN COUNT(DISTINCT sl.id) > 0
              THEN ROUND(COUNT(DISTINCT CASE WHEN r.id IS NOT NULL THEN sl.company_id END)::numeric / COUNT(DISTINCT sl.id) * 100, 1)
              ELSE 0
            END                                                               AS response_rate
          FROM send_logs sl
          JOIN companies c ON c.id = sl.company_id
          LEFT JOIN responses r ON r.send_log_id = sl.id
          WHERE c.project = ${project} AND sl.status = 'sent'
          GROUP BY sl.channel
        `
      : await sql`
          SELECT
            sl.channel                                                        AS channel,
            COUNT(DISTINCT sl.id)::int                                        AS send_count,
            COUNT(DISTINCT CASE WHEN r.id IS NOT NULL THEN sl.company_id END)::int AS response_count,
            CASE
              WHEN COUNT(DISTINCT sl.id) > 0
              THEN ROUND(COUNT(DISTINCT CASE WHEN r.id IS NOT NULL THEN sl.company_id END)::numeric / COUNT(DISTINCT sl.id) * 100, 1)
              ELSE 0
            END                                                               AS response_rate
          FROM send_logs sl
          LEFT JOIN responses r ON r.send_log_id = sl.id
          WHERE sl.status = 'sent'
          GROUP BY sl.channel
        `;

    // 平均返信日数はメールチャネルのみ算出する(フォーム経由の反応は相手が別途メールで
    // 返信してきたものであり、フォーム送信〜返信の「経過日数」に分析上の意味がないため)。
    // 他の集計と同様にproject絞り込み・status='sent'限定を適用する
    const [{ avg_days: emailAvgResponseDays }] = hasProjectFilter
      ? await sql`
          SELECT AVG(EXTRACT(EPOCH FROM (r.received_at - sl.sent_at)) / 86400.0) AS avg_days
          FROM send_logs sl
          JOIN responses r ON r.send_log_id = sl.id
          JOIN companies c ON c.id = sl.company_id
          WHERE sl.channel = 'email' AND sl.status = 'sent' AND c.project = ${project}
        `
      : await sql`
          SELECT AVG(EXTRACT(EPOCH FROM (r.received_at - sl.sent_at)) / 86400.0) AS avg_days
          FROM send_logs sl
          JOIN responses r ON r.send_log_id = sl.id
          WHERE sl.channel = 'email' AND sl.status = 'sent'
        `;
    const emailAvgResponseDaysRounded = emailAvgResponseDays != null
      ? Math.round(Number(emailAvgResponseDays) * 10) / 10
      : null;

    const channel_breakdown = {
      email: { send_count: 0, response_count: 0, response_rate: 0, avg_response_days: null },
      form:  { send_count: 0, response_count: 0, response_rate: 0, avg_response_days: null },
    };
    channelRows.forEach(row => {
      if (!channel_breakdown[row.channel]) return;
      channel_breakdown[row.channel] = {
        send_count: row.send_count,
        response_count: row.response_count,
        response_rate: Number(row.response_rate),
        avg_response_days: row.channel === "email" ? emailAvgResponseDaysRounded : null,
      };
    });

    const tags_stats = hasProjectFilter
      ? await sql`
          SELECT
            kv.key                                                            AS tag_key,
            kv.value                                                          AS tag_value,
            COUNT(DISTINCT sl.id)::int                                        AS send_count,
            COUNT(DISTINCT CASE WHEN r.id IS NOT NULL THEN sl.company_id END)::int AS response_count,
            CASE
              WHEN COUNT(DISTINCT sl.id) > 0
              THEN ROUND(COUNT(DISTINCT CASE WHEN r.id IS NOT NULL THEN sl.company_id END)::numeric / COUNT(DISTINCT sl.id) * 100, 1)
              ELSE 0
            END                                                               AS response_rate
          FROM message_variants mv
          CROSS JOIN LATERAL jsonb_each_text(COALESCE(mv.tags, '{}'::jsonb)) kv
          LEFT JOIN send_logs sl ON sl.variant_id = mv.id
            AND sl.company_id IN (SELECT id FROM companies WHERE project = ${project})
            AND sl.status = 'sent'
          LEFT JOIN responses  r  ON r.send_log_id = sl.id
          WHERE mv.project = ${project}
          GROUP BY kv.key, kv.value
          ORDER BY send_count DESC, kv.key, kv.value
        `
      : await sql`
          SELECT
            kv.key                                                            AS tag_key,
            kv.value                                                          AS tag_value,
            COUNT(DISTINCT sl.id)::int                                        AS send_count,
            COUNT(DISTINCT CASE WHEN r.id IS NOT NULL THEN sl.company_id END)::int AS response_count,
            CASE
              WHEN COUNT(DISTINCT sl.id) > 0
              THEN ROUND(COUNT(DISTINCT CASE WHEN r.id IS NOT NULL THEN sl.company_id END)::numeric / COUNT(DISTINCT sl.id) * 100, 1)
              ELSE 0
            END                                                               AS response_rate
          FROM message_variants mv
          CROSS JOIN LATERAL jsonb_each_text(COALESCE(mv.tags, '{}'::jsonb)) kv
          LEFT JOIN send_logs sl ON sl.variant_id  = mv.id AND sl.status = 'sent'
          LEFT JOIN responses  r  ON r.send_log_id = sl.id
          GROUP BY kv.key, kv.value
          ORDER BY send_count DESC, kv.key, kv.value
        `;

    return res.status(200).json({ variants_stats, tags_stats, channel_breakdown });
  } catch (err) {
    return res.status(500).json({ error: `集計エラー: ${err.message}` });
  }
};

// ---------- 送信スケジュールハンドラー ----------

async function handleScheduledSends(req, res) {
  if (req.method === "GET") {
    try {
      const project = req.query.project;
      const hasProjectFilter = project === "locle" || project === "ozukanzukan";
      const rows = hasProjectFilter
        ? await sql`
            SELECT ss.*, c.name AS company_name, mv.name AS variant_name
            FROM scheduled_sends ss
            JOIN companies c ON c.id = ss.company_id
            JOIN message_variants mv ON mv.id = ss.variant_id
            WHERE c.project = ${project}
            ORDER BY ss.scheduled_at ASC
          `
        : await sql`
            SELECT ss.*, c.name AS company_name, mv.name AS variant_name
            FROM scheduled_sends ss
            JOIN companies c ON c.id = ss.company_id
            JOIN message_variants mv ON mv.id = ss.variant_id
            ORDER BY ss.scheduled_at ASC
          `;
      return res.status(200).json(rows);
    } catch (err) {
      return res.status(500).json({ error: `取得エラー: ${err.message}` });
    }
  }

  if (req.method === "POST") {
    const { company_id, variant_id, channel, scheduled_at } = req.body || {};
    const companyId = parseInt(company_id, 10);
    const variantId = parseInt(variant_id, 10);
    if (!companyId || isNaN(companyId)) {
      return res.status(400).json({ error: "有効なcompany_idが必要です" });
    }
    if (!variantId || isNaN(variantId)) {
      return res.status(400).json({ error: "有効なvariant_idが必要です" });
    }
    if (!scheduled_at || isNaN(Date.parse(scheduled_at))) {
      return res.status(400).json({ error: "有効なscheduled_atが必要です" });
    }
    const ch = channel === "email" ? "email" : "form";
    try {
      const [created] = await sql`
        INSERT INTO scheduled_sends (company_id, variant_id, channel, scheduled_at, status)
        VALUES (${companyId}, ${variantId}, ${ch}, ${scheduled_at}, 'pending')
        RETURNING *
      `;
      return res.status(201).json(created);
    } catch (err) {
      return res.status(500).json({ error: `登録エラー: ${err.message}` });
    }
  }

  if (req.method === "DELETE") {
    const { id } = req.body || {};
    const scheduleId = parseInt(id, 10);
    if (!scheduleId || isNaN(scheduleId)) {
      return res.status(400).json({ error: "有効なidが必要です" });
    }
    try {
      const [deleted] = await sql`DELETE FROM scheduled_sends WHERE id = ${scheduleId} RETURNING id`;
      if (!deleted) return res.status(404).json({ error: "予約が見つかりません" });
      return res.status(200).json({ id: deleted.id, deleted: true });
    } catch (err) {
      return res.status(500).json({ error: `削除エラー: ${err.message}` });
    }
  }

  return res.status(405).json({ error: "GET/POST/DELETEのみ対応しています" });
}

// ---------- スケジュール実行ハンドラー（枠のみ） ----------

async function handleRunScheduled(res) {
  try {
    const due = await sql`
      SELECT ss.*, c.name AS company_name, mv.name AS variant_name
      FROM scheduled_sends ss
      JOIN companies c ON c.id = ss.company_id
      JOIN message_variants mv ON mv.id = ss.variant_id
      WHERE ss.scheduled_at <= NOW() AND ss.status = 'pending'
    `;
    console.log(`[run-scheduled] 実行対象: ${due.length}件`, due.map(d => ({
      id: d.id, company: d.company_name, variant: d.variant_name, scheduled_at: d.scheduled_at,
    })));
    return res.status(200).json({ due: due.length, items: due });
  } catch (err) {
    return res.status(500).json({ error: `実行エラー: ${err.message}` });
  }
}

// ---------- 返信チェックハンドラー ----------

function extractEmail(from) {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).toLowerCase().trim();
}

function extractDomain(email) {
  return email.split("@")[1] || "";
}

const EMPTY_EMAIL_INFO = {
  classification:     "other",
  candidate_datetime: null,
  location:           null,
  contact_person:     null,
  special_notes:      null,
};

async function classifyEmail(subject, body) {
  if (!process.env.ANTHROPIC_API_KEY) return { ...EMPTY_EMAIL_INFO };
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key":         process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type":      "application/json",
      },
      body: JSON.stringify({
        model:      "claude-haiku-4-5-20251001",
        max_tokens: 300,
        messages: [{
          role:    "user",
          content: `以下のメールを解析し、JSONのみで回答してください（コードブロックや説明文は不要）。\n\n{"classification":"interested/declined/question/otherのいずれか1語","candidate_datetime":"候補日時（本文中の表現のまま。無ければnull）","location":"場所（無ければnull）","contact_person":"担当者名（無ければnull）","special_notes":"特記事項を1文で（無ければnull）"}\n\n件名: ${subject}\n本文: ${(body || "").slice(0, 500)}`,
        }],
      }),
    });
    const data = await res.json();
    const text = (data.content?.[0]?.text || "{}").replace(/```json\n?|```/g, "").trim();
    const parsed = JSON.parse(text);
    const classification = ["interested", "declined", "question"].includes(parsed.classification)
      ? parsed.classification
      : "other";
    return {
      classification,
      candidate_datetime: parsed.candidate_datetime || null,
      location:           parsed.location || null,
      contact_person:     parsed.contact_person || null,
      special_notes:      parsed.special_notes || null,
    };
  } catch {
    return { ...EMPTY_EMAIL_INFO };
  }
}

async function handleCheckReplies(req, res) {
  const debugAuthorized =
    !!process.env.SETUP_SECRET && req.query.debug_key === process.env.SETUP_SECRET;

  try {
    const emails = await fetchReplies();
    const checked = emails.length;

    if (checked === 0) {
      return res.status(200).json({ checked: 0, matched: 0, recorded: 0 });
    }

    // 送信済みログを企業メール付きで取得
    const sentLogs = await sql`
      SELECT sl.id, sl.company_id, sl.variant_id, c.email AS company_email, c.name AS company_name
      FROM send_logs sl
      JOIN companies c ON c.id = sl.company_id
      WHERE sl.status = 'sent' AND c.email IS NOT NULL
    `;

    let matched  = 0;
    let recorded = 0;

    for (const email of emails) {
      const fromEmail  = extractEmail(email.from);
      const fromDomain = extractDomain(fromEmail);

      const matchedLog = sentLogs.find(log => {
        const compEmail  = log.company_email.toLowerCase();
        const compDomain = extractDomain(compEmail);
        return compEmail === fromEmail ||
          (fromDomain && compDomain && fromDomain === compDomain);
      });

      if (!matchedLog) continue;
      matched++;

      // 重複チェック
      const [existing] = await sql`
        SELECT id FROM responses WHERE message_id = ${email.messageId} LIMIT 1
      `;
      if (existing) continue;

      // AI分類 + 日程調整情報の抽出
      const { classification, candidate_datetime, location, contact_person, special_notes } =
        await classifyEmail(email.subject, email.body);

      // 記録
      await sql`
        INSERT INTO responses (
          send_log_id, classification, raw_excerpt, message_id, received_at,
          candidate_datetime, location, contact_person, special_notes
        )
        VALUES (
          ${matchedLog.id},
          ${classification},
          ${(email.body || "").slice(0, 500)},
          ${email.messageId},
          NOW(),
          ${candidate_datetime},
          ${location},
          ${contact_person},
          ${special_notes}
        )
      `;
      recorded++;

      // interestedかつ候補日時が抽出できた場合、活動履歴に自動記録し、進行中の商談があればcontactedに更新
      if (classification === "interested" && candidate_datetime) {
        await sql`
          INSERT INTO activities (company_id, type, content, activity_at)
          VALUES (
            ${matchedLog.company_id},
            'email',
            ${`返信あり(日程調整の可能性): ${candidate_datetime} / ${location || "場所未定"} / ${contact_person || "担当者不明"}`},
            NOW()
          )
        `;
        await sql`
          UPDATE deals
          SET stage = 'contacted', updated_at = NOW()
          WHERE company_id = ${matchedLog.company_id} AND stage NOT IN ('won', 'lost')
        `;
      }
    }

    const payload = { checked, matched, recorded };
    if (debugAuthorized) {
      payload.debug = {
        emails_found: emails.map(e => ({ from: e.from, subject: e.subject })),
        sent_logs: sentLogs.map(l => ({ company_email: l.company_email, company_name: l.company_name })),
      };
    }
    return res.status(200).json(payload);
  } catch (err) {
    return res.status(500).json({ error: `返信チェックエラー: ${err.message}` });
  }
}

async function handleDebugGmail(res) {
  const authTest = await testGmailAuth();

  return res.status(200).json({
    has_client_id:       !!process.env.GMAIL_CLIENT_ID,
    has_client_secret:   !!process.env.GMAIL_CLIENT_SECRET,
    has_refresh_token:   !!process.env.GMAIL_REFRESH_TOKEN,
    token_refresh_ok:    authTest.ok,
    token_refresh_error: authTest.error || null,
  });
}
