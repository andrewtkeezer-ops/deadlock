export type Env = {
  DB: D1Database;
  CACHE: KVNamespace;
  ASSETS: Fetcher;
  DEADLOCK_API: string;
  DEADLOCK_ASSETS: string;
  DEADLOCK_API_KEY?: string;
  ADMIN_TOKEN: string;
};

// Shape of one row from GET /v1/players/{account_id}/match-history.
// Field names verified against the public clients; re-check against
// https://api.deadlock-api.com/openapi.json after a patch if sync starts failing.
export type MatchHistoryRow = {
  account_id: number;
  match_id: number;
  hero_id: number;
  hero_level: number;
  start_time: number;
  game_mode: number;
  match_mode: number;
  player_team: number;
  player_kills: number;
  player_deaths: number;
  player_assists: number;
  denies: number;
  net_worth: number;
  last_hits: number;
  team_abandoned: boolean | null;
  abandoned_time_s: number | null;
  match_duration_s: number;
  match_result: number; // 0/1 = winning team id; won = match_result === player_team
};

export type MmrRow = {
  account_id: number;
  match_id?: number;
  start_time?: number;
  player_score: number;
  rank: number;
  division?: number;
  division_tier?: number;
};

export type Player = {
  account_id: number;
  name: string;
  avatar_url: string | null;
  last_sync_at: number | null;
  mmr_score: number | null;
  mmr_rank: number | null;
};
