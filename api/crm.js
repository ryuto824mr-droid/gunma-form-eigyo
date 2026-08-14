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
const { generateMessageDraft, generateFollowUpMessage } = require("../lib/ai-message-generator");
const { generateReelsScript, generateSocialPost, generateInterviewQA } = require("../lib/content-generator");
const { parseWorkLogText } = require("../lib/work-log-parser");
const { summarizeMeeting, identifySpeakers } = require("../lib/meeting-summarizer");

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
    case "generate-message": return handleGenerateMessage(req, res);
    case "followup-suggestions": return handleFollowUpSuggestions(req, res);
    case "generate-followup": return handleGenerateFollowUp(req, res);
    case "generate-content": return handleGenerateContent(req, res);
    case "saved-content": return handleSavedContent(req, res);
    case "sender-accounts": return handleSenderAccounts(req, res);
    case "work-logs":        return handleWorkLogs(req, res);
    case "parse-work-log":  return handleParseWorkLog(req, res);
    case "meeting-notes":     return handleMeetingNotes(req, res);
    case "summarize-meeting": return handleSummarizeMeetingPreview(req, res);
    case "calendar-events":   return handleCalendarEvents(req, res);
    default:
      return res.status(400).json({ error: "有効なaction（db-setup, contacts, deals, activities, excluded-domains, tasks, pipeline-stats, reports, settings, ab-tests, ab-test-stats, api-usage, attachments, company-clusters, run-scheduled-sends, generate-message, followup-suggestions, generate-followup, generate-content, saved-content, sender-accounts, work-logs, parse-work-log, meeting-notes, summarize-meeting, calendar-events）を指定してください" });
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
        ('auto_send_hour', '9'),
        ('skip_weekends_holidays', 'true')
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
    // api_usage_logs.input_tokens / output_tokens追加（Anthropic API利用量の正確な集計用）
    await dbSql.query("ALTER TABLE api_usage_logs ADD COLUMN IF NOT EXISTS input_tokens INTEGER");
    await dbSql.query("ALTER TABLE api_usage_logs ADD COLUMN IF NOT EXISTS output_tokens INTEGER");
    // responses.candidate_datetime等追加（返信メールからの日程調整情報自動抽出用）
    await dbSql.query("ALTER TABLE responses ADD COLUMN IF NOT EXISTS candidate_datetime TEXT");
    await dbSql.query("ALTER TABLE responses ADD COLUMN IF NOT EXISTS location TEXT");
    await dbSql.query("ALTER TABLE responses ADD COLUMN IF NOT EXISTS contact_person TEXT");
    await dbSql.query("ALTER TABLE responses ADD COLUMN IF NOT EXISTS special_notes TEXT");
    // companies.project追加（LOCLE統合ツール拡張: 'ozukanzukan' / 'locle' を区別）
    await dbSql.query("ALTER TABLE companies ADD COLUMN IF NOT EXISTS project TEXT NOT NULL DEFAULT 'locle'");
    await dbSql.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'companies_project_check'
        ) THEN
          ALTER TABLE companies ADD CONSTRAINT companies_project_check CHECK (project IN ('ozukanzukan', 'locle'));
        END IF;
      END $$;
    `);
    // work_logsテーブル追加（勤怠・作業ログ管理用）
    await dbSql.query(`
      CREATE TABLE IF NOT EXISTS work_logs (
        id              SERIAL PRIMARY KEY,
        user_name       TEXT NOT NULL,
        date            DATE NOT NULL,
        clock_in        TIME,
        clock_out       TIME,
        work_hours      NUMERIC(5,2) GENERATED ALWAYS AS (
                           CASE
                             WHEN clock_in IS NOT NULL AND clock_out IS NOT NULL
                               THEN ROUND(EXTRACT(EPOCH FROM (clock_out - clock_in))::numeric / 3600, 2)
                             ELSE NULL
                           END
                         ) STORED,
        tasks_done      TEXT,
        tasks_remaining TEXT,
        memo            TEXT,
        project         TEXT NOT NULL DEFAULT 'locle'
                           CONSTRAINT work_logs_project_check CHECK (project IN ('ozukanzukan', 'locle')),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // message_variants.project追加（バリアントをLOCLE/群馬お仕事図鑑ごとに分離）
    await dbSql.query("ALTER TABLE message_variants ADD COLUMN IF NOT EXISTS project TEXT NOT NULL DEFAULT 'locle'");
    await dbSql.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'message_variants_project_check'
        ) THEN
          ALTER TABLE message_variants ADD CONSTRAINT message_variants_project_check CHECK (project IN ('ozukanzukan', 'locle'));
        END IF;
      END $$;
    `);
    // generated_contentテーブル追加（群馬お仕事図鑑向け台本・コンテンツ生成機能の保存用）
    await dbSql.query(`
      CREATE TABLE IF NOT EXISTS generated_content (
        id           SERIAL PRIMARY KEY,
        company_id   INTEGER NOT NULL REFERENCES companies(id),
        content_type TEXT NOT NULL,
        content_data JSONB NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // sender_accountsテーブル追加（複数Gmailアカウントからの送信切り替え機能用）
    await dbSql.query(`
      CREATE TABLE IF NOT EXISTS sender_accounts (
        id            SERIAL PRIMARY KEY,
        display_name  TEXT NOT NULL,
        email         TEXT NOT NULL UNIQUE,
        refresh_token TEXT NOT NULL,
        is_active     BOOLEAN NOT NULL DEFAULT TRUE,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // meeting_notesテーブル追加（議事録まとめ機能用。company_idに紐づかないためproject列で直接分離する）
    await dbSql.query(`
      CREATE TABLE IF NOT EXISTS meeting_notes (
        id           SERIAL PRIMARY KEY,
        project      TEXT NOT NULL DEFAULT 'locle'
                        CONSTRAINT meeting_notes_project_check CHECK (project IN ('ozukanzukan', 'locle')),
        title        TEXT NOT NULL,
        meeting_type TEXT NOT NULL DEFAULT 'other',
        raw_text     TEXT NOT NULL,
        summary      TEXT,
        todos        JSONB DEFAULT '[]',
        meeting_date DATE NOT NULL DEFAULT CURRENT_DATE,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // meeting_notes.labeled_text/speakers_detected追加（話者分離機能用）
    await dbSql.query("ALTER TABLE meeting_notes ADD COLUMN IF NOT EXISTS labeled_text TEXT");
    await dbSql.query("ALTER TABLE meeting_notes ADD COLUMN IF NOT EXISTS speakers_detected JSONB DEFAULT '[]'");
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
      const project = req.query.project;
      const hasProjectFilter = project === "locle" || project === "ozukanzukan";

      let contacts;
      if (companyId && hasProjectFilter) {
        contacts = await sql`
          SELECT ct.*, c.name AS company_name
          FROM contacts ct JOIN companies c ON c.id = ct.company_id
          WHERE ct.company_id = ${companyId} AND c.project = ${project}
          ORDER BY ct.created_at DESC
        `;
      } else if (companyId) {
        contacts = await sql`
          SELECT ct.*, c.name AS company_name
          FROM contacts ct JOIN companies c ON c.id = ct.company_id
          WHERE ct.company_id = ${companyId}
          ORDER BY ct.created_at DESC
        `;
      } else if (hasProjectFilter) {
        contacts = await sql`
          SELECT ct.*, c.name AS company_name
          FROM contacts ct JOIN companies c ON c.id = ct.company_id
          WHERE c.project = ${project}
          ORDER BY ct.created_at DESC
        `;
      } else {
        contacts = await sql`
          SELECT ct.*, c.name AS company_name
          FROM contacts ct JOIN companies c ON c.id = ct.company_id
          ORDER BY ct.created_at DESC
        `;
      }
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
      const project = req.query.project;
      const hasProjectFilter = project === "locle" || project === "ozukanzukan";

      let deals;
      if (companyId && hasProjectFilter) {
        deals = await sql`
          SELECT d.*, c.name AS company_name
          FROM deals d JOIN companies c ON c.id = d.company_id
          WHERE d.company_id = ${companyId} AND c.project = ${project}
          ORDER BY d.updated_at DESC
        `;
      } else if (companyId) {
        deals = await sql`
          SELECT d.*, c.name AS company_name
          FROM deals d JOIN companies c ON c.id = d.company_id
          WHERE d.company_id = ${companyId}
          ORDER BY d.updated_at DESC
        `;
      } else if (hasProjectFilter) {
        deals = await sql`
          SELECT d.*, c.name AS company_name
          FROM deals d JOIN companies c ON c.id = d.company_id
          WHERE c.project = ${project}
          ORDER BY d.updated_at DESC
        `;
      } else {
        deals = await sql`
          SELECT d.*, c.name AS company_name
          FROM deals d JOIN companies c ON c.id = d.company_id
          ORDER BY d.updated_at DESC
        `;
      }
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
      const project = req.query.project;
      const hasProjectFilter = project === "locle" || project === "ozukanzukan";

      let activities;
      if (companyId && hasProjectFilter) {
        activities = await sql`
          SELECT a.*, c.name AS company_name
          FROM activities a JOIN companies c ON c.id = a.company_id
          WHERE a.company_id = ${companyId} AND c.project = ${project}
          ORDER BY a.activity_at DESC
        `;
      } else if (companyId) {
        activities = await sql`
          SELECT a.*, c.name AS company_name
          FROM activities a JOIN companies c ON c.id = a.company_id
          WHERE a.company_id = ${companyId}
          ORDER BY a.activity_at DESC
        `;
      } else if (hasProjectFilter) {
        activities = await sql`
          SELECT a.*, c.name AS company_name
          FROM activities a JOIN companies c ON c.id = a.company_id
          WHERE c.project = ${project}
          ORDER BY a.activity_at DESC
        `;
      } else {
        activities = await sql`
          SELECT a.*, c.name AS company_name
          FROM activities a JOIN companies c ON c.id = a.company_id
          ORDER BY a.activity_at DESC
        `;
      }
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
      const project = req.query.project;
      const hasProjectFilter = project === "locle" || project === "ozukanzukan";

      // tasks.company_idはNULL許容(企業に紐付かない汎用タスク)のため、
      // project絞り込み時もcompany_idが無いタスクは常に表示対象に含める
      let tasks;
      if (includeDone && hasProjectFilter) {
        tasks = await sql`
          SELECT t.*, c.name AS company_name, d.title AS deal_title
          FROM tasks t
          LEFT JOIN companies c ON c.id = t.company_id
          LEFT JOIN deals d ON d.id = t.deal_id
          WHERE t.company_id IS NULL OR c.project = ${project}
          ORDER BY t.due_date ASC NULLS LAST, t.created_at DESC
        `;
      } else if (includeDone) {
        tasks = await sql`
          SELECT t.*, c.name AS company_name, d.title AS deal_title
          FROM tasks t
          LEFT JOIN companies c ON c.id = t.company_id
          LEFT JOIN deals d ON d.id = t.deal_id
          ORDER BY t.due_date ASC NULLS LAST, t.created_at DESC
        `;
      } else if (hasProjectFilter) {
        tasks = await sql`
          SELECT t.*, c.name AS company_name, d.title AS deal_title
          FROM tasks t
          LEFT JOIN companies c ON c.id = t.company_id
          LEFT JOIN deals d ON d.id = t.deal_id
          WHERE t.done = FALSE AND (t.company_id IS NULL OR c.project = ${project})
          ORDER BY t.due_date ASC NULLS LAST, t.created_at DESC
        `;
      } else {
        tasks = await sql`
          SELECT t.*, c.name AS company_name, d.title AS deal_title
          FROM tasks t
          LEFT JOIN companies c ON c.id = t.company_id
          LEFT JOIN deals d ON d.id = t.deal_id
          WHERE t.done = FALSE
          ORDER BY t.due_date ASC NULLS LAST, t.created_at DESC
        `;
      }
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
    const project = req.query.project;
    const hasProjectFilter = project === "locle" || project === "ozukanzukan";

    const stageRows = hasProjectFilter
      ? await sql`
          SELECT d.stage,
                 COUNT(*)::int AS deal_count,
                 COALESCE(SUM(d.amount), 0)::int AS total_amount,
                 COALESCE(AVG(d.amount), 0)::int AS avg_amount
          FROM deals d JOIN companies c ON c.id = d.company_id
          WHERE c.project = ${project}
          GROUP BY d.stage
        `
      : await sql`
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

    const [{ total_pipeline }] = hasProjectFilter
      ? await sql`
          SELECT COALESCE(SUM(d.amount), 0)::int AS total_pipeline
          FROM deals d JOIN companies c ON c.id = d.company_id
          WHERE d.stage NOT IN ('won', 'lost') AND c.project = ${project}
        `
      : await sql`
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
    const project = req.query.project;
    const hasProjectFilter = project === "locle" || project === "ozukanzukan";

    const sendRows = hasProjectFilter
      ? await sql`
          SELECT to_char(date_trunc('month', sl.sent_at), 'YYYY-MM') AS month, COUNT(*)::int AS count
          FROM send_logs sl JOIN companies c ON c.id = sl.company_id
          WHERE sl.sent_at >= ${sinceDate}::date AND c.project = ${project}
          GROUP BY 1
        `
      : await sql`
          SELECT to_char(date_trunc('month', sent_at), 'YYYY-MM') AS month, COUNT(*)::int AS count
          FROM send_logs
          WHERE sent_at >= ${sinceDate}::date
          GROUP BY 1
        `;
    const sendMap = {};
    sendRows.forEach(r => { sendMap[r.month] = r.count; });
    const monthly_sends = months.map(month => ({ month, count: sendMap[month] || 0 }));

    const responseRows = hasProjectFilter
      ? await sql`
          SELECT to_char(date_trunc('month', r.received_at), 'YYYY-MM') AS month, COUNT(*)::int AS count
          FROM responses r
          JOIN send_logs sl ON sl.id = r.send_log_id
          JOIN companies c  ON c.id  = sl.company_id
          WHERE r.received_at >= ${sinceDate}::date AND c.project = ${project}
          GROUP BY 1
        `
      : await sql`
          SELECT to_char(date_trunc('month', received_at), 'YYYY-MM') AS month, COUNT(*)::int AS count
          FROM responses
          WHERE received_at >= ${sinceDate}::date
          GROUP BY 1
        `;
    const responseMap = {};
    responseRows.forEach(r => { responseMap[r.month] = r.count; });
    const monthly_responses = months.map(month => ({ month, count: responseMap[month] || 0 }));

    const channelRows = hasProjectFilter
      ? await sql`
          SELECT sl.channel, COUNT(*)::int AS count
          FROM send_logs sl JOIN companies c ON c.id = sl.company_id
          WHERE c.project = ${project}
          GROUP BY sl.channel
        `
      : await sql`SELECT channel, COUNT(*)::int AS count FROM send_logs GROUP BY channel`;
    const channel_stats = { form: 0, email: 0 };
    channelRows.forEach(r => { channel_stats[r.channel] = r.count; });

    const variant_performance = hasProjectFilter
      ? await sql`
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
          LEFT JOIN send_logs sl ON sl.variant_id = mv.id
            AND sl.company_id IN (SELECT id FROM companies WHERE project = ${project})
          LEFT JOIN responses  r  ON r.send_log_id = sl.id
          WHERE mv.project = ${project}
          GROUP BY mv.id, mv.name
          ORDER BY send_count DESC, response_rate DESC
          LIMIT 5
        `
      : await sql`
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

    const pipelineRows = hasProjectFilter
      ? await sql`
          SELECT d.stage, COALESCE(SUM(d.amount), 0)::int AS total_amount
          FROM deals d JOIN companies c ON c.id = d.company_id
          WHERE c.project = ${project}
          GROUP BY d.stage
        `
      : await sql`
          SELECT stage, COALESCE(SUM(amount), 0)::int AS total_amount
          FROM deals
          GROUP BY stage
        `;
    const pipelineMap = {};
    pipelineRows.forEach(r => { pipelineMap[r.stage] = r.total_amount; });
    const pipeline_value = DEAL_STAGES.map(stage => ({ stage, total_amount: pipelineMap[stage] || 0 }));

    const trendRows = hasProjectFilter
      ? await sql`
          SELECT to_char(date_trunc('month', d.updated_at), 'YYYY-MM') AS month, d.stage, COUNT(*)::int AS count
          FROM deals d JOIN companies c ON c.id = d.company_id
          WHERE d.stage IN ('won', 'lost') AND d.updated_at >= ${sinceDate}::date AND c.project = ${project}
          GROUP BY 1, 2
        `
      : await sql`
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
    const classificationRows = hasProjectFilter
      ? await sql`
          SELECT r.classification, COUNT(*)::int AS count
          FROM responses r
          JOIN send_logs sl ON sl.id = r.send_log_id
          JOIN companies c  ON c.id  = sl.company_id
          WHERE c.project = ${project}
          GROUP BY r.classification
        `
      : await sql`
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
    const [{ avg_days }] = hasProjectFilter
      ? await sql`
          SELECT AVG(EXTRACT(EPOCH FROM (r.received_at - sl.sent_at)) / 86400.0) AS avg_days
          FROM responses r
          JOIN send_logs sl ON sl.id = r.send_log_id
          JOIN companies c  ON c.id  = sl.company_id
          WHERE c.project = ${project}
        `
      : await sql`
          SELECT AVG(EXTRACT(EPOCH FROM (r.received_at - sl.sent_at)) / 86400.0) AS avg_days
          FROM responses r
          JOIN send_logs sl ON sl.id = r.send_log_id
        `;
    const response_time_avg_days = avg_days != null ? Math.round(Number(avg_days) * 10) / 10 : 0;

    // 曜日別反応率(送信日時基準、日本時間)
    const weekdayRows = hasProjectFilter
      ? await sql`
          SELECT
            EXTRACT(DOW FROM (sl.sent_at AT TIME ZONE 'Asia/Tokyo'))::int AS dow,
            COUNT(DISTINCT sl.id)::int                                    AS send_count,
            COUNT(DISTINCT r.id)::int                                     AS response_count
          FROM send_logs sl
          JOIN companies c ON c.id = sl.company_id
          LEFT JOIN responses r ON r.send_log_id = sl.id
          WHERE c.project = ${project}
          GROUP BY 1
        `
      : await sql`
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
    const hourRows = hasProjectFilter
      ? await sql`
          SELECT
            EXTRACT(HOUR FROM (sl.sent_at AT TIME ZONE 'Asia/Tokyo'))::int AS hour,
            COUNT(DISTINCT sl.id)::int                                     AS send_count,
            COUNT(DISTINCT r.id)::int                                      AS response_count
          FROM send_logs sl
          JOIN companies c ON c.id = sl.company_id
          LEFT JOIN responses r ON r.send_log_id = sl.id
          WHERE c.project = ${project}
          GROUP BY 1
        `
      : await sql`
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
      const project = req.query.project;
      const hasProjectFilter = project === "locle" || project === "ozukanzukan";
      const tests = hasProjectFilter
        ? await sql`
            SELECT t.*, va.name AS variant_a_name, vb.name AS variant_b_name
            FROM ab_tests t
            JOIN message_variants va ON va.id = t.variant_a_id
            JOIN message_variants vb ON vb.id = t.variant_b_id
            WHERE va.project = ${project}
            ORDER BY t.created_at DESC
          `
        : await sql`
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
      const [variantA] = await sql`SELECT project FROM message_variants WHERE id = ${variantAId}`;
      const [variantB] = await sql`SELECT project FROM message_variants WHERE id = ${variantBId}`;
      if (!variantA || !variantB) {
        return res.status(400).json({ error: "指定されたバリアントが見つかりません" });
      }
      if (variantA.project !== variantB.project) {
        return res.status(400).json({ error: "variant_a_idとvariant_b_idは同じプロジェクトのバリアントを指定してください" });
      }

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

// Claude Sonnet 4.6(2026年時点、要確認): 入力$3/100万トークン、出力$15/100万トークン
const ANTHROPIC_INPUT_COST_PER_MTOK_USD = 3;
const ANTHROPIC_OUTPUT_COST_PER_MTOK_USD = 15;
// 為替レートの概算(円換算)
const USD_TO_JPY_RATE = 150;

function anthropicEstimatedCostJpy(inputTokens, outputTokens) {
  const costUsd =
    (inputTokens / 1000000) * ANTHROPIC_INPUT_COST_PER_MTOK_USD +
    (outputTokens / 1000000) * ANTHROPIC_OUTPUT_COST_PER_MTOK_USD;
  return Math.round(costUsd * USD_TO_JPY_RATE);
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
      SELECT
        provider,
        COUNT(*)::int AS count,
        COALESCE(SUM(input_tokens), 0)::int  AS input_tokens,
        COALESCE(SUM(output_tokens), 0)::int AS output_tokens
      FROM api_usage_logs
      WHERE created_at >= date_trunc('month', NOW())
        AND created_at <  date_trunc('month', NOW()) + INTERVAL '1 month'
      GROUP BY provider
    `;
    const counts = {};
    rows.forEach(r => { counts[r.provider] = r; });

    const braveCount     = counts.brave_search?.count  || 0;
    const placesCount    = counts.google_places?.count || 0;
    const anthropicCount = counts.anthropic?.count      || 0;
    const anthropicInputTokens  = counts.anthropic?.input_tokens  || 0;
    const anthropicOutputTokens = counts.anthropic?.output_tokens || 0;

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
      anthropic: {
        count: anthropicCount,
        input_tokens: anthropicInputTokens,
        output_tokens: anthropicOutputTokens,
        estimated_cost_jpy: anthropicEstimatedCostJpy(anthropicInputTokens, anthropicOutputTokens),
        note: "実際のトークン数に基づく計算値です。為替レートにより多少前後します",
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
    const project = req.query.project;
    const hasProjectFilter = project === "locle" || project === "ozukanzukan";

    const companies = hasProjectFilter
      ? await sql`
          SELECT id, company_tags, priority, email, research_result
          FROM companies
          WHERE archived = FALSE
            AND company_tags IS NOT NULL
            AND jsonb_array_length(company_tags) > 0
            AND project = ${project}
        `
      : await sql`
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

// 日本の祝日判定用（2026年分をハードコード）。
// 内閣府の祝日CSVを毎回取得するのは重いため、簡易的にハードコードで対応する。
// 年が変わったら更新が必要（振替休日・国民の休日を含む）。
const JAPAN_HOLIDAYS_2026 = new Set([
  "2026-01-01", // 元日
  "2026-01-12", // 成人の日
  "2026-02-11", // 建国記念の日
  "2026-02-23", // 天皇誕生日
  "2026-03-20", // 春分の日
  "2026-04-29", // 昭和の日
  "2026-05-03", // 憲法記念日
  "2026-05-04", // みどりの日
  "2026-05-05", // こどもの日
  "2026-05-06", // 振替休日（憲法記念日が日曜のため）
  "2026-07-20", // 海の日
  "2026-08-11", // 山の日
  "2026-09-21", // 敬老の日
  "2026-09-22", // 国民の休日（敬老の日と秋分の日に挟まれた平日）
  "2026-09-23", // 秋分の日
  "2026-10-12", // スポーツの日
  "2026-11-03", // 文化の日
  "2026-11-23", // 勤労感謝の日
]);

function isJapaneseHoliday(dateStr) {
  return JAPAN_HOLIDAYS_2026.has(dateStr);
}

// 現在時刻(JST)を0〜23の時間で返す。hourCycle: "h23"を明示しないと
// ICU実装によっては深夜0時が「24」として返ることがあるため固定する
function currentJstHour() {
  return Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo", hour: "numeric", hourCycle: "h23",
  }).format(new Date()));
}

// 現在の日付(JST)を "YYYY-MM-DD" 形式で返す
function currentJstDateString() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

// 現在の曜日(JST)を 0(日)〜6(土) で返す。
// JSTの暦日そのものの曜日を得たいので、"YYYY-MM-DD"をUTC日付として解釈して
// getUTCDay()を使う（タイムゾーン変換によるズレを避けるため）
function currentJstWeekday() {
  return new Date(`${currentJstDateString()}T00:00:00Z`).getUTCDay();
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

    // 土日祝日は自動送信をスキップする設定（デフォルトON）
    const skipWeekendsHolidays = settings.skip_weekends_holidays !== "false";
    if (skipWeekendsHolidays) {
      const weekday = currentJstWeekday(); // 0=日, 6=土
      if (weekday === 0 || weekday === 6) {
        return res.status(200).json({
          processed: 0, success: 0, failed: 0,
          skipped: true, reason: "土日",
        });
      }
      if (isJapaneseHoliday(currentJstDateString())) {
        return res.status(200).json({
          processed: 0, success: 0, failed: 0,
          skipped: true, reason: "祝日",
        });
      }
    }

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

// ==================== generate-message ====================

async function handleGenerateMessage(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POSTメソッドのみ対応しています" });
  }

  const { company_id, tone, length } = req.body || {};

  let company = null;
  if (company_id) {
    const companyId = parseInt(company_id, 10);
    if (!companyId || isNaN(companyId)) {
      return res.status(400).json({ error: "有効なcompany_idを指定してください" });
    }
    try {
      [company] = await sql`SELECT name, company_info, company_tags FROM companies WHERE id = ${companyId}`;
    } catch (err) {
      return res.status(500).json({ error: `DB取得エラー: ${err.message}` });
    }
    if (!company) return res.status(404).json({ error: "企業が見つかりません" });
  }

  const industry = company?.company_tags
    ? extractTagValue(Array.isArray(company.company_tags) ? company.company_tags : [], "業種")
    : null;

  try {
    const result = await generateMessageDraft({
      companyName: company?.name,
      companyInfo: company?.company_info,
      industry,
      tone,
      length,
    });

    if (result.configured === false) {
      return res.status(400).json({ error: "AI機能が設定されていません" });
    }

    return res.status(200).json({ subject: result.subject, body: result.body });
  } catch (err) {
    return res.status(500).json({ error: `AI文面生成エラー: ${err.message}` });
  }
}

// ==================== followup-suggestions ====================
//
// 「送信したのに返信が無い」企業を抽出する。対象条件:
// - status='sent'の送信履歴がある
// - その企業への「最後の」sent送信から3日以上経過している
// - その企業のsend_logsに紐づくresponsesが一件も無い(企業単位での未返信判定。
//   複数回送信していて過去の送信には反応があった企業は、既に一度接点が持てている
//   とみなして対象から除外する)
// - action_statusが'closed'/'rejected'でない(既に対応済み・お断りは除外)

async function handleFollowUpSuggestions(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "GETのみ対応しています" });
  }
  const project = req.query.project;
  if (project !== "locle" && project !== "ozukanzukan") {
    return res.status(400).json({ error: "有効なproject（locle または ozukanzukan）を指定してください" });
  }
  try {
    const rows = await sql`
      SELECT
        c.id             AS company_id,
        c.name           AS company_name,
        last_send.sent_at AS last_sent_at,
        FLOOR(EXTRACT(EPOCH FROM (NOW() - last_send.sent_at)) / 86400)::int AS days_since,
        mv.name          AS last_variant_name,
        mv.id            AS last_variant_id,
        mv.channel       AS last_variant_channel
      FROM companies c
      JOIN LATERAL (
        SELECT sl.id, sl.sent_at, sl.variant_id
        FROM send_logs sl
        WHERE sl.company_id = c.id AND sl.status = 'sent'
        ORDER BY sl.sent_at DESC
        LIMIT 1
      ) last_send ON TRUE
      JOIN message_variants mv ON mv.id = last_send.variant_id
      WHERE c.project = ${project}
        AND COALESCE(c.action_status, 'none') NOT IN ('closed', 'rejected')
        AND last_send.sent_at <= NOW() - INTERVAL '3 days'
        AND NOT EXISTS (
          SELECT 1 FROM responses r
          JOIN send_logs sl3 ON sl3.id = r.send_log_id
          WHERE sl3.company_id = c.id
        )
      ORDER BY last_send.sent_at ASC
    `;
    return res.status(200).json(rows);
  } catch (err) {
    return res.status(500).json({ error: `DB取得エラー: ${err.message}` });
  }
}

