-- Hero damage dealt by the tracked player in each match (the final value of the match's player_damage series).
-- Filled by the feed sync from deadlock-api match records, so it exists only for games someone uploaded; NULL otherwise.
ALTER TABLE player_matches ADD COLUMN hero_damage INTEGER;
