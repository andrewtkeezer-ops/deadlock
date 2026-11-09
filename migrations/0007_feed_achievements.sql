-- Where each stored match came from: 'history' (/v1/players/:id/match-history) or 'feed'
-- (Soul Scribe's own feed: /v1/matches/metadata filtered to the squad). NULL = stored before this existed.
ALTER TABLE player_matches ADD COLUMN source TEXT;

-- Achievement unlocks, kept so new ones can be announced once (Discord + the "unlocked" toast).
-- Display is always recomputed from player_matches, so this table never has to be right for the page to be.
CREATE TABLE IF NOT EXISTS achievements (
  account_id INTEGER NOT NULL,
  key        TEXT    NOT NULL,
  tier       INTEGER NOT NULL,
  earned_at  INTEGER NOT NULL,   -- start time of the match that earned it (so backfills keep the real date)
  match_id   INTEGER,
  found_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (account_id, key, tier)
);
CREATE INDEX IF NOT EXISTS idx_ach_found ON achievements(found_at DESC);
