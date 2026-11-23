CREATE TABLE reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter TEXT NOT NULL,
  reported TEXT NOT NULL,
  text TEXT NOT NULL,
  ctx TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX reports_reported ON reports (reported, at);
CREATE INDEX reports_reporter ON reports (reporter, at);
CREATE INDEX reports_at ON reports (at);

ALTER TABLE players ADD COLUMN typed INTEGER NOT NULL DEFAULT 1;
ALTER TABLE players ADD COLUMN mute_until INTEGER NOT NULL DEFAULT 0;
