// api/crm.js
//
// CRM関連の全操作を ?action= クエリパラメータで分岐する（Vercel Hobbyの関数数上限のため）。
// また、旧 api/db-setup.js の役割も ?action=db-setup として統合している。

const fs = require("fs");
const path = require("path");
const { neon } = require("@neondatabase/serverless");
const { sql } = require("../lib/db");

module.exports = async function handler(req, res) {
  const action = req.query?.action;

  switch (action) {
    case "db-setup":         return handleDbSetup(req, res);
    case "contacts":         return handleContacts(req, res);
    case "deals":             return handleDeals(req, res);
    case "activities":       return handleActivities(req, res);
    case "excluded-domains": return handleExcludedDomains(req, res);
    case "tasks":             return handleTasks(req, res);
    case "pipeline-stats":   return handlePipelineStats(req, res);
    default:
      return res.status(400).json({ error: "有効なaction（db-setup, contacts, deals, activities, excluded-domains, tasks, pipeline-stats）を指定してください" });
  }
};

// ==================== db-setup ====================

async function handleDbSetup(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POSTメソッドのみ対応しています" });
  }

  const { secret } = req.body || {};
  const expectedSecret = process.env.SETUP_SECRET;

  if (!expectedSecret) {
    return res.status(500).json({ error: "SETUP_SECRET 環境変数が設定されていません" });
  }
  if (secret !== expectedSecret) {
    return res.status(401).json({ error: "シークレットキーが正しくありません" });
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return res.status(500).json({ error: "DATABASE_URL 環境変数が設定されていません" });
  }

  const schemaPath = path.join(process.cwd(), "db", "schema.sql");
  let schemaSql;
  try {
    schemaSql = fs.readFileSync(schemaPath, "utf-8");
  } catch (err) {
    return res.status(500).json({ error: `schema.sql の読み込みに失敗しました: ${err.message}` });
  }

  const stripped = schemaSql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  const statements = stripped
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  try {
    const dbSql = neon(databaseUrl);
    for (const statement of statements) {
      await dbSql.query(statement);
    }
    // emailカラム追加（IF NOT EXISTSなので冪等）
    await dbSql.query("ALTER TABLE companies ADD COLUMN IF NOT EXISTS email TEXT");
    // memoカラム追加（企業メモ機能用）
    await dbSql.query("ALTER TABLE companies ADD COLUMN IF NOT EXISTS memo TEXT");
    // 次のアクション管理カラム追加
    await dbSql.query("ALTER TABLE companies ADD COLUMN IF NOT EXISTS next_action TEXT");
    await dbSql.query("ALTER TABLE companies ADD COLUMN IF NOT EXISTS next_action_date DATE");
    await dbSql.query("ALTER TABLE companies ADD COLUMN IF NOT EXISTS action_status TEXT DEFAULT 'none'");
    // 企業タグ付け機能用カラム追加
    await dbSql.query("ALTER TABLE companies ADD COLUMN IF NOT EXISTS company_tags JSONB DEFAULT '[]'");
    // アーカイブ機能用カラム追加
    await dbSql.query("ALTER TABLE companies ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT FALSE");
    await dbSql.query("UPDATE companies SET archived = false WHERE archived IS NULL");
    // tasksテーブル追加（CRMタスク管理用）
    await dbSql.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id          SERIAL PRIMARY KEY,
        company_id  INTEGER REFERENCES companies(id),
        deal_id     INTEGER REFERENCES deals(id),
        title       TEXT NOT NULL,
        due_date    DATE,
        done        BOOLEAN DEFAULT FALSE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // send_logs.tags追加（検索条件タグの記録用）
    await dbSql.query("ALTER TABLE send_logs ADD COLUMN IF NOT EXISTS tags JSONB");
    // responses.message_id追加（返信自動検出用）
    await dbSql.query("ALTER TABLE responses ADD COLUMN IF NOT EXISTS message_id TEXT");
    await dbSql.query("CREATE UNIQUE INDEX IF NOT EXISTS responses_message_id_uidx ON responses (message_id) WHERE message_id IS NOT NULL");
    return res.status(200).json({ message: "スキーマのセットアップが完了しました", tables: statements.length });
  } catch (err) {
    return res.status(500).json({ error: `DB実行エラー: ${err.message}` });
  }
}