// ==================== generate-followup ====================

async function handleGenerateFollowUp(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POSTメソッドのみ対応しています" });
  }

  const { company_id } = req.body || {};
  const companyId = parseInt(company_id, 10);
  if (!companyId || isNaN(companyId)) {
    return res.status(400).json({ error: "有効なcompany_idを指定してください" });
  }

  try {
    const [company] = await sql`SELECT name FROM companies WHERE id = ${companyId}`;
    if (!company) return res.status(404).json({ error: "企業が見つかりません" });

    const [lastSend] = await sql`
      SELECT sl.sent_at, mv.subject_template
      FROM send_logs sl
      JOIN message_variants mv ON mv.id = sl.variant_id
      WHERE sl.company_id = ${companyId} AND sl.status = 'sent'
      ORDER BY sl.sent_at DESC
      LIMIT 1
    `;
    if (!lastSend) {
      return res.status(404).json({ error: "この企業への送信履歴が見つかりません" });
    }

    const daysSinceContact = Math.floor((Date.now() - new Date(lastSend.sent_at).getTime()) / 86400000);
    const originalSubject = (lastSend.subject_template || "").replace(/\{\{company_name\}\}/g, company.name);

    const result = await generateFollowUpMessage({
      companyName: company.name,
      originalSubject,
      daysSinceContact,
    });

    if (result.configured === false) {
      return res.status(400).json({ error: "AI機能が設定されていません" });
    }

    return res.status(200).json({ subject: result.subject, body: result.body });
  } catch (err) {
    return res.status(500).json({ error: `AIフォローアップ文面生成エラー: ${err.message}` });
  }
}

