CREATE TABLE active (
  player TEXT NOT NULL,
  day INTEGER NOT NULL,
  PRIMARY KEY (player, day)
);

CREATE TABLE stats (
  day INTEGER PRIMARY KEY,
  new INTEGER NOT NULL,
  dau INTEGER NOT NULL,
  d1 REAL,
  d7 REAL,
  d30 REAL,
  matches INTEGER NOT NULL
);

CREATE INDEX players_created ON players (created);
CREATE INDEX chip_log_escrow ON chip_log (at) WHERE reason = 'escrow';
