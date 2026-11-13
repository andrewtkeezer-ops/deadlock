/**
 * Street Brawl is a different game (short rounds, its own scoring), so it never counts toward the primary numbers:
 * leaderboard, records, weekly recap, hero stats, achievements, hero points. Those games are still stored and can be
 * looked at on their own from a profile (the Street Brawl switch).
 *
 * game_mode comes from deadlock-api: 1 = Normal, 4 = Street Brawl (checked against match metadata, 2026-11-12).
 * Rows from before the column was filled are NULL and are treated as Normal.
 */
export const BRAWL = 4;
/** SQL condition for "a standard game". Pass the table alias when the query has one. */
export const std = (alias = "") => `COALESCE(${alias ? alias + "." : ""}game_mode,1)<>${BRAWL}`;
/** SQL condition for "a Street Brawl game". */
export const brawl = (alias = "") => `${alias ? alias + "." : ""}game_mode=${BRAWL}`;