// ==================== generate-content ====================

const CONTENT_TYPES = ["reels_script", "social_post", "interview_qa"];

async function handleGenerateContent(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POSTメソッドのみ対応しています" });
  }

  const { company_id, content_type, params } = req.body || {};
  const companyId = parseInt(company_id, 10);
  if (!companyId || isNaN(companyId)) {
    return res.status(400).json({ error: "有効なcompany_idを指定してください" });
  }
  if (!CONTENT_TYPES.includes(content_type)) {
    return res.status(400).json({ error: "有効なcontent_type（reels_script, social_post, interview_qa）を指定してください" });
  }

  try {
    const [company] = await sql`SELECT name, company_info, project FROM companies WHERE id = ${companyId}`;
    if (!company) return res.status(404).json({ error: "企業が見つかりません" });
    if (company.project !== "ozukanzukan") {
      return res.status(400).json({ error: "この機能は「群馬お仕事図鑑」の企業でのみ利用できます" });
    }

    const p = params && typeof params === "object" ? params : {};
    let result;
    if (content_type === "reels_script") {
      result = await generateReelsScript({ companyName: company.name, companyInfo: company.company_info, theme: p.theme });
    } else if (content_type === "social_post") {
      result = await generateSocialPost({ companyName: company.name, companyInfo: company.company_info, platform: p.platform, tone: p.tone });
    } else {
      result = await generateInterviewQA({ companyName: company.name, companyInfo: company.company_info, focusArea: p.focus_area });
    }

    if (result.configured === false) {
      return res.status(400).json({ error: "AI機能が設定されていません" });
    }

    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: `AIコンテンツ生成エラー: ${err.message}` });
  }
}

