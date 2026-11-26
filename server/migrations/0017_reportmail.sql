-- mail about reports: a row per mail, sent = 0 while it waits for the digest, else the time it went out
CREATE TABLE mail_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  report INTEGER,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX mail_log_sent ON mail_log (sent, at);
