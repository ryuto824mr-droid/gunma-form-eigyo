const { sql } = require("../lib/db");

module.exports = async function handler(req, res) {
  if (req.method === "GET") {
    try {
      const showArchived = req.query?.show_archived === "1";
      const project = req.query?.project;
      const hasProjectFilter = project === "locle" || project === "ozukanzukan";

      // has_sent: send_logsにstatus='sent'の記録が1件でもある企業かどうか(ユニーク判定)。
      // companies.htmlの統計サマリー「送信済み企業数」で使う。neon()のsqlタグは
      // フラグメントの合成に対応していないため、各分岐にそのままインラインで書く
      let companies;
      if (hasProjectFilter && showArchived) {
        companies = await sql`
          SELECT c.*, EXISTS(SELECT 1 FROM send_logs sl WHERE sl.company_id = c.id AND sl.status = 'sent') AS has_sent
          FROM companies c WHERE c.project = ${project} ORDER BY c.created_at DESC
        `;
      } else if (hasProjectFilter) {
        companies = await sql`
          SELECT c.*, EXISTS(SELECT 1 FROM send_logs sl WHERE sl.company_id = c.id AND sl.status = 'sent') AS has_sent
          FROM companies c WHERE c.project = ${project} AND c.archived = FALSE ORDER BY c.created_at DESC
        `;
      } else if (showArchived) {
        companies = await sql`
          SELECT c.*, EXISTS(SELECT 1 FROM send_logs sl WHERE sl.company_id = c.id AND sl.status = 'sent') AS has_sent
          FROM companies c ORDER BY c.created_at DESC
        `;
      } else {
        companies = await sql`
          SELECT c.*, EXISTS(SELECT 1 FROM send_logs sl WHERE sl.company_id = c.id AND sl.status = 'sent') AS has_sent
          FROM companies c WHERE c.archived = FALSE ORDER BY c.created_at DESC
        `;
      }
      return res.status(200).json(companies);
    } catch (err) {
      return res.status(500).json({ error: `DB取得エラー: ${err.message}` });
    }
  }

  if (req.method === "POST") {
    // CSVインポート
    if (typeof (req.body || {}).csv === "string") {
      return handleImport(req.body.csv, res);
    }

    // 単件追加
    const { name, url, email, project } = req.body || {};
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "name（文字列）が必要です" });
    }
    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "url（文字列）が必要です" });
    }
    try {
      new URL(url);
    } catch {
      return res.status(400).json({ error: "urlの形式が正しくありません" });
    }

    const restricted = detectRestrictedUrl(url);
    if (restricted) {
      return res.status(400).json(restricted);
    }

    const projectToSet = project === "ozukanzukan" ? "ozukanzukan" : "locle";

    try {
      const [company] = await sql`
        INSERT INTO companies (name, url, email, status, project)
        VALUES (${name.trim()}, ${url.trim()}, ${email?.trim() || null}, 'pending', ${projectToSet})
        RETURNING *
      `;
      return res.status(201).json(company);
    } catch (err) {
      return res.status(500).json({ error: `DB登録エラー: ${err.message}` });
    }
  }

  if (req.method === "PATCH") {
    const { id, name, priority, memo, status, next_action, next_action_date, action_status, company_tags, archived } = req.body || {};
    const companyId = parseInt(id, 10);
    if (!companyId || isNaN(companyId)) {
      return res.status(400).json({ error: "有効なidが必要です" });
    }

    if (name !== undefined) {
      if (!name || typeof name !== "string" || !name.trim()) {
        return res.status(400).json({ error: "nameは空にできません" });
      }
      try {
        const [updated] = await sql`
          UPDATE companies
          SET name = ${name.trim()}
          WHERE id = ${companyId}
          RETURNING *
        `;
        if (!updated) return res.status(404).json({ error: "企業が見つかりません" });
        return res.status(200).json(updated);
      } catch (err) {
        return res.status(500).json({ error: `DB更新エラー: ${err.message}` });
      }
    }

    if (priority !== undefined) {
      const p = parseInt(priority, 10);
      if (isNaN(p) || p < 0 || p > 3) {
        return res.status(400).json({ error: "priorityは0〜3の整数で指定してください" });
      }
      try {
        const [updated] = await sql`
          UPDATE companies
          SET priority = ${p}
          WHERE id = ${companyId}
          RETURNING *
        `;
        if (!updated) return res.status(404).json({ error: "企業が見つかりません" });
        return res.status(200).json(updated);
      } catch (err) {
        return res.status(500).json({ error: `DB更新エラー: ${err.message}` });
      }
    }

    if (memo !== undefined) {
      try {
        const [updated] = await sql`
          UPDATE companies
          SET memo = ${memo || null}
          WHERE id = ${companyId}
          RETURNING *
        `;
        if (!updated) return res.status(404).json({ error: "企業が見つかりません" });
        return res.status(200).json(updated);
      } catch (err) {
        return res.status(500).json({ error: `DB更新エラー: ${err.message}` });
      }
    }

    if (status !== undefined) {
      const validStatuses = ["pending", "researching", "researched", "captcha_blocked", "no_form", "error", "rejected", "iframe_form_detected", "access_blocked"];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: "有効なstatusを指定してください" });
      }
      try {
        const [updated] = await sql`
          UPDATE companies
          SET status = ${status}
          WHERE id = ${companyId}
          RETURNING *
        `;
        if (!updated) return res.status(404).json({ error: "企業が見つかりません" });
        return res.status(200).json(updated);
      } catch (err) {
        return res.status(500).json({ error: `DB更新エラー: ${err.message}` });
      }
    }

    if (next_action !== undefined || next_action_date !== undefined || action_status !== undefined) {
      const validActionStatuses = ["none", "follow_up", "meeting_set", "rejected", "closed"];
      if (action_status !== undefined && !validActionStatuses.includes(action_status)) {
        return res.status(400).json({ error: "有効なaction_statusを指定してください" });
      }
      try {
        const [current] = await sql`
          SELECT next_action, next_action_date, action_status FROM companies WHERE id = ${companyId}
        `;
        if (!current) return res.status(404).json({ error: "企業が見つかりません" });

        const newNextAction     = next_action !== undefined ? (next_action || null) : current.next_action;
        const newNextActionDate = next_action_date !== undefined ? (next_action_date || null) : current.next_action_date;
        const newActionStatus   = action_status !== undefined ? action_status : current.action_status;

        const [updated] = await sql`
          UPDATE companies
          SET
            next_action      = ${newNextAction},
            next_action_date = ${newNextActionDate},
            action_status    = ${newActionStatus}
          WHERE id = ${companyId}
          RETURNING *
        `;
        return res.status(200).json(updated);
      } catch (err) {
        return res.status(500).json({ error: `DB更新エラー: ${err.message}` });
      }
    }

    if (company_tags !== undefined) {
      if (!Array.isArray(company_tags)) {
        return res.status(400).json({ error: "company_tagsは配列で指定してください" });
      }
      try {
        const [updated] = await sql`
          UPDATE companies
          SET company_tags = ${JSON.stringify(company_tags)}
          WHERE id = ${companyId}
          RETURNING *
        `;
        if (!updated) return res.status(404).json({ error: "企業が見つかりません" });
        return res.status(200).json(updated);
      } catch (err) {
        return res.status(500).json({ error: `DB更新エラー: ${err.message}` });
      }
    }

    if (archived !== undefined) {
      try {
        const [updated] = await sql`
          UPDATE companies
          SET archived = ${!!archived}
          WHERE id = ${companyId}
          RETURNING *
        `;
        if (!updated) return res.status(404).json({ error: "企業が見つかりません" });
        return res.status(200).json(updated);
      } catch (err) {
        return res.status(500).json({ error: `DB更新エラー: ${err.message}` });
      }
    }

    return res.status(400).json({ error: "name, priority, memo, status, next_action, next_action_date, action_status, company_tags, archivedのいずれかが必要です" });
  }

  if (req.method === "DELETE") {
    const { id, force } = req.body || {};
    const companyId = parseInt(id, 10);
    if (!companyId || isNaN(companyId)) {
      return res.status(400).json({ error: "有効なidが必要です" });
    }
    try {
      if (!force) {
        const logs = await sql`SELECT id FROM send_logs WHERE company_id = ${companyId} LIMIT 1`;
        const scheduled = await sql`SELECT id FROM scheduled_sends WHERE company_id = ${companyId} LIMIT 1`;
        if (logs.length > 0 || scheduled.length > 0) {
          return res.status(409).json({ error: "送信履歴がある企業は削除できません", type: "has_logs" });
        }
        const [deleted] = await sql`DELETE FROM companies WHERE id = ${companyId} RETURNING id`;
        if (!deleted) return res.status(404).json({ error: "企業が見つかりません" });
        return res.status(200).json({ deleted: true, id: deleted.id });
      }

      // force=true: 送信履歴・反応データも含めて完全削除
      await sql`DELETE FROM responses WHERE send_log_id IN (SELECT id FROM send_logs WHERE company_id = ${companyId})`;
      await sql`DELETE FROM send_logs WHERE company_id = ${companyId}`;
      await sql`DELETE FROM scheduled_sends WHERE company_id = ${companyId}`;
      const [deleted] = await sql`DELETE FROM companies WHERE id = ${companyId} RETURNING id`;
      if (!deleted) return res.status(404).json({ error: "企業が見つかりません" });
      return res.status(200).json({ deleted: true, id: deleted.id });
    } catch (err) {
      return res.status(500).json({ error: `DB削除エラー: ${err.message}` });
    }
  }

  return res.status(405).json({ error: "GET / POST / PATCH / DELETE のみ対応しています" });
};

