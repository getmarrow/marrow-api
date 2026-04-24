CREATE TABLE IF NOT EXISTS emails_sent (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  template_name TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  resend_message_id TEXT,
  UNIQUE(account_id, template_name)
);
CREATE INDEX IF NOT EXISTS idx_emails_sent_account ON emails_sent(account_id);
CREATE INDEX IF NOT EXISTS idx_emails_sent_template ON emails_sent(template_name);

CREATE TABLE IF NOT EXISTS email_unsubscribes (
  account_id TEXT PRIMARY KEY,
  unsubscribed_at TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE
);
