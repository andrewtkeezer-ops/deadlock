import { DeadlockApi } from "./deadlock";
import type { Env, MatchHistoryRow, Player } from "./types";
import { notifyMatches, notifyRankChanges } from "./notify";

/**
 * Pull each tracked friend's match history + MMR into D1.
 * Runs hourly via cron and on POST /api/admin/sync.
 * Match history only contains matches deadlock-api knows about — which is why
 * everyone needs the ingest tool installed (see /setup).
 */
export async function syncAll(env: Env): Promise<{ players: number; newMatches: number; errors: string[] }> {
  const api = new DeadlockApi(env);
  const { results: players } = await env.DB.prepare("SELECT * FROM players").all<Player>();
  const errors: string[] = [];
  let newMatches = 0;

  // Sequential on purpose: the API queues uncached DB queries and 503s on bursts.
  for (const p of players) {
    try {
      newMatches += await syncPlayer(env, api, p.account_id);
    } catch (e) {
      errors.push(`${p.account_id}: ${(e as Error).message}`);
    }
  }

  if (players.length) {
    try {
      const rows = await api.mmr(players.map((p) => p.account_id));
      const now = Math.floor(Date.now() / 1000);
      const before = new Map(players.map((p) => [p.account_id, p]));
      const changes = rows.filter((r) => r.rank && before.get(r.account_id)?.mmr_rank != null && before.get(r.account_id)!.mmr_rank !== r.rank)
        .map((r) => ({ name: before.get(r.account_id)!.name, avatar_url: before.get(r.account_id)!.avatar_url, before: before.get(r.account_id)!.mmr_rank, after: r.rank, score: r.player_score }));
      const stmts = rows.flatMap((r) => [
        env.DB.prepare("UPDATE players SET mmr_score=?, mmr_rank=?, mmr_updated=? WHERE account_id=?").bind(r.player_score, r.rank, now, r.account_id),
        env.DB.prepare("INSERT OR IGNORE INTO mmr_history(account_id, ts, score, rank) VALUES (?,?,?,?)").bind(r.account_id, now, r.player_score, r.rank),
      ]);
      if (stmts.length) await env.DB.batch(stmts);
      await notifyRankChanges(env, changes);
    } catch (e) {
      errors.push(`MMR not refreshed: ${(e as Error).message}`);
    }
  }
  return { players: players.length, newMatches, errors };
}

export async function syncPlayer(env: Env, api: DeadlockApi, accountId: number): Promise<number> {
  const history = await api.matchHistory(accountId);
  const { results: known } = await env.DB.prepare("SELECT match_id FROM player_matches WHERE account_id=?").bind(accountId).all<{ match_id: number }>();
  const seen = new Set(known.map((k) => k.match_id));
  const fresh = history.filter((m) => !seen.has(m.match_id));

  const stmt = env.DB.prepare(
    `INSERT OR IGNORE INTO player_matches
     (account_id, match_id, hero_id, start_time, duration_s, won, team, kills, deaths, assists, net_worth, last_hits, denies, hero_level, match_mode, game_mode, raw)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const batch = fresh.map((m: MatchHistoryRow) =>
    stmt.bind(
      accountId, m.match_id, m.hero_id, m.start_time, m.match_duration_s,
      m.player_match_outcome === 1 ? 1 : m.player_match_outcome === 2 ? 0 : m.match_result === m.player_team ? 1 : 0, m.player_team,
      m.player_kills, m.player_deaths, m.player_assists, m.net_worth, m.last_hits, m.denies,
      m.hero_level, m.match_mode, m.game_mode, JSON.stringify(m)
    )
  );
  // D1 batches are limited in size; chunk to be safe.
  for (let i = 0; i < batch.length; i += 50) await env.DB.batch(batch.slice(i, i + 50));
  await env.DB.prepare("UPDATE players SET last_sync_at=? WHERE account_id=?").bind(Math.floor(Date.now() / 1000), accountId).run();
  if (fresh.length) { const p = await env.DB.prepare("SELECT account_id, name, avatar_url FROM players WHERE account_id=?").bind(accountId).first<{ account_id: number; name: string; avatar_url: string | null }>(); if (p) await notifyMatches(env, p, fresh, seen.size > 0).catch((e) => console.error("notify", e)); }
  return fresh.length;
}
