CREATE TABLE match_seat (
  match TEXT NOT NULL,
  code TEXT NOT NULL,
  kind TEXT NOT NULL,
  stake INTEGER NOT NULL,
  player TEXT NOT NULL,
  fake INTEGER NOT NULL DEFAULT 0,
  seat INTEGER NOT NULL,
  at INTEGER NOT NULL,
  net INTEGER,
  gone INTEGER NOT NULL DEFAULT 0,
  gone_at INTEGER,
  PRIMARY KEY (match, player)
);
CREATE INDEX match_seat_player ON match_seat (player, at);
CREATE INDEX match_seat_code ON match_seat (code, at);
CREATE INDEX match_seat_at ON match_seat (at);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO settings (key, value) VALUES
  ('strong', '{"100":0,"500":1,"2500":2,"10000":9,"50000":9,"cup1000":1,"cup5000":2,"cup25000":9}'),
  ('chipsoff', '');

CREATE TABLE admin_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  who TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT
);

CREATE TABLE flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  a TEXT NOT NULL,
  b TEXT,
  x INTEGER,
  y INTEGER,
  at INTEGER NOT NULL,
  cleared INTEGER
);
CREATE INDEX flags_kind ON flags (kind, at);

CREATE TABLE trade_hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player TEXT NOT NULL,
  ctx TEXT NOT NULL,
  term TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX trade_hits_player ON trade_hits (player, at);
CREATE INDEX trade_hits_at ON trade_hits (at);

ALTER TABLE players ADD COLUMN banned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN banned_why TEXT;
ALTER TABLE players ADD COLUMN banned_at INTEGER;
ALTER TABLE players ADD COLUMN country TEXT;
ALTER TABLE players ADD COLUMN pub_games INTEGER NOT NULL DEFAULT 0;

ALTER TABLE reports ADD COLUMN match TEXT;
ALTER TABLE reports ADD COLUMN counts INTEGER NOT NULL DEFAULT 0;

-- guests the old worker made after 0005 have no session row yet; give them one before the old column is emptied
INSERT OR IGNORE INTO sessions (player, secret_hash, created)
  SELECT id, secret_hash, created FROM players WHERE secret_hash <> '' AND NOT EXISTS (SELECT 1 FROM sessions WHERE player = players.id);
UPDATE players SET secret_hash = '';
