-- companies: 営業対象企業
CREATE TABLE IF NOT EXISTS companies (
  id                SERIAL PRIMARY KEY,
  name              TEXT NOT NULL,
  url               TEXT NOT NULL,
  contact_form_url  TEXT,
  status            TEXT NOT NULL DEFAULT 'pending',
  priority          INTEGER NOT NULL DEFAULT 0,
  research_result   JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- message_variants: 送信メッセージのテンプレート
CREATE TABLE IF NOT EXISTS message_variants (
  id               SERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  channel          TEXT NOT NULL,
  subject_template TEXT,
  body_template    TEXT NOT NULL,
  tags             JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- send_logs: 送信履歴
CREATE TABLE IF NOT EXISTS send_logs (
  id           SERIAL PRIMARY KEY,
  company_id   INTEGER NOT NULL REFERENCES companies(id),
  variant_id   INTEGER NOT NULL REFERENCES message_variants(id),
  channel      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  trigger_mode TEXT NOT NULL DEFAULT 'manual',
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- responses: 返信・反応の記録
CREATE TABLE IF NOT EXISTS responses (
  id            SERIAL PRIMARY KEY,
  send_log_id   INTEGER NOT NULL REFERENCES send_logs(id),
  received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  classification TEXT,
  raw_excerpt   TEXT
);

-- scheduled_sends: 送信予約
CREATE TABLE IF NOT EXISTS scheduled_sends (
  id           SERIAL PRIMARY KEY,
  company_id   INTEGER NOT NULL REFERENCES companies(id),
  variant_id   INTEGER NOT NULL REFERENCES message_variants(id),
  channel      TEXT NOT NULL DEFAULT 'form',
  scheduled_at TIMESTAMPTZ NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- contacts: 企業ごとの担当者
CREATE TABLE IF NOT EXISTS contacts (
  id          SERIAL PRIMARY KEY,
  company_id  INTEGER NOT NULL REFERENCES companies(id),
  name        TEXT NOT NULL,
  title       TEXT,
  email       TEXT,
  phone       TEXT,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- deals: 商談（パイプライン管理）
-- stage: lead(リード) / contacted(コンタクト済み) / proposal(提案中) / negotiation(交渉中) / won(成約) / lost(失注)
CREATE TABLE IF NOT EXISTS deals (
  id                   SERIAL PRIMARY KEY,
  company_id           INTEGER NOT NULL REFERENCES companies(id),
  title                TEXT NOT NULL,
  stage                TEXT NOT NULL DEFAULT 'lead',
  amount               INTEGER,
  expected_close_date  DATE,
  note                 TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- activities: 活動履歴
-- type: note(メモ) / call(電話) / email(メール) / form(フォーム) / meeting(商談) / other(その他)
CREATE TABLE IF NOT EXISTS activities (
  id          SERIAL PRIMARY KEY,
  company_id  INTEGER NOT NULL REFERENCES companies(id),
  deal_id     INTEGER REFERENCES deals(id),
  type        TEXT NOT NULL DEFAULT 'note',
  content     TEXT NOT NULL,
  activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- excluded_domains: フォーム/メール自動送信を禁止するドメイン
CREATE TABLE IF NOT EXISTS excluded_domains (
  id         SERIAL PRIMARY KEY,
  domain     TEXT NOT NULL UNIQUE,
  reason     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
