-- Invite tokens: a shareable link per invited email. Accepting = signing in with Google from the invite page.
ALTER TABLE members ADD COLUMN invite_token TEXT;
ALTER TABLE members ADD COLUMN invite_sent_at INTEGER;
ALTER TABLE members ADD COLUMN accepted_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_members_token ON members(invite_token);
