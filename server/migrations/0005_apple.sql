ALTER TABLE players ADD COLUMN apple TEXT;
ALTER TABLE players ADD COLUMN apple_refresh TEXT;
ALTER TABLE players ADD COLUMN apple_client TEXT;
CREATE UNIQUE INDEX players_apple ON players (apple);

CREATE TABLE sessions (
  player TEXT NOT NULL,
  secret_hash TEXT PRIMARY KEY,
  created INTEGER NOT NULL
);
CREATE INDEX sessions_player ON sessions (player);
-- players.secret_hash stays for the old worker; drop it in a later migration once this one is live
INSERT INTO sessions (player, secret_hash, created) SELECT id, secret_hash, created FROM players;

CREATE TABLE nonces (
  raw TEXT PRIMARY KEY,
  exp INTEGER NOT NULL
);
CREATE INDEX nonces_exp ON nonces (exp);
