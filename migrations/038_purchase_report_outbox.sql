CREATE TABLE purchase_report_outbox (
  grant_id TEXT PRIMARY KEY,
  purchase_key TEXT NOT NULL UNIQUE,
  purchased_at INTEGER NOT NULL,
  currency TEXT,
  amount_micros INTEGER,
  price_retry_at INTEGER NOT NULL DEFAULT 0,
  attempted_at INTEGER,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  message_id TEXT
);
CREATE INDEX purchase_reports_due ON purchase_report_outbox(next_attempt_at) WHERE message_id IS NULL;
CREATE INDEX purchase_reports_day ON purchase_report_outbox(purchased_at);
