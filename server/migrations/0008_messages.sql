CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  text TEXT NOT NULL,
  at INTEGER NOT NULL,
  seen INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX messages_to ON messages (recipient, sender, id);
CREATE INDEX messages_from ON messages (sender, recipient, id);
CREATE INDEX messages_at ON messages (at);

ALTER TABLE players ADD COLUMN push_dm INTEGER NOT NULL DEFAULT 1;
