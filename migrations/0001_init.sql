-- Friends we track. account_id is the 32-bit Steam account id (SteamID3).
CREATE TABLE IF NOT EXISTS players (
  account_id   INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  avatar_url   TEXT,
  added_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  last_sync_at INTEGER,
  -- latest MMR snapshot
  mmr_score    REAL,
  mmr_rank     INTEGER,
  mmr_updated  INTEGER
);

-- One row per (player, match) straight from /v1/players/{id}/match-history.
CREATE TABLE IF NOT EXISTS player_matches (
  account_id       INTEGER NOT NULL REFERENCES players(account_id),
  match_id         INTEGER NOT NULL,
  hero_id          INTEGER NOT NULL,
  start_time       INTEGER NOT NULL,
  duration_s       INTEGER NOT NULL,
  won              INTEGER NOT NULL,          -- 1/0
  team             INTEGER,
  kills            INTEGER NOT NULL DEFAULT 0,
  deaths           INTEGER NOT NULL DEFAULT 0,
  assists          INTEGER NOT NULL DEFAULT 0,
  net_worth        INTEGER NOT NULL DEFAULT 0,
  last_hits        INTEGER NOT NULL DEFAULT 0,
  denies           INTEGER NOT NULL DEFAULT 0,
  hero_level       INTEGER,
  match_mode       INTEGER,
  game_mode        INTEGER,
  raw              TEXT,                      -- original JSON, so nothing is lost
  PRIMARY KEY (account_id, match_id)
);
CREATE INDEX IF NOT EXISTS idx_pm_start ON player_matches(start_time DESC);
CREATE INDEX IF NOT EXISTS idx_pm_hero  ON player_matches(account_id, hero_id);

-- MMR history so we can chart it.
CREATE TABLE IF NOT EXISTS mmr_history (
  account_id INTEGER NOT NULL,
  ts         INTEGER NOT NULL,
  score      REAL,
  rank       INTEGER,
  PRIMARY KEY (account_id, ts)
);

-- Full match metadata (all 12 players, items, abilities) — fetched lazily when someone opens a match.
CREATE TABLE IF NOT EXISTS match_meta (
  match_id   INTEGER PRIMARY KEY,
  fetched_at INTEGER NOT NULL,
  json       TEXT NOT NULL
);

-- Build wizard output / hand-made builds shared with the group.
CREATE TABLE IF NOT EXISTS builds (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  hero_id     INTEGER NOT NULL,
  author      TEXT NOT NULL,
  title       TEXT NOT NULL,
  priorities  TEXT NOT NULL,   -- JSON: {"weapon_damage":5,"spirit":3,"ammo":4,"falloff":4,...}
  items       TEXT NOT NULL,   -- JSON: [{item_id, phase}] in purchase order
  notes       TEXT,
  votes       INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_builds_hero ON builds(hero_id);