// ==================== contacts ====================

async function handleContacts(req, res) {
  if (req.method === "GET") {
    try {
      const companyId = req.query.company_id ? parseInt(req.query.company_id, 10) : null;
      const contacts = companyId
        ? await sql`
            SELECT ct.*, c.name AS company_name
            FROM contacts ct JOIN companies c ON c.id = ct.company_id
            WHERE ct.company_id = ${companyId}
            ORDER BY ct.created_at DESC
          `
        : await sql`
            SELECT ct.*, c.name AS company_name
            FROM contacts ct JOIN companies c ON c.id = ct.company_id
            ORDER BY ct.created_at DESC
          `;
      return res.status(200).json(contacts);
    } catch (err) {
      return res.status(500).json({ error: `DB取得エラー: ${err.message}` });
    }
  }

  if (req.method === "POST") {
    const { company_id, name, title, email, phone, note } = req.body || {};
    const companyId = parseInt(company_id, 10);
    if (!companyId || isNaN(companyId)) {
      return res.status(400).json({ error: "company_idが必要です" });
    }
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "name（文字列）が必要です" });
    }
    try {
      const [contact] = await sql`
        INSERT INTO contacts (company_id, name, title, email, phone, note)
        VALUES (${companyId}, ${name.trim()}, ${title || null}, ${email || null}, ${phone || null}, ${note || null})
        RETURNING *
      `;
      const [withCompany] = await sql`SELECT ct.*, c.name AS company_name FROM contacts ct JOIN companies c ON c.id = ct.company_id WHERE ct.id = ${contact.id}`;
      return res.status(201).json(withCompany);
    } catch (err) {
      return res.status(500).json({ error: `DB登録エラー: ${err.message}` });
    }
  }

  if (req.method === "DELETE") {
    const { id } = req.body || {};
    const contactId = parseInt(id, 10);
    if (!contactId || isNaN(contactId)) {
      return res.status(400).json({ error: "有効なidが必要です" });
    }
    try {
      const [deleted] = await sql`DELETE FROM contacts WHERE id = ${contactId} RETURNING id`;
      if (!deleted) return res.status(404).json({ error: "コンタクトが見つかりません" });
      return res.status(200).json({ deleted: true, id: deleted.id });
    } catch (err) {
      return res.status(500).json({ error: `DB削除エラー: ${err.message}` });
    }
  }

  return res.status(405).json({ error: "GET / POST / DELETE のみ対応しています" });
}

// ==================== deals ====================

const DEAL_STAGES = ["lead", "contacted", "proposal", "negotiation", "won", "lost"];

