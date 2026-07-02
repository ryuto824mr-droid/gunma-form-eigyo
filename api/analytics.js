const { sql }          = require("../lib/db");
const { fetchReplies } = require("../lib/gmail-receiver");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "GETメソッドのみ対応しています" });
  }

  // --- 返信チェック ---
  if (req.query.action === "check-replies") {
    return handleCheckReplies(res);
  }

  // --- 通常の集計 ---
  try {
    const variants_stats = await sql`
      SELECT
        mv.id                                                             AS variant_id,
        mv.name                                                           AS variant_name,
        COUNT(DISTINCT sl.id)::int                                        AS send_count,
        COUNT(DISTINCT r.id)::int                                         AS response_count,
        COUNT(DISTINCT CASE WHEN r.classification = 'interested'
          THEN r.id END)::int                                             AS interested_count,
        CASE
          WHEN COUNT(DISTINCT sl.id) > 0
          THEN ROUND(COUNT(DISTINCT r.id)::numeric / COUNT(DISTINCT sl.id) * 100, 1)
          ELSE 0
        END                                                               AS response_rate
      FROM message_variants mv
      LEFT JOIN send_logs sl ON sl.variant_id  = mv.id
      LEFT JOIN responses  r  ON r.send_log_id = sl.id
      GROUP BY mv.id, mv.name
      ORDER BY send_count DESC, mv.name
    `;

    const tags_stats = await sql`
      SELECT
        kv.key                                                            AS tag_key,
        kv.value                                                          AS tag_value,
        COUNT(DISTINCT sl.id)::int                                        AS send_count,
        COUNT(DISTINCT r.id)::int                                         AS response_count,
        CASE
          WHEN COUNT(DISTINCT sl.id) > 0
          THEN ROUND(COUNT(DISTINCT r.id)::numeric / COUNT(DISTINCT sl.id) * 100, 1)
          ELSE 0
        END                                                               AS response_rate
      FROM message_variants mv
      CROSS JOIN LATERAL jsonb_each_text(COALESCE(mv.tags, '{}'::jsonb)) kv
      LEFT JOIN send_logs sl ON sl.variant_id  = mv.id
      LEFT JOIN responses  r  ON r.send_log_id = sl.id
      GROUP BY kv.key, kv.value
      ORDER BY send_count DESC, kv.key, kv.value
    `;

    return res.status(200).json({ variants_stats, tags_stats });
  } catch (err) {
    return res.status(500).json({ error: `集計エラー: ${err.message}` });
  }
};

// ---------- 返信チェックハンドラー ----------

function extractEmail(from) {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).toLowerCase().trim();
}

function extractDomain(email) {
  return email.split("@")[1] || "";
}

async function classifyEmail(subject, body) {
  if (!process.env.ANTHROPIC_API_KEY) return "other";
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
        max_tokens: 10,
        messages: [{
          role:    "user",
          content: `以下のメールを分類してください。\n件名: ${subject}\n本文: ${(body || "").slice(0, 500)}\n\n以下のいずれか1語のみで回答してください（他の文字は一切不要）:\ninterested / declined / question / other`,
        }],
      }),
    });
    const data = await res.json();
    const text = (data.content?.[0]?.text || "").trim().toLowerCase();
    return ["interested", "declined", "question"].includes(text) ? text : "other";
  } catch {
    return "other";
  }
}

async function handleCheckReplies(res) {
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

      // AI分類
      const classification = await classifyEmail(email.subject, email.body);

      // 記録
      await sql`
        INSERT INTO responses (send_log_id, classification, raw_excerpt, message_id, received_at)
        VALUES (
          ${matchedLog.id},
          ${classification},
          ${(email.body || "").slice(0, 500)},
          ${email.messageId},
          NOW()
        )
      `;
      recorded++;
    }

    return res.status(200).json({ checked, matched, recorded });
  } catch (err) {
    return res.status(500).json({ error: `返信チェックエラー: ${err.message}` });
  }
}
