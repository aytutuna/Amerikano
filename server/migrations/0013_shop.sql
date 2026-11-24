ALTER TABLE players ADD COLUMN tokens INTEGER NOT NULL DEFAULT 0 CHECK (tokens >= 0);
ALTER TABLE players ADD COLUMN earn_day INTEGER NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN earned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN wear_frame TEXT;
ALTER TABLE players ADD COLUMN wear_plate TEXT;
ALTER TABLE players ADD COLUMN wear_back TEXT;
ALTER TABLE players ADD COLUMN wear_felt TEXT;

CREATE TABLE owned (
  player TEXT NOT NULL,
  item TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (player, item)
);

CREATE TABLE token_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player TEXT NOT NULL,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  ref TEXT UNIQUE,
  at INTEGER NOT NULL
);
CREATE INDEX token_log_player ON token_log (player, at);

CREATE TABLE purchases (
  tx TEXT PRIMARY KEY,
  player TEXT NOT NULL,
  product TEXT NOT NULL,
  tokens INTEGER NOT NULL,
  env TEXT,
  at INTEGER NOT NULL,
  refunded INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX purchases_player ON purchases (player);

ALTER TABLE personas ADD COLUMN wear TEXT;
ALTER TABLE personas ADD COLUMN owns TEXT;
