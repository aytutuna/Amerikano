CREATE TABLE personas (
  id TEXT PRIMARY KEY,
  name_seed INTEGER NOT NULL,
  avatar TEXT NOT NULL,
  level INTEGER NOT NULL,
  xp INTEGER NOT NULL,
  games INTEGER NOT NULL,
  wins INTEGER NOT NULL,
  chips INTEGER NOT NULL,
  topup INTEGER NOT NULL,
  busy TEXT,
  busy_at INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL
);
CREATE INDEX personas_level ON personas (level);
