-- Invite-only access. Cloudflare Access handles Google sign-in; the Worker checks the email here.
CREATE TABLE IF NOT EXISTS members (
  email       TEXT PRIMARY KEY,            -- lower-cased
  role        TEXT NOT NULL DEFAULT 'member', -- 'admin' | 'member'
  account_id  INTEGER,                     -- optional link to players.account_id
  invited_by  TEXT,
  invited_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen   INTEGER
);
