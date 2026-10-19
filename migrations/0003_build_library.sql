-- Shared build library. Stored in the same shape as Valve's CMsgHeroBuild so the uploader can
-- push a build into the game later without translation.
ALTER TABLE builds ADD COLUMN account_id INTEGER;          -- author's Steam account (players.account_id)
ALTER TABLE builds ADD COLUMN description TEXT;
ALTER TABLE builds ADD COLUMN details TEXT;                -- JSON: { mod_categories: [{ name, description, mods: [{ ability_id, annotation }] }] }
ALTER TABLE builds ADD COLUMN updated_at INTEGER;
ALTER TABLE builds ADD COLUMN ingame_build_id INTEGER;     -- set once the uploader has synced it into the game
ALTER TABLE builds ADD COLUMN ingame_version INTEGER;
ALTER TABLE builds ADD COLUMN forked_from INTEGER;         -- builds.id this was copied from
CREATE INDEX IF NOT EXISTS idx_builds_author ON builds(account_id);