async function handleDeals(req, res) {
  if (req.method === "GET") {
    try {
      const companyId = req.query.company_id ? parseInt(req.query.company_id, 10) : null;
      const deals = companyId
        ? await sql`
            SELECT d.*, c.name AS company_name
            FROM deals d JOIN companies c ON c.id = d.company_id
            WHERE d.company_id = ${companyId}
            ORDER BY d.updated_at DESC
          `
        : await sql`
            SELECT d.*, c.name AS company_name
            FROM deals d JOIN companies c ON c.id = d.company_id
            ORDER BY d.updated_at DESC
          `;
      return res.status(200).json(deals);
    } catch (err) {
      return res.status(500).json({ error: `DB取得エラー: ${err.message}` });
    }
  }

  if (req.method === "POST") {
    const { company_id, title, stage, amount, expected_close_date, note } = req.body || {};
    const companyId = parseInt(company_id, 10);
    if (!companyId || isNaN(companyId)) {
      return res.status(400).json({ error: "company_idが必要です" });
    }
    if (!title || typeof title !== "string" || !title.trim()) {
      return res.status(400).json({ error: "title（文字列）が必要です" });
    }
    const dealStage = stage || "lead";
    if (!DEAL_STAGES.includes(dealStage)) {
      return res.status(400).json({ error: "有効なstageを指定してください" });
    }
    try {
      const [deal] = await sql`
        INSERT INTO deals (company_id, title, stage, amount, expected_close_date, note)
        VALUES (${companyId}, ${title.trim()}, ${dealStage}, ${amount ?? null}, ${expected_close_date || null}, ${note || null})
        RETURNING *
      `;
      const [withCompany] = await sql`SELECT d.*, c.name AS company_name FROM deals d JOIN companies c ON c.id = d.company_id WHERE d.id = ${deal.id}`;
      return res.status(201).json(withCompany);
    } catch (err) {
      return res.status(500).json({ error: `DB登録エラー: ${err.message}` });
    }
  }

  if (req.method === "PATCH") {
    const { id, stage, amount, note, expected_close_date, title } = req.body || {};
    const dealId = parseInt(id, 10);
    if (!dealId || isNaN(dealId)) {
      return res.status(400).json({ error: "有効なidが必要です" });
    }
    if (stage !== undefined && !DEAL_STAGES.includes(stage)) {
      return res.status(400).json({ error: "有効なstageを指定してください" });
    }
    try {
      const [current] = await sql`SELECT * FROM deals WHERE id = ${dealId}`;
      if (!current) return res.status(404).json({ error: "商談が見つかりません" });

      const newTitle             = title !== undefined ? title : current.title;
      const newStage              = stage !== undefined ? stage : current.stage;
      const newAmount             = amount !== undefined ? amount : current.amount;
      const newExpectedCloseDate  = expected_close_date !== undefined ? (expected_close_date || null) : current.expected_close_date;
      const newNote                = note !== undefined ? note : current.note;

      const [updated] = await sql`
        UPDATE deals
        SET title = ${newTitle}, stage = ${newStage}, amount = ${newAmount},
            expected_close_date = ${newExpectedCloseDate}, note = ${newNote}, updated_at = NOW()
        WHERE id = ${dealId}
        RETURNING *
      `;
      const [withCompany] = await sql`SELECT d.*, c.name AS company_name FROM deals d JOIN companies c ON c.id = d.company_id WHERE d.id = ${updated.id}`;
      return res.status(200).json(withCompany);
    } catch (err) {
      return res.status(500).json({ error: `DB更新エラー: ${err.message}` });
    }
  }

  if (req.method === "DELETE") {
    const { id } = req.body || {};
    const dealId = parseInt(id, 10);
    if (!dealId || isNaN(dealId)) {
      return res.status(400).json({ error: "有効なidが必要です" });
    }
    try {
      await sql`UPDATE activities SET deal_id = NULL WHERE deal_id = ${dealId}`;
      const [deleted] = await sql`DELETE FROM deals WHERE id = ${dealId} RETURNING id`;
      if (!deleted) return res.status(404).json({ error: "商談が見つかりません" });
      return res.status(200).json({ deleted: true, id: deleted.id });
    } catch (err) {
      return res.status(500).json({ error: `DB削除エラー: ${err.message}` });
    }
  }

  return res.status(405).json({ error: "GET / POST / PATCH / DELETE のみ対応しています" });
}

// ==================== activities ====================

const ACTIVITY_TYPES = ["note", "call", "email", "form", "meeting", "other"];

async function handleActivities(req, res) {
  if (req.method === "GET") {
    try {
      const companyId = req.query.company_id ? parseInt(req.query.company_id, 10) : null;
      const activities = companyId
        ? await sql`
            SELECT a.*, c.name AS company_name
            FROM activities a JOIN companies c ON c.id = a.company_id
            WHERE a.company_id = ${companyId}
            ORDER BY a.activity_at DESC
          `
        : await sql`
            SELECT a.*, c.name AS company_name
            FROM activities a JOIN companies c ON c.id = a.company_id
            ORDER BY a.activity_at DESC
          `;
      return res.status(200).json(activities);
    } catch (err) {
      return res.status(500).json({ error: `DB取得エラー: ${err.message}` });
    }
  }

  if (req.method === "POST") {
    const { company_id, deal_id, type, content, activity_at } = req.body || {};
    const companyId = parseInt(company_id, 10);
    if (!companyId || isNaN(companyId)) {
      return res.status(400).json({ error: "company_idが必要です" });
    }
    if (!content || typeof content !== "string" || !content.trim()) {
      return res.status(400).json({ error: "content（文字列）が必要です" });
    }
    const activityType = type || "note";
    if (!ACTIVITY_TYPES.includes(activityType)) {
      return res.status(400).json({ error: "有効なtypeを指定してください" });
    }
    const dealId = deal_id ? parseInt(deal_id, 10) : null;
    try {
      const [activity] = await sql`
        INSERT INTO activities (company_id, deal_id, type, content, activity_at)
        VALUES (${companyId}, ${dealId}, ${activityType}, ${content.trim()}, ${activity_at || new Date().toISOString()})
        RETURNING *
      `;
      const [withCompany] = await sql`SELECT a.*, c.name AS company_name FROM activities a JOIN companies c ON c.id = a.company_id WHERE a.id = ${activity.id}`;
      return res.status(201).json(withCompany);
    } catch (err) {
      return res.status(500).json({ error: `DB登録エラー: ${err.message}` });
    }
  }

  return res.status(405).json({ error: "GET / POST のみ対応しています" });
}

