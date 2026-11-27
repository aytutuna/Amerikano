CREATE TABLE friend_day (
  player TEXT NOT NULL,
  day INTEGER NOT NULL,
  match TEXT NOT NULL,
  net INTEGER NOT NULL,
  PRIMARY KEY (player, match)
);
CREATE INDEX friend_day_day ON friend_day (player, day);

CREATE TABLE held (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player TEXT NOT NULL,
  amount INTEGER NOT NULL,
  match TEXT NOT NULL,
  at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'held',
  done INTEGER
);
CREATE UNIQUE INDEX held_match ON held (match, player);
CREATE INDEX held_state ON held (state, at);
