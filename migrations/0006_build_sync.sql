-- In-game build sync: the author flags a build, their uploader publishes it through Steam's game coordinator.
ALTER TABLE builds ADD COLUMN sync_wanted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE builds ADD COLUMN synced_at INTEGER;
ALTER TABLE builds ADD COLUMN sync_error TEXT;