function detectRestrictedUrl(url) {
  const lower = url.toLowerCase();
  if (lower.includes("maps.google.com") || lower.includes("google.com/maps")) {
    return { error: "Googleマップは直接登録できません。企業サイトのURLを個別に入力してください", type: "google_maps" };
  }
  if (lower.includes("itp.ne.jp")) {
    return { error: "タウンページは直接登録できません。企業サイトのURLを個別に入力してください", type: "google_maps" };
  }
  return null;
}

async function handleImport(csvText, res) {
  const lines = csvText.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) {
    return res.status(400).json({ error: "CSVにデータ行がありません（ヘッダー行のみ）" });
  }

  const headers  = parseCSVLine(lines[0]).map(h => h.toLowerCase().trim());
  const nameIdx  = headers.indexOf("name");
  const urlIdx   = headers.indexOf("url");
  const emailIdx = headers.indexOf("email");

  if (nameIdx === -1 || urlIdx === -1) {
    return res.status(400).json({ error: "CSVヘッダーにname, urlが必要です" });
  }

  let imported = 0;
  let skipped  = 0;

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const name   = (values[nameIdx]  || "").trim();
    const url    = (values[urlIdx]   || "").trim();
    const email  = emailIdx !== -1 ? ((values[emailIdx] || "").trim() || null) : null;

    if (!name || !url) { skipped++; continue; }
    try { new URL(url); } catch { skipped++; continue; }

    const [existing] = await sql`SELECT id FROM companies WHERE url = ${url} LIMIT 1`;
    if (existing) { skipped++; continue; }

    try {
      await sql`
        INSERT INTO companies (name, url, email, status)
        VALUES (${name}, ${url}, ${email}, 'pending')
      `;
      imported++;
    } catch {
      skipped++;
    }
  }

  return res.status(200).json({ imported, skipped });
}

function parseCSVLine(line) {
  const result = [];
  let current  = "";
  let inQuotes = false;

  for (const ch of line) {
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}
