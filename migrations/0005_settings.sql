-- Small key/value store for app-level settings (e.g. the connected Gmail sender).
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT (unixepoch()));