// ==================== excluded-domains ====================

async function handleExcludedDomains(req, res) {
  if (req.method === "GET") {
    try {
      const domains = await sql`SELECT * FROM excluded_domains ORDER BY created_at DESC`;
      return res.status(200).json(domains);
    } catch (err) {
      return res.status(500).json({ error: `DB取得エラー: ${err.message}` });
    }
  }

  if (req.method === "POST") {
    const { domain, reason } = req.body || {};
    if (!domain || typeof domain !== "string" || !domain.trim()) {
      return res.status(400).json({ error: "domain（文字列）が必要です" });
    }
    try {
      const [created] = await sql`
        INSERT INTO excluded_domains (domain, reason)
        VALUES (${domain.trim().toLowerCase()}, ${reason || null})
        RETURNING *
      `;
      return res.status(201).json(created);
    } catch (err) {
      if (err.message?.includes("duplicate key")) {
        return res.status(409).json({ error: "このドメインは既に登録されています" });
      }
      return res.status(500).json({ error: `DB登録エラー: ${err.message}` });
    }
  }

  if (req.method === "DELETE") {
    const { id } = req.body || {};
    const domainId = parseInt(id, 10);
    if (!domainId || isNaN(domainId)) {
      return res.status(400).json({ error: "有効なidが必要です" });
    }
    try {
      const [deleted] = await sql`DELETE FROM excluded_domains WHERE id = ${domainId} RETURNING id`;
      if (!deleted) return res.status(404).json({ error: "除外ドメインが見つかりません" });
      return res.status(200).json({ deleted: true, id: deleted.id });
    } catch (err) {
      return res.status(500).json({ error: `DB削除エラー: ${err.message}` });
    }
  }

  return res.status(405).json({ error: "GET / POST / DELETE のみ対応しています" });
}

// ==================== tasks ====================

