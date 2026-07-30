// api/crm.js
//
// CRM関連の全操作を ?action= クエリパラメータで分岐する（Vercel Hobbyの関数数上限のため）。
// また、旧 api/db-setup.js の役割も ?action=db-setup として統合している。

const fs = require("fs");
const path = require("path");
const { neon } = require("@neondatabase/serverless");
const { sql, getSettings } = require("../lib/db");
const submitFormHandler = require("./submit-form");
const sendEmailHandler = require("./send-email");

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
    case "reports":           return handleReports(req, res);
    case "settings":          return handleSettings(req, res);
    case "ab-tests":          return handleAbTests(req, res);
    case "ab-test-stats":    return handleAbTestStats(req, res);
    case "api-usage":         return handleApiUsage(req, res);
    case "attachments":       return handleAttachments(req, res);
    case "company-clusters": return handleCompanyClusters(req, res);
    case "run-scheduled-sends": return handleRunScheduledSends(req, res);
    default:
      return res.status(400).json({ error: "有効なaction（db-setup, contacts, deals, activities, excluded-domains, tasks, pipeline-stats, reports, settings, ab-tests, ab-test-stats, api-usage, attachments, company-clusters, run-scheduled-sends）を指定してください" });
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
    // settingsテーブル追加（送信間隔・上限などの設定管理用）
    await dbSql.query(`
      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    await dbSql.query(`
      INSERT INTO settings (key, value) VALUES
        ('daily_send_limit', '20'),
        ('send_interval_seconds', '30'),
        ('skip_rejection_sites', 'true'),
        ('auto_send_hour', '9')
      ON CONFLICT (key) DO NOTHING
    `);
    // ab_testsテーブル追加（A/Bテスト機能用）
    await dbSql.query(`
      CREATE TABLE IF NOT EXISTS ab_tests (
        id           SERIAL PRIMARY KEY,
        name         TEXT NOT NULL,
        variant_a_id INTEGER NOT NULL REFERENCES message_variants(id),
        variant_b_id INTEGER NOT NULL REFERENCES message_variants(id),
        status       TEXT NOT NULL DEFAULT 'running',
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // api_usage_logsテーブル追加（API利用量トラッキング用）
    // provider: 'brave_search' / 'google_places' / 'anthropic'
    await dbSql.query(`
      CREATE TABLE IF NOT EXISTS api_usage_logs (
        id         SERIAL PRIMARY KEY,
        provider   TEXT NOT NULL,
        endpoint   TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // discovered_urlsテーブル追加（企業自動検索の重複除外用）
    await dbSql.query(`
      CREATE TABLE IF NOT EXISTS discovered_urls (
        id            SERIAL PRIMARY KEY,
        url_hostname  TEXT NOT NULL UNIQUE,
        discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // attachmentsテーブル追加（メール添付ファイル用）
    // file_dataはBase64エンコードされたファイル内容
    await dbSql.query(`
      CREATE TABLE IF NOT EXISTS attachments (
        id           SERIAL PRIMARY KEY,
        filename     TEXT NOT NULL,
        content_type TEXT NOT NULL,
        file_data    TEXT NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // message_variants.attachment_id追加（バリアントに添付ファイルを紐付ける用）
    // 添付ファイル削除時は参照を自動でNULLに(ON DELETE SET NULL)
    await dbSql.query("ALTER TABLE message_variants ADD COLUMN IF NOT EXISTS attachment_id INTEGER REFERENCES attachments(id) ON DELETE SET NULL");
    // companies.company_info追加（企業サイトから自動抽出した会社概要情報用）
    // { representative, founded_year, employee_count_text, business_description, capital, hiring_status }
    await dbSql.query("ALTER TABLE companies ADD COLUMN IF NOT EXISTS company_info JSONB");
    // scheduled_sends.error_message追加（自動送信失敗時のエラー内容記録用）
    await dbSql.query("ALTER TABLE scheduled_sends ADD COLUMN IF NOT EXISTS error_message TEXT");
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

// ==================== reports ====================

function last6Months() {
  const months = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return months;
}

// 月曜始まり・日曜終わりの日本語曜日ラベル(PostgresのEXTRACT(DOW)は日曜=0〜土曜=6)
const WEEKDAY_LABELS = ["月", "火", "水", "木", "金", "土", "日"];

const HOUR_BUCKETS = [
  { label: "午前(6-12時)",  start: 6,  end: 12 },
  { label: "午後(12-18時)", start: 12, end: 18 },
  { label: "夜(18-24時)",   start: 18, end: 24 },
  { label: "深夜(0-6時)",   start: 0,  end: 6 },
];

async function handleReports(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "GETのみ対応しています" });
  }
  try {
    const months = last6Months();
    const sinceDate = `${months[0]}-01`;

    const sendRows = await sql`
      SELECT to_char(date_trunc('month', sent_at), 'YYYY-MM') AS month, COUNT(*)::int AS count
      FROM send_logs
      WHERE sent_at >= ${sinceDate}::date
      GROUP BY 1
    `;
    const sendMap = {};
    sendRows.forEach(r => { sendMap[r.month] = r.count; });
    const monthly_sends = months.map(month => ({ month, count: sendMap[month] || 0 }));

    const responseRows = await sql`
      SELECT to_char(date_trunc('month', received_at), 'YYYY-MM') AS month, COUNT(*)::int AS count
      FROM responses
      WHERE received_at >= ${sinceDate}::date
      GROUP BY 1
    `;
    const responseMap = {};
    responseRows.forEach(r => { responseMap[r.month] = r.count; });
    const monthly_responses = months.map(month => ({ month, count: responseMap[month] || 0 }));

    const channelRows = await sql`SELECT channel, COUNT(*)::int AS count FROM send_logs GROUP BY channel`;
    const channel_stats = { form: 0, email: 0 };
    channelRows.forEach(r => { channel_stats[r.channel] = r.count; });

    const variant_performance = await sql`
      SELECT
        mv.id                                                             AS variant_id,
        mv.name                                                           AS variant_name,
        COUNT(DISTINCT sl.id)::int                                        AS send_count,
        COUNT(DISTINCT r.id)::int                                         AS response_count,
        CASE
          WHEN COUNT(DISTINCT sl.id) > 0
          THEN ROUND(COUNT(DISTINCT r.id)::numeric / COUNT(DISTINCT sl.id) * 100, 1)
          ELSE 0
        END                                                               AS response_rate
      FROM message_variants mv
      LEFT JOIN send_logs sl ON sl.variant_id  = mv.id
      LEFT JOIN responses  r  ON r.send_log_id = sl.id
      GROUP BY mv.id, mv.name
      ORDER BY send_count DESC, response_rate DESC
      LIMIT 5
    `;

    const pipelineRows = await sql`
      SELECT stage, COALESCE(SUM(amount), 0)::int AS total_amount
      FROM deals
      GROUP BY stage
    `;
    const pipelineMap = {};
    pipelineRows.forEach(r => { pipelineMap[r.stage] = r.total_amount; });
    const pipeline_value = DEAL_STAGES.map(stage => ({ stage, total_amount: pipelineMap[stage] || 0 }));

    const trendRows = await sql`
      SELECT to_char(date_trunc('month', updated_at), 'YYYY-MM') AS month, stage, COUNT(*)::int AS count
      FROM deals
      WHERE stage IN ('won', 'lost') AND updated_at >= ${sinceDate}::date
      GROUP BY 1, 2
    `;
    const trendMap = {};
    trendRows.forEach(r => {
      if (!trendMap[r.month]) trendMap[r.month] = { won: 0, lost: 0 };
      trendMap[r.month][r.stage] = r.count;
    });
    const won_lost_trend = months.map(month => ({
      month,
      won: trendMap[month]?.won || 0,
      lost: trendMap[month]?.lost || 0,
    }));

    // 分類別内訳
    const classificationRows = await sql`
      SELECT classification, COUNT(*)::int AS count
      FROM responses
      GROUP BY classification
    `;
    const classification_breakdown = { interested: 0, question: 0, declined: 0, other: 0 };
    classificationRows.forEach(r => {
      const key = ["interested", "question", "declined"].includes(r.classification) ? r.classification : "other";
      classification_breakdown[key] += r.count;
    });

    // 送信〜返信までの平均日数
    const [{ avg_days }] = await sql`
      SELECT AVG(EXTRACT(EPOCH FROM (r.received_at - sl.sent_at)) / 86400.0) AS avg_days
      FROM responses r
      JOIN send_logs sl ON sl.id = r.send_log_id
    `;
    const response_time_avg_days = avg_days != null ? Math.round(Number(avg_days) * 10) / 10 : 0;

    // 曜日別反応率(送信日時基準、日本時間)
    const weekdayRows = await sql`
      SELECT
        EXTRACT(DOW FROM (sl.sent_at AT TIME ZONE 'Asia/Tokyo'))::int AS dow,
        COUNT(DISTINCT sl.id)::int                                    AS send_count,
        COUNT(DISTINCT r.id)::int                                     AS response_count
      FROM send_logs sl
      LEFT JOIN responses r ON r.send_log_id = sl.id
      GROUP BY 1
    `;
    const weekdayMap = {};
    weekdayRows.forEach(r => { weekdayMap[r.dow] = r; });
    const weekday_response_rate = WEEKDAY_LABELS.map((label, i) => {
      const dow = (i + 1) % 7; // index0(月)→dow1 … index6(日)→dow0
      const row = weekdayMap[dow];
      const send_count = row?.send_count || 0;
      const response_count = row?.response_count || 0;
      const rate = send_count > 0 ? Math.round((response_count / send_count) * 1000) / 10 : 0;
      return { weekday: label, send_count, response_count, rate };
    });

    // 時間帯別反応率(送信日時基準、日本時間)
    const hourRows = await sql`
      SELECT
        EXTRACT(HOUR FROM (sl.sent_at AT TIME ZONE 'Asia/Tokyo'))::int AS hour,
        COUNT(DISTINCT sl.id)::int                                     AS send_count,
        COUNT(DISTINCT r.id)::int                                      AS response_count
      FROM send_logs sl
      LEFT JOIN responses r ON r.send_log_id = sl.id
      GROUP BY 1
    `;
    const hour_response_rate = HOUR_BUCKETS.map(b => {
      let send_count = 0, response_count = 0;
      hourRows.forEach(r => {
        if (r.hour >= b.start && r.hour < b.end) {
          send_count += r.send_count;
          response_count += r.response_count;
        }
      });
      const rate = send_count > 0 ? Math.round((response_count / send_count) * 1000) / 10 : 0;
      return { hour_range: b.label, send_count, response_count, rate };
    });

    return res.status(200).json({
      monthly_sends,
      monthly_responses,
      channel_stats,
      variant_performance,
      pipeline_value,
      won_lost_trend,
      classification_breakdown,
      response_time_avg_days,
      weekday_response_rate,
      hour_response_rate,
    });
  } catch (err) {
    return res.status(500).json({ error: `DB取得エラー: ${err.message}` });
  }
}

// ==================== settings ====================

async function handleSettings(req, res) {
  if (req.method === "GET") {
    try {
      const rows = await sql`SELECT key, value FROM settings`;
      const settings = {};
      rows.forEach(r => { settings[r.key] = r.value; });
      return res.status(200).json(settings);
    } catch (err) {
      return res.status(500).json({ error: `DB取得エラー: ${err.message}` });
    }
  }

  if (req.method === "PATCH") {
    const { key, value } = req.body || {};
    if (!key || typeof key !== "string") {
      return res.status(400).json({ error: "keyが必要です" });
    }
    if (value === undefined || value === null) {
      return res.status(400).json({ error: "valueが必要です" });
    }
    try {
      const [updated] = await sql`
        INSERT INTO settings (key, value) VALUES (${key}, ${String(value)})
        ON CONFLICT (key) DO UPDATE SET value = ${String(value)}
        RETURNING *
      `;
      return res.status(200).json(updated);
    } catch (err) {
      return res.status(500).json({ error: `DB更新エラー: ${err.message}` });
    }
  }

  return res.status(405).json({ error: "GET / PATCH のみ対応しています" });
}

// ==================== ab-tests ====================

async function handleAbTests(req, res) {
  if (req.method === "GET") {
    try {
      const tests = await sql`
        SELECT t.*, va.name AS variant_a_name, vb.name AS variant_b_name
        FROM ab_tests t
        JOIN message_variants va ON va.id = t.variant_a_id
        JOIN message_variants vb ON vb.id = t.variant_b_id
        ORDER BY t.created_at DESC
      `;
      return res.status(200).json(tests);
    } catch (err) {
      return res.status(500).json({ error: `DB取得エラー: ${err.message}` });
    }
  }

  if (req.method === "POST") {
    const { name, variant_a_id, variant_b_id } = req.body || {};
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "name（文字列）が必要です" });
    }
    const variantAId = parseInt(variant_a_id, 10);
    const variantBId = parseInt(variant_b_id, 10);
    if (!variantAId || isNaN(variantAId) || !variantBId || isNaN(variantBId)) {
      return res.status(400).json({ error: "variant_a_id, variant_b_idが必要です" });
    }
    if (variantAId === variantBId) {
      return res.status(400).json({ error: "variant_a_idとvariant_b_idには異なるバリアントを指定してください" });
    }
    try {
      const [test] = await sql`
        INSERT INTO ab_tests (name, variant_a_id, variant_b_id)
        VALUES (${name.trim()}, ${variantAId}, ${variantBId})
        RETURNING *
      `;
      const [withNames] = await sql`
        SELECT t.*, va.name AS variant_a_name, vb.name AS variant_b_name
        FROM ab_tests t
        JOIN message_variants va ON va.id = t.variant_a_id
        JOIN message_variants vb ON vb.id = t.variant_b_id
        WHERE t.id = ${test.id}
      `;
      return res.status(201).json(withNames);
    } catch (err) {
      return res.status(500).json({ error: `DB登録エラー: ${err.message}` });
    }
  }

  return res.status(405).json({ error: "GET / POST のみ対応しています" });
}

async function handleAbTestStats(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "GETのみ対応しています" });
  }
  const testId = parseInt(req.query.id, 10);
  if (!testId || isNaN(testId)) {
    return res.status(400).json({ error: "有効なidが必要です" });
  }
  try {
    const [test] = await sql`SELECT * FROM ab_tests WHERE id = ${testId}`;
    if (!test) return res.status(404).json({ error: "A/Bテストが見つかりません" });

    async function variantStats(variantId) {
      const [row] = await sql`
        SELECT
          mv.name                                                           AS name,
          COUNT(DISTINCT sl.id)::int                                        AS send_count,
          COUNT(DISTINCT r.id)::int                                         AS response_count
        FROM message_variants mv
        LEFT JOIN send_logs sl ON sl.variant_id  = mv.id
        LEFT JOIN responses  r  ON r.send_log_id = sl.id
        WHERE mv.id = ${variantId}
        GROUP BY mv.name
      `;
      const sendCount = row?.send_count || 0;
      const responseCount = row?.response_count || 0;
      const responseRate = sendCount > 0 ? Math.round((responseCount / sendCount) * 1000) / 10 : 0;
      return { name: row?.name || "", send_count: sendCount, response_count: responseCount, response_rate: responseRate };
    }

    const variant_a = await variantStats(test.variant_a_id);
    const variant_b = await variantStats(test.variant_b_id);

    let winner = null;
    if (variant_a.send_count > 0 || variant_b.send_count > 0) {
      if (variant_a.response_rate > variant_b.response_rate) winner = test.variant_a_id;
      else if (variant_b.response_rate > variant_a.response_rate) winner = test.variant_b_id;
    }

    const diff = Math.abs(variant_a.response_rate - variant_b.response_rate);
    let confidence = "低";
    if (diff >= 5) confidence = "高";
    else if (diff >= 2) confidence = "中";

    return res.status(200).json({ variant_a, variant_b, winner, confidence });
  } catch (err) {
    return res.status(500).json({ error: `DB取得エラー: ${err.message}` });
  }
}

// ==================== api-usage ====================

const BRAVE_FREE_LIMIT = 1000;
const BRAVE_COST_PER_1000_JPY = 750;

// Text Search (New) 1回あたり約$0.032 ≒ 5円として概算
const GOOGLE_PLACES_COST_PER_CALL_JPY = 5;
const GOOGLE_PLACES_COST_PER_CALL_USD = 0.032;
const GOOGLE_PLACES_FREE_CREDIT_USD = 200;
const GOOGLE_PLACES_FREE_CALLS = Math.floor(GOOGLE_PLACES_FREE_CREDIT_USD / GOOGLE_PLACES_COST_PER_CALL_USD);

function braveEstimatedCostJpy(count) {
  if (count <= BRAVE_FREE_LIMIT) return 0;
  return Math.round(((count - BRAVE_FREE_LIMIT) / 1000) * BRAVE_COST_PER_1000_JPY);
}

function placesEstimatedCostJpy(count) {
  if (count <= GOOGLE_PLACES_FREE_CALLS) return 0;
  return Math.round((count - GOOGLE_PLACES_FREE_CALLS) * GOOGLE_PLACES_COST_PER_CALL_JPY);
}

function percentageOf(count, limit) {
  if (!limit) return 0;
  return Math.round((count / limit) * 100);
}

function daysUntilMonthEnd() {
  const now = new Date();
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return Math.ceil((nextMonth - now) / (1000 * 60 * 60 * 24));
}

async function handleApiUsage(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "GETのみ対応しています" });
  }
  try {
    const rows = await sql`
      SELECT provider, COUNT(*)::int AS count
      FROM api_usage_logs
      WHERE created_at >= date_trunc('month', NOW())
        AND created_at <  date_trunc('month', NOW()) + INTERVAL '1 month'
      GROUP BY provider
    `;
    const counts = {};
    rows.forEach(r => { counts[r.provider] = r.count; });

    const braveCount  = counts.brave_search  || 0;
    const placesCount = counts.google_places || 0;

    return res.status(200).json({
      brave_search: {
        count: braveCount,
        free_limit: BRAVE_FREE_LIMIT,
        estimated_cost_jpy: braveEstimatedCostJpy(braveCount),
        percentage: percentageOf(braveCount, BRAVE_FREE_LIMIT),
      },
      google_places: {
        count: placesCount,
        free_limit: null,
        estimated_cost_jpy: placesEstimatedCostJpy(placesCount),
        percentage: percentageOf(placesCount, GOOGLE_PLACES_FREE_CALLS),
      },
      days_until_reset: daysUntilMonthEnd(),
    });
  } catch (err) {
    return res.status(500).json({ error: `DB取得エラー: ${err.message}` });
  }
}

// ==================== attachments ====================

// Vercel Serverless Functionsのリクエストボディ上限(既定約4.5MB)を踏まえた実効値。
// Base64化すると元ファイルの約4/3に膨張するため、5MBの実ファイルはペイロードが
// 上限を超えてプラットフォーム側で拒否されてしまう。実際にアップロード可能な
// 範囲に収まるよう3MBに設定。
const ATTACHMENT_MAX_BYTES = 3 * 1024 * 1024; // 3MB

async function handleAttachments(req, res) {
  if (req.method === "GET") {
    try {
      const rows = await sql`
        SELECT id, filename, content_type, created_at, LENGTH(file_data) AS b64_length
        FROM attachments
        ORDER BY created_at DESC
      `;
      const attachments = rows.map(r => ({
        id: r.id,
        filename: r.filename,
        content_type: r.content_type,
        created_at: r.created_at,
        size_bytes: Math.floor((r.b64_length || 0) * 3 / 4),
      }));
      return res.status(200).json(attachments);
    } catch (err) {
      return res.status(500).json({ error: `DB取得エラー: ${err.message}` });
    }
  }

  if (req.method === "POST") {
    const { filename, content_type, file_data } = req.body || {};
    if (!filename || typeof filename !== "string" || !filename.trim()) {
      return res.status(400).json({ error: "filename（文字列）が必要です" });
    }
    if (!content_type || typeof content_type !== "string" || !content_type.trim()) {
      return res.status(400).json({ error: "content_type（文字列）が必要です" });
    }
    if (!file_data || typeof file_data !== "string") {
      return res.status(400).json({ error: "file_data（Base64文字列）が必要です" });
    }
    // Buffer.byteLengthはBase64のパディングを考慮した正確なデコード後サイズを返す
    // (文字数からの概算 length*3/4 はパディング境界で最大3バイトずれることがある)
    const sizeBytes = Buffer.byteLength(file_data, "base64");
    if (sizeBytes > ATTACHMENT_MAX_BYTES) {
      return res.status(400).json({ error: "ファイルサイズは3MB以下にしてください" });
    }
    try {
      const [created] = await sql`
        INSERT INTO attachments (filename, content_type, file_data)
        VALUES (${filename.trim()}, ${content_type.trim()}, ${file_data})
        RETURNING id, filename, content_type, created_at
      `;
      return res.status(201).json({ ...created, size_bytes: sizeBytes });
    } catch (err) {
      return res.status(500).json({ error: `DB登録エラー: ${err.message}` });
    }
  }

  if (req.method === "DELETE") {
    const { id } = req.body || {};
    const attachmentId = parseInt(id, 10);
    if (!attachmentId || isNaN(attachmentId)) {
      return res.status(400).json({ error: "有効なidが必要です" });
    }
    try {
      const [deleted] = await sql`DELETE FROM attachments WHERE id = ${attachmentId} RETURNING id`;
      if (!deleted) return res.status(404).json({ error: "添付ファイルが見つかりません" });
      return res.status(200).json({ deleted: true, id: deleted.id });
    } catch (err) {
      return res.status(500).json({ error: `DB削除エラー: ${err.message}` });
    }
  }

  return res.status(405).json({ error: "GET / POST / DELETE のみ対応しています" });
}

// ==================== company-clusters ====================

// company_tagsの中から "prefix:値" 形式のタグの値を取り出す(最初に見つかったもの)
function extractTagValue(tags, prefix) {
  const target = `${prefix}:`;
  const tag = tags.find(t => typeof t === "string" && t.startsWith(target));
  return tag ? tag.slice(target.length).trim() : null;
}

async function handleCompanyClusters(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "GETのみ対応しています" });
  }
  try {
    const companies = await sql`
      SELECT id, company_tags, priority, email, research_result
      FROM companies
      WHERE archived = FALSE
        AND company_tags IS NOT NULL
        AND jsonb_array_length(company_tags) > 0
    `;

    const groups = {};
    for (const c of companies) {
      const tags = Array.isArray(c.company_tags) ? c.company_tags : [];
      const industry = extractTagValue(tags, "業種");
      const region   = extractTagValue(tags, "地域");
      if (!industry || !region) continue;

      const key = `${industry} ${region}`;
      if (!groups[key]) {
        groups[key] = {
          industry, region,
          company_ids: [],
          automatable_count: 0,
          email_count: 0,
          priority_sum: 0,
        };
      }
      const g = groups[key];
      g.company_ids.push(c.id);
      if (c.research_result?.automatable === true) g.automatable_count++;
      if (c.email) g.email_count++;
      g.priority_sum += (c.priority || 0);
    }

    const clusters = Object.values(groups)
      .filter(g => g.company_ids.length >= 2)
      .map(g => ({
        industry: g.industry,
        region: g.region,
        company_count: g.company_ids.length,
        automatable_count: g.automatable_count,
        email_count: g.email_count,
        avg_priority: Math.round((g.priority_sum / g.company_ids.length) * 10) / 10,
        company_ids: g.company_ids,
      }))
      .sort((a, b) => b.company_count - a.company_count);

    return res.status(200).json({ clusters });
  } catch (err) {
    return res.status(500).json({ error: `DB取得エラー: ${err.message}` });
  }
}

// ==================== run-scheduled-sends ====================

// 現在時刻(JST)を0〜23の時間で返す。hourCycle: "h23"を明示しないと
// ICU実装によっては深夜0時が「24」として返ることがあるため固定する
function currentJstHour() {
  return Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo", hour: "numeric", hourCycle: "h23",
  }).format(new Date()));
}

// submit-form / send-email はVercel Functionハンドラー(req, res)として実装されているため、
// HTTPリクエストを発行せず同一プロセス内でハンドラーを直接呼び出すための簡易req/resを用意する
function createInternalRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

async function invokeHandlerInternally(handler, body) {
  const req = { method: "POST", body };
  const res = createInternalRes();
  await handler(req, res);
  return { ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: res.body };
}

async function handleRunScheduledSends(req, res) {
  try {
    const settings = await getSettings();
    const configuredHour = parseInt(settings.auto_send_hour, 10);
    const targetHour = Number.isFinite(configuredHour) ? configuredHour : 9;
    const nowHour = currentJstHour();

    // Vercel Cronは "0 9 * * *" 固定(1日1回)のため、設定時刻が9時以外の場合は
    // 実際には「次にcronが呼ばれた時」まで実行が持ち越される
    if (nowHour !== targetHour) {
      return res.status(200).json({
        processed: 0,
        success: 0,
        failed: 0,
        skipped: true,
        message: `設定された実行時刻(${targetHour}時)ではないため今回はスキップしました(現在${nowHour}時 JST)`,
      });
    }

    const due = await sql`
      SELECT * FROM scheduled_sends WHERE scheduled_at <= NOW() AND status = 'pending'
    `;

    let success = 0;
    let failed = 0;

    for (const item of due) {
      try {
        let result;
        if (item.channel === "email") {
          const [variant] = await sql`SELECT attachment_id FROM message_variants WHERE id = ${item.variant_id}`;
          result = await invokeHandlerInternally(sendEmailHandler, {
            company_id: item.company_id,
            variant_id: item.variant_id,
            attachment_id: variant?.attachment_id || null,
          });
        } else {
          result = await invokeHandlerInternally(submitFormHandler, {
            company_id: item.company_id,
            variant_id: item.variant_id,
          });
        }

        if (result.ok) {
          await sql`UPDATE scheduled_sends SET status = 'sent', error_message = NULL WHERE id = ${item.id}`;
          success++;
        } else {
          const errorMessage = result.body?.error || `HTTPステータス${result.status}`;
          await sql`UPDATE scheduled_sends SET status = 'failed', error_message = ${errorMessage} WHERE id = ${item.id}`;
          failed++;
        }
      } catch (err) {
        await sql`UPDATE scheduled_sends SET status = 'failed', error_message = ${err.message} WHERE id = ${item.id}`;
        failed++;
      }
    }

    return res.status(200).json({ processed: due.length, success, failed });
  } catch (err) {
    return res.status(500).json({ error: `実行エラー: ${err.message}` });
  }
}
