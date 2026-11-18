ALTER TABLE players ADD COLUMN google TEXT;
CREATE UNIQUE INDEX players_google ON players (google);