// ==================== saved-content ====================

async function handleSavedContent(req, res) {
  if (req.method === "GET") {
    const companyId = parseInt(req.query.company_id, 10);
    if (!companyId || isNaN(companyId)) {
      return res.status(400).json({ error: "有効なcompany_idが必要です" });
    }
    try {
      const rows = await sql`
        SELECT gc.*, c.name AS company_name
        FROM generated_content gc
        JOIN companies c ON c.id = gc.company_id
        WHERE gc.company_id = ${companyId}
        ORDER BY gc.created_at DESC
      `;
      return res.status(200).json(rows);
    } catch (err) {
      return res.status(500).json({ error: `DB取得エラー: ${err.message}` });
    }
  }

  if (req.method === "POST") {
    const { company_id, content_type, content_data } = req.body || {};
    const companyId = parseInt(company_id, 10);
    if (!companyId || isNaN(companyId)) {
      return res.status(400).json({ error: "有効なcompany_idが必要です" });
    }
    if (!CONTENT_TYPES.includes(content_type)) {
      return res.status(400).json({ error: "有効なcontent_type（reels_script, social_post, interview_qa）を指定してください" });
    }
    if (!content_data || typeof content_data !== "object") {
      return res.status(400).json({ error: "content_data（オブジェクト）が必要です" });
    }
    try {
      const [company] = await sql`SELECT project FROM companies WHERE id = ${companyId}`;
      if (!company) return res.status(404).json({ error: "企業が見つかりません" });
      if (company.project !== "ozukanzukan") {
        return res.status(400).json({ error: "この機能は「群馬お仕事図鑑」の企業でのみ利用できます" });
      }

      const [created] = await sql`
        INSERT INTO generated_content (company_id, content_type, content_data)
        VALUES (${companyId}, ${content_type}, ${JSON.stringify(content_data)})
        RETURNING *
      `;
      return res.status(201).json(created);
    } catch (err) {
      return res.status(500).json({ error: `DB登録エラー: ${err.message}` });
    }
  }

  if (req.method === "DELETE") {
    const { id } = req.body || {};
    const contentId = parseInt(id, 10);
    if (!contentId || isNaN(contentId)) {
      return res.status(400).json({ error: "有効なidが必要です" });
    }
    try {
      const [deleted] = await sql`DELETE FROM generated_content WHERE id = ${contentId} RETURNING id`;
      if (!deleted) return res.status(404).json({ error: "コンテンツが見つかりません" });
      return res.status(200).json({ deleted: true, id: deleted.id });
    } catch (err) {
      return res.status(500).json({ error: `DB削除エラー: ${err.message}` });
    }
  }

  return res.status(405).json({ error: "GET / POST / DELETE のみ対応しています" });
}