async function handleTasks(req, res) {
  if (req.method === "GET") {
    try {
      const includeDone = req.query.include_done === "1";
      const tasks = includeDone
        ? await sql`
            SELECT t.*, c.name AS company_name, d.title AS deal_title
            FROM tasks t
            LEFT JOIN companies c ON c.id = t.company_id
            LEFT JOIN deals d ON d.id = t.deal_id
            ORDER BY t.due_date ASC NULLS LAST, t.created_at DESC
          `
        : await sql`
            SELECT t.*, c.name AS company_name, d.title AS deal_title
            FROM tasks t
            LEFT JOIN companies c ON c.id = t.company_id
            LEFT JOIN deals d ON d.id = t.deal_id
            WHERE t.done = FALSE
            ORDER BY t.due_date ASC NULLS LAST, t.created_at DESC
          `;
      return res.status(200).json(tasks);
    } catch (err) {
      return res.status(500).json({ error: `DB取得エラー: ${err.message}` });
    }
  }

  if (req.method === "POST") {
    const { company_id, deal_id, title, due_date } = req.body || {};
    if (!title || typeof title !== "string" || !title.trim()) {
      return res.status(400).json({ error: "title（文字列）が必要です" });
    }
    const companyId = company_id ? parseInt(company_id, 10) : null;
    const dealId    = deal_id ? parseInt(deal_id, 10) : null;
    try {
      const [task] = await sql`
        INSERT INTO tasks (company_id, deal_id, title, due_date)
        VALUES (${companyId}, ${dealId}, ${title.trim()}, ${due_date || null})
        RETURNING *
      `;
      const [withNames] = await sql`
        SELECT t.*, c.name AS company_name, d.title AS deal_title
        FROM tasks t
        LEFT JOIN companies c ON c.id = t.company_id
        LEFT JOIN deals d ON d.id = t.deal_id
        WHERE t.id = ${task.id}
      `;
      return res.status(201).json(withNames);
    } catch (err) {
      return res.status(500).json({ error: `DB登録エラー: ${err.message}` });
    }
  }

  if (req.method === "PATCH") {
    const { id, done, title, due_date } = req.body || {};
    const taskId = parseInt(id, 10);
    if (!taskId || isNaN(taskId)) {
      return res.status(400).json({ error: "有効なidが必要です" });
    }
    try {
      const [current] = await sql`SELECT * FROM tasks WHERE id = ${taskId}`;
      if (!current) return res.status(404).json({ error: "タスクが見つかりません" });

      const newTitle   = title !== undefined ? title : current.title;
      const newDueDate = due_date !== undefined ? (due_date || null) : current.due_date;
      const newDone     = done !== undefined ? !!done : current.done;

      const [updated] = await sql`
        UPDATE tasks
        SET title = ${newTitle}, due_date = ${newDueDate}, done = ${newDone}
        WHERE id = ${taskId}
        RETURNING *
      `;
      const [withNames] = await sql`
        SELECT t.*, c.name AS company_name, d.title AS deal_title
        FROM tasks t
        LEFT JOIN companies c ON c.id = t.company_id
        LEFT JOIN deals d ON d.id = t.deal_id
        WHERE t.id = ${updated.id}
      `;
      return res.status(200).json(withNames);
    } catch (err) {
      return res.status(500).json({ error: `DB更新エラー: ${err.message}` });
    }
  }

  if (req.method === "DELETE") {
    const { id } = req.body || {};
    const taskId = parseInt(id, 10);
    if (!taskId || isNaN(taskId)) {
      return res.status(400).json({ error: "有効なidが必要です" });
    }
    try {
      const [deleted] = await sql`DELETE FROM tasks WHERE id = ${taskId} RETURNING id`;
      if (!deleted) return res.status(404).json({ error: "タスクが見つかりません" });
      return res.status(200).json({ deleted: true, id: deleted.id });
    } catch (err) {
      return res.status(500).json({ error: `DB削除エラー: ${err.message}` });
    }
  }

  return res.status(405).json({ error: "GET / POST / PATCH / DELETE のみ対応しています" });
}

// ==================== pipeline-stats ====================

async function handlePipelineStats(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "GETのみ対応しています" });
  }
  try {
    const stageRows = await sql`
      SELECT stage,
             COUNT(*)::int AS deal_count,
             COALESCE(SUM(amount), 0)::int AS total_amount,
             COALESCE(AVG(amount), 0)::int AS avg_amount
      FROM deals
      GROUP BY stage
    `;
    const stageMap = {};
    stageRows.forEach(r => { stageMap[r.stage] = r; });
    const stages = DEAL_STAGES.map(stage => ({
      stage,
      deal_count: stageMap[stage]?.deal_count || 0,
      total_amount: stageMap[stage]?.total_amount || 0,
      avg_amount: stageMap[stage]?.avg_amount || 0,
    }));

    const [{ total_pipeline }] = await sql`
      SELECT COALESCE(SUM(amount), 0)::int AS total_pipeline
      FROM deals
      WHERE stage NOT IN ('won', 'lost')
    `;
    const wonCount  = stageMap["won"]?.deal_count || 0;
    const lostCount = stageMap["lost"]?.deal_count || 0;
    const winRate   = (wonCount + lostCount) > 0 ? (wonCount / (wonCount + lostCount)) * 100 : 0;

    return res.status(200).json({
      stages,
      total_pipeline,
      won_count: wonCount,
      lost_count: lostCount,
      win_rate: Math.round(winRate * 10) / 10,
    });
  } catch (err) {
    return res.status(500).json({ error: `DB取得エラー: ${err.message}` });
  }
}
