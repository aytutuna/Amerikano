-- one row per human result against computer players, and the daily totals that outlive the rows
CREATE TABLE persona_flow (
  match TEXT NOT NULL,
  player TEXT NOT NULL,
  day INTEGER NOT NULL,
  kind TEXT NOT NULL,
  stake INTEGER NOT NULL,
  sharp INTEGER NOT NULL,
  fakes INTEGER NOT NULL,
  humans INTEGER NOT NULL,
  net INTEGER NOT NULL,
  units REAL NOT NULL,
  won INTEGER NOT NULL,
  fake_net INTEGER NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (match, player)
);
CREATE INDEX persona_flow_day ON persona_flow (day, kind, stake);
CREATE INDEX persona_flow_player ON persona_flow (player);

CREATE TABLE persona_day (
  day INTEGER NOT NULL,
  kind TEXT NOT NULL,
  stake INTEGER NOT NULL,
  matches INTEGER NOT NULL DEFAULT 0,
  units REAL NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  fake_net INTEGER NOT NULL DEFAULT 0,
  rm_human INTEGER NOT NULL DEFAULT 0,
  rm_human_yes INTEGER NOT NULL DEFAULT 0,
  rm_fake INTEGER NOT NULL DEFAULT 0,
  rm_fake_yes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind, stake)
);

ALTER TABLE personas ADD COLUMN week INTEGER NOT NULL DEFAULT 0;
ALTER TABLE personas ADD COLUMN week_won INTEGER NOT NULL DEFAULT 0;
ALTER TABLE personas ADD COLUMN prev_week INTEGER NOT NULL DEFAULT 0;
ALTER TABLE personas ADD COLUMN prev_won INTEGER NOT NULL DEFAULT 0;
ALTER TABLE personas ADD COLUMN week_xp INTEGER NOT NULL DEFAULT 0;
ALTER TABLE personas ADD COLUMN factor REAL NOT NULL DEFAULT 1;
CREATE INDEX personas_week ON personas (week, week_won DESC);
UPDATE personas SET factor = 0.3 + abs(random()) % 1201 / 1000.0;

ALTER TABLE friends ADD COLUMN decide INTEGER;
CREATE INDEX friends_decide ON friends (decide);

UPDATE personas SET vip = 0;
UPDATE personas SET wear = (SELECT COALESCE(json_group_object(key, value), '{}') FROM json_each(personas.wear) WHERE value NOT IN ('frame-gold', 'plate-vip', 'back-vip')) WHERE wear IS NOT NULL;