// ==================== sender-accounts ====================
//
// 複数Gmailアカウントからの送信切り替え機能用。refresh_tokenは機密情報のため
// GET一覧には含めない(id/display_name/email/is_active/created_atのみ返す)。

async function handleSenderAccounts(req, res) {
  if (req.method === "GET") {
    try {
      const rows = await sql`
        SELECT id, display_name, email, is_active, created_at
        FROM sender_accounts
        ORDER BY created_at ASC
      `;
      return res.status(200).json(rows);
    } catch (err) {
      return res.status(500).json({ error: `DB取得エラー: ${err.message}` });
    }
  }

  if (req.method === "POST") {
    const { display_name, email, refresh_token } = req.body || {};
    if (!display_name || typeof display_name !== "string" || !display_name.trim()) {
      return res.status(400).json({ error: "display_name（文字列）が必要です" });
    }
    if (!email || typeof email !== "string" || !email.trim()) {
      return res.status(400).json({ error: "email（文字列）が必要です" });
    }
    if (!refresh_token || typeof refresh_token !== "string" || !refresh_token.trim()) {
      return res.status(400).json({ error: "refresh_token（文字列）が必要です" });
    }
    try {
      const [created] = await sql`
        INSERT INTO sender_accounts (display_name, email, refresh_token)
        VALUES (${display_name.trim()}, ${email.trim()}, ${refresh_token.trim()})
        RETURNING id, display_name, email, is_active, created_at
      `;
      return res.status(201).json(created);
    } catch (err) {
      if (err.message?.includes("duplicate key")) {
        return res.status(409).json({ error: "このメールアドレスは既に登録されています" });
      }
      return res.status(500).json({ error: `DB登録エラー: ${err.message}` });
    }
  }

  if (req.method === "PATCH") {
    const { id, is_active } = req.body || {};
    const accountId = parseInt(id, 10);
    if (!accountId || isNaN(accountId)) {
      return res.status(400).json({ error: "有効なidが必要です" });
    }
    if (is_active === undefined) {
      return res.status(400).json({ error: "is_activeが必要です" });
    }
    try {
      const [updated] = await sql`
        UPDATE sender_accounts SET is_active = ${!!is_active} WHERE id = ${accountId}
        RETURNING id, display_name, email, is_active, created_at
      `;
      if (!updated) return res.status(404).json({ error: "送信者アカウントが見つかりません" });
      return res.status(200).json(updated);
    } catch (err) {
      return res.status(500).json({ error: `DB更新エラー: ${err.message}` });
    }
  }

  if (req.method === "DELETE") {
    const { id } = req.body || {};
    const accountId = parseInt(id, 10);
    if (!accountId || isNaN(accountId)) {
      return res.status(400).json({ error: "有効なidが必要です" });
    }
    try {
      const [deleted] = await sql`DELETE FROM sender_accounts WHERE id = ${accountId} RETURNING id`;
      if (!deleted) return res.status(404).json({ error: "送信者アカウントが見つかりません" });
      return res.status(200).json({ deleted: true, id: deleted.id });
    } catch (err) {
      return res.status(500).json({ error: `DB削除エラー: ${err.message}` });
    }
  }

  return res.status(405).json({ error: "GET / POST / PATCH / DELETE のみ対応しています" });
}

