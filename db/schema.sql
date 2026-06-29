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