// ==================== work-logs (稼働時間管理: プロジェクト非依存) ====================
// work_logs.work_hoursはDB側のGENERATEDカラム(clock_in/clock_outから自動計算)のため、
// INSERT/UPDATEでは明示的に指定しない(指定するとPostgresがエラーを返す)。

function todayJst() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
}

async function handleWorkLogs(req, res) {
  if (req.method === "GET") {
    try {
      const userName = req.query.user_name;

      if (userName) {
        // 期間指定: ユーザーごとの履歴(月次集計用)
        const from = req.query.from || `${todayJst().slice(0, 7)}-01`;
        const to   = req.query.to   || todayJst();
        const logs = await sql`
          SELECT * FROM work_logs
          WHERE user_name = ${userName} AND date >= ${from} AND date <= ${to}
          ORDER BY date ASC
        `;
        const totalHours = logs.reduce((sum, l) => sum + (l.work_hours != null ? Number(l.work_hours) : 0), 0);
        return res.status(200).json({ logs, total_hours: Math.round(totalHours * 100) / 100 });
      }

      // 日付指定: その日の全ユーザー分
      const date = req.query.date || todayJst();
      const logs = await sql`SELECT * FROM work_logs WHERE date = ${date} ORDER BY user_name ASC`;
      return res.status(200).json(logs);
    } catch (err) {
      return res.status(500).json({ error: `DB取得エラー: ${err.message}` });
    }
  }

  if (req.method === "POST") {
    const { user_name, date, clock_in, clock_out, tasks_done, tasks_remaining, memo, project } = req.body || {};
    if (!user_name || typeof user_name !== "string" || !user_name.trim()) {
      return res.status(400).json({ error: "user_name（文字列）が必要です" });
    }
    if (!date || isNaN(Date.parse(date))) {
      return res.status(400).json({ error: "有効なdateが必要です" });
    }
    const name = user_name.trim();
    const hasProject = project === "locle" || project === "ozukanzukan";

    try {
      const [existing] = await sql`SELECT * FROM work_logs WHERE user_name = ${name} AND date = ${date}`;

      let row;
      if (existing) {
        // POSTでも一部フィールドのみ送られてきた場合(未送信のキーはundefined)は既存値を維持し、
        // 先に保存済みのclock_in等が後続のPOSTでnull上書きされないようにする(PATCHと同じマージ方式)
        const newClockIn        = clock_in        !== undefined ? (clock_in || null)        : existing.clock_in;
        const newClockOut       = clock_out       !== undefined ? (clock_out || null)       : existing.clock_out;
        const newTasksDone      = tasks_done      !== undefined ? (tasks_done || null)      : existing.tasks_done;
        const newTasksRemaining = tasks_remaining !== undefined ? (tasks_remaining || null) : existing.tasks_remaining;
        const newMemo           = memo            !== undefined ? (memo || null)            : existing.memo;

        [row] = hasProject
          ? await sql`
              UPDATE work_logs
              SET clock_in = ${newClockIn}, clock_out = ${newClockOut},
                  tasks_done = ${newTasksDone}, tasks_remaining = ${newTasksRemaining},
                  memo = ${newMemo}, project = ${project}
              WHERE id = ${existing.id}
              RETURNING *
            `
          : await sql`
              UPDATE work_logs
              SET clock_in = ${newClockIn}, clock_out = ${newClockOut},
                  tasks_done = ${newTasksDone}, tasks_remaining = ${newTasksRemaining},
                  memo = ${newMemo}
              WHERE id = ${existing.id}
              RETURNING *
            `;
      } else {
        [row] = hasProject
          ? await sql`
              INSERT INTO work_logs (user_name, date, clock_in, clock_out, tasks_done, tasks_remaining, memo, project)
              VALUES (${name}, ${date}, ${clock_in || null}, ${clock_out || null}, ${tasks_done || null}, ${tasks_remaining || null}, ${memo || null}, ${project})
              RETURNING *
            `
          : await sql`
              INSERT INTO work_logs (user_name, date, clock_in, clock_out, tasks_done, tasks_remaining, memo)
              VALUES (${name}, ${date}, ${clock_in || null}, ${clock_out || null}, ${tasks_done || null}, ${tasks_remaining || null}, ${memo || null})
              RETURNING *
            `;
      }
      return res.status(existing ? 200 : 201).json(row);
    } catch (err) {
      return res.status(500).json({ error: `DB登録エラー: ${err.message}` });
    }
  }

  if (req.method === "PATCH") {
    const { id, clock_in, clock_out, tasks_done, tasks_remaining, memo } = req.body || {};
    const logId = parseInt(id, 10);
    if (!logId || isNaN(logId)) {
      return res.status(400).json({ error: "有効なidが必要です" });
    }
    try {
      const [current] = await sql`SELECT * FROM work_logs WHERE id = ${logId}`;
      if (!current) return res.status(404).json({ error: "レコードが見つかりません" });

      const newClockIn        = clock_in        !== undefined ? (clock_in || null)        : current.clock_in;
      const newClockOut       = clock_out       !== undefined ? (clock_out || null)       : current.clock_out;
      const newTasksDone      = tasks_done      !== undefined ? (tasks_done || null)      : current.tasks_done;
      const newTasksRemaining = tasks_remaining !== undefined ? (tasks_remaining || null) : current.tasks_remaining;
      const newMemo           = memo            !== undefined ? (memo || null)            : current.memo;

      const [updated] = await sql`
        UPDATE work_logs
        SET clock_in = ${newClockIn}, clock_out = ${newClockOut},
            tasks_done = ${newTasksDone}, tasks_remaining = ${newTasksRemaining}, memo = ${newMemo}
        WHERE id = ${logId}
        RETURNING *
      `;
      return res.status(200).json(updated);
    } catch (err) {
      return res.status(500).json({ error: `DB更新エラー: ${err.message}` });
    }
  }

  return res.status(405).json({ error: "GET / POST / PATCHのみ対応しています" });
}

// ==================== parse-work-log (稼働ログのAIチャット解析) ====================

async function handleParseWorkLog(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POSTメソッドのみ対応しています" });
  }
  const { text, existing_tasks_done, existing_tasks_remaining } = req.body || {};
  if (!text || typeof text !== "string" || !text.trim()) {
    return res.status(400).json({ error: "text（文字列）が必要です" });
  }
  try {
    const result = await parseWorkLogText({
      text,
      existingTasksDone: existing_tasks_done,
      existingTasksRemaining: existing_tasks_remaining,
    });
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: `解析エラー: ${err.message}` });
  }
}

// ==================== meeting-notes (議事録まとめ: プロジェクトごとに完全分離) ====================

const MEETING_TYPES = ["1on1", "全体定例", "other"];

// meeting_notes.meeting_dateはPostgresのDATE型だが、neonドライバはTIMESTAMP等と同じ
// パーサーで処理するためJSのDateオブジェクトとして返る(文字列ではない)。ここで比較や
// キーとして"YYYY-MM-DD"文字列が必要な箇所は、必ずこの関数を通して復元してから使う。
// toISOString()等のUTC変換は使わない: DATE型は時刻情報を持たずローカル深夜0時として
// 構築されるため、UTCとローカルのタイムゾーンが異なる環境では日付が1日ズレてしまう。
// ドライバ自身がローカルタイムでDateオブジェクトを構築しているため、取り出す側も
// getFullYear()/getMonth()/getDate()というローカルgetterを使えば、実行環境の
// タイムゾーンに関わらず往復で元の日付と一致する。
function toDateKey(value) {
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return value; // 既に文字列の場合はそのまま返す
}

// プレビュー用: 保存はせず、要約・Todo抽出結果だけを返す
// (public/meeting-notes.htmlの「要約してAIでTodo抽出」ボタンから呼ばれる)
async function handleSummarizeMeetingPreview(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POSTメソッドのみ対応しています" });
  }
  const { raw_text, meeting_type } = req.body || {};
  if (!raw_text || typeof raw_text !== "string" || !raw_text.trim()) {
    return res.status(400).json({ error: "raw_text（文字列）が必要です" });
  }
  try {
    const result = await summarizeMeeting({ rawText: raw_text, meetingType: meeting_type });
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: `要約エラー: ${err.message}` });
  }
}

async function handleMeetingNotes(req, res) {
  if (req.method === "GET") {
    const project = req.query.project;
    if (project !== "locle" && project !== "ozukanzukan") {
      return res.status(400).json({ error: "有効なproject（locleまたはozukanzukan）が必要です" });
    }
    try {
      let notes = await sql`
        SELECT * FROM meeting_notes WHERE project = ${project} ORDER BY created_at DESC
      `;
      notes = notes.map(n => ({ ...n, meeting_date: toDateKey(n.meeting_date) }));
      const { from, to, meeting_type } = req.query;
      if (from) notes = notes.filter(n => n.meeting_date >= from);
      if (to) notes = notes.filter(n => n.meeting_date <= to);
      if (meeting_type) notes = notes.filter(n => n.meeting_type === meeting_type);
      return res.status(200).json(notes);
    } catch (err) {
      return res.status(500).json({ error: `DB取得エラー: ${err.message}` });
    }
  }

  if (req.method === "POST") {
    const { project, title, meeting_type, raw_text, meeting_date, summary: preSummary, todos: preTodos } = req.body || {};
    if (project !== "locle" && project !== "ozukanzukan") {
      return res.status(400).json({ error: "有効なproject（locleまたはozukanzukan）が必要です" });
    }
    if (!title || typeof title !== "string" || !title.trim()) {
      return res.status(400).json({ error: "title（文字列）が必要です" });
    }
    if (!raw_text || typeof raw_text !== "string" || !raw_text.trim()) {
      return res.status(400).json({ error: "raw_text（文字列）が必要です" });
    }
    const type = MEETING_TYPES.includes(meeting_type) ? meeting_type : "other";
    const date = meeting_date || todayJst();

    // 事前にプレビュー(?action=summarize-meeting)で生成済みのsummary/todosがあればそれをそのまま使い、
    // 無ければここで要約する(AI未設定/失敗時はsummary=null, todos=[]のまま保存し、後からPATCHで手動編集できるようにする)。
    // 話者分離(identifySpeakers)はプレビューの仕組みが無いため常にここで並行実行する。
    const summaryPromise = (preSummary !== undefined || preTodos !== undefined)
      ? Promise.resolve({
          summary: typeof preSummary === "string" ? preSummary : null,
          todosRaw: Array.isArray(preTodos) ? preTodos.filter(t => typeof t === "string") : [],
        })
      : summarizeMeeting({ rawText: raw_text, meetingType: type })
          .then(result => (result.configured === false
            ? { summary: null, todosRaw: [] }
            : { summary: result.summary, todosRaw: result.todos }))
          .catch(() => ({ summary: null, todosRaw: [] })); // AI要約に失敗しても議事録自体の保存は継続する

    const speakersPromise = identifySpeakers({ rawText: raw_text })
      .then(result => (result.configured === false
        ? { labeledText: null, speakersDetected: [] }
        : { labeledText: result.labeled_text, speakersDetected: result.speakers_detected }))
      .catch(() => ({ labeledText: null, speakersDetected: [] })); // 話者分離に失敗しても議事録自体の保存は継続する

    const [{ summary, todosRaw }, { labeledText, speakersDetected }] =
      await Promise.all([summaryPromise, speakersPromise]);

    const todos = todosRaw.map(t => ({ text: t, done: false, due_date: null }));

    try {
      const [created] = await sql`
        INSERT INTO meeting_notes (project, title, meeting_type, raw_text, summary, todos, meeting_date, labeled_text, speakers_detected)
        VALUES (${project}, ${title.trim()}, ${type}, ${raw_text.trim()}, ${summary}, ${JSON.stringify(todos)}, ${date}, ${labeledText}, ${JSON.stringify(speakersDetected)})
        RETURNING *
      `;
      return res.status(201).json({ ...created, meeting_date: toDateKey(created.meeting_date) });
    } catch (err) {
      return res.status(500).json({ error: `DB登録エラー: ${err.message}` });
    }
  }

  if (req.method === "PATCH") {
    const { id, summary, todos, title } = req.body || {};
    const noteId = parseInt(id, 10);
    if (!noteId || isNaN(noteId)) {
      return res.status(400).json({ error: "有効なidが必要です" });
    }
    try {
      const [current] = await sql`SELECT * FROM meeting_notes WHERE id = ${noteId}`;
      if (!current) return res.status(404).json({ error: "議事録が見つかりません" });

      const newTitle   = title   !== undefined ? title   : current.title;
      const newSummary = summary !== undefined ? summary : current.summary;
      const newTodos   = todos   !== undefined ? JSON.stringify(todos) : JSON.stringify(current.todos);

      const [updated] = await sql`
        UPDATE meeting_notes
        SET title = ${newTitle}, summary = ${newSummary}, todos = ${newTodos}
        WHERE id = ${noteId}
        RETURNING *
      `;
      return res.status(200).json({ ...updated, meeting_date: toDateKey(updated.meeting_date) });
    } catch (err) {
      return res.status(500).json({ error: `DB更新エラー: ${err.message}` });
    }
  }

  if (req.method === "DELETE") {
    const { id } = req.body || {};
    const noteId = parseInt(id, 10);
    if (!noteId || isNaN(noteId)) {
      return res.status(400).json({ error: "有効なidが必要です" });
    }
    try {
      const [deleted] = await sql`DELETE FROM meeting_notes WHERE id = ${noteId} RETURNING id`;
      if (!deleted) return res.status(404).json({ error: "議事録が見つかりません" });
      return res.status(200).json({ deleted: true, id: deleted.id });
    } catch (err) {
      return res.status(500).json({ error: `DB削除エラー: ${err.message}` });
    }
  }

  return res.status(405).json({ error: "GET / POST / PATCH / DELETE のみ対応しています" });
}

// ==================== calendar-events (議事録カレンダー: 月単位でmeeting_notes/todosを日付ごとに集計) ====================

// 指定プロジェクトの議事録・Todoを日付ごとに集計する(calendar.html/meeting-notes.html共通で使用)。
// todosの期日はmeeting_dateとは別月にまたがりうるため、project全体を取得したうえで
// JS側で「開催日が対象月」「Todo期日が対象月」をそれぞれ別軸で振り分ける。
async function aggregateMeetingCalendar(project, from, to) {
  const notes = await sql`
    SELECT id, title, meeting_type, meeting_date, summary, todos
    FROM meeting_notes WHERE project = ${project}
  `;

  const notesByDate = {};
  const todosByDate = {};

  notes.forEach(n => {
    const dateKey = toDateKey(n.meeting_date);
    if (dateKey >= from && dateKey <= to) {
      if (!notesByDate[dateKey]) notesByDate[dateKey] = [];
      notesByDate[dateKey].push({
        id: n.id, title: n.title, meeting_type: n.meeting_type, summary: n.summary,
      });
    }

    const todos = Array.isArray(n.todos) ? n.todos : [];
    todos.forEach(t => {
      if (!t.due_date || t.due_date < from || t.due_date > to) return;
      if (!todosByDate[t.due_date]) todosByDate[t.due_date] = [];
      todosByDate[t.due_date].push({
        note_id: n.id, note_title: n.title, text: t.text, done: !!t.done,
      });
    });
  });

  return { notes_by_date: notesByDate, todos_by_date: todosByDate };
}

// LOCLE/群馬お仕事図鑑の議事録カレンダーと、プロジェクトを問わない出退勤記録を
// まとめて1つのレスポンスで返す(calendar.htmlの統合表示用)。データ自体はプロジェクトごとに
// 分離したクエリのまま実行し、表示側で統合できるよう{locle, ozukanzukan, work_logs_by_date}の
// 形に整形するだけに留める(projectパラメータを受け取っても無視し、常に両方返す)。
async function handleCalendarEvents(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "GETメソッドのみ対応しています" });
  }
  const year = parseInt(req.query.year, 10);
  const month = parseInt(req.query.month, 10);
  if (!year || !month || month < 1 || month > 12) {
    return res.status(400).json({ error: "有効なyear, monthが必要です" });
  }

  const pad = n => String(n).padStart(2, "0");
  const from = `${year}-${pad(month)}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const to = `${year}-${pad(month)}-${pad(lastDay)}`;

  try {
    const [locle, ozukanzukan, workLogs] = await Promise.all([
      aggregateMeetingCalendar("locle", from, to),
      aggregateMeetingCalendar("ozukanzukan", from, to),
      sql`SELECT user_name, date, clock_in, clock_out FROM work_logs WHERE date >= ${from} AND date <= ${to}`,
    ]);

    const workLogsByDate = {};
    workLogs.forEach(w => {
      // work_logs.dateもmeeting_notes.meeting_dateと同じDATE型のため、toDateKey()で
      // ローカルgetter経由の"YYYY-MM-DD"に復元してからキーとして使う(タイムゾーン対策)
      const dateKey = toDateKey(w.date);
      if (!workLogsByDate[dateKey]) workLogsByDate[dateKey] = [];
      workLogsByDate[dateKey].push({
        user_name: w.user_name, clock_in: w.clock_in, clock_out: w.clock_out,
      });
    });

    return res.status(200).json({ locle, ozukanzukan, work_logs_by_date: workLogsByDate });
  } catch (err) {
    return res.status(500).json({ error: `DB取得エラー: ${err.message}` });
  }
}
