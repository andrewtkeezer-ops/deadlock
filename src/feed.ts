import type { DeadlockApi } from "./deadlock";
import type { Env, MatchHistoryRow } from "./types";
import { notifyMatches } from "./notify";
import { getSetting, setSetting } from "./settings";

/**
 * Soul Scribe's own match feed.
 *
 * `/v1/players/:id/match-history` only knows matches that reached deadlock-api's per-player history table. Full match
 * records (`/v1/matches/metadata`) are stored as soon as *anyone* in the game uploads it, including strangers, so asking
 * that endpoint for "every match one of these account ids played in" finds games the history call can miss. One request
 * covers the whole squad. Rows found this way are tagged source='feed'.
 */
type MetaPlayer = { account_id: number; hero_id: number; team: string | number; kills: number; deaths: number; assists: number; net_worth: number; last_hits: number; denies: number; player_level?: number; abandon_match_time_s?: number };
type MetaMatch = { match_id: number; start_time: string | number; duration_s: number; winning_team: string | number; match_mode: string | number; game_mode: string | number; players?: MetaPlayer[] };

const teamNo = (t: string | number) => (typeof t === "number" ? t : t === "Team1" ? 1 : 0);
const MODE: Record<string, number> = { unranked: 1, privatelobby: 2, private_lobby: 2, coopbot: 3, coop_bot: 3, ranked: 4 };
const modeNo = (m: string | number) => (typeof m === "number" ? m : MODE[String(m).toLowerCase()] ?? 0);
const gameModeNo = (m: string | number) => (typeof m === "number" ? m : String(m).toLowerCase() === "normal" ? 1 : 4);
const unix = (t: string | number) => (typeof t === "number" ? t : Math.floor(Date.parse(t.includes("T") ? t : t.replace(" ", "T") + "Z") / 1000));

export async function feedSync(env: Env, api: DeadlockApi, accountIds: number[]): Promise<{ found: number; checked: number }> {
  if (!accountIds.length) return { found: 0, checked: 0 };
  const now = Math.floor(Date.now() / 1000);
  // First run looks back 60 days, after that 4 days is plenty for a 10-minute cron.
  const backfilled = await getSetting<boolean>(env, "feed_backfilled");
  const since = now - (backfilled ? 4 : 60) * 86400;
  const matches = await api.get<MetaMatch[]>("/v1/matches/metadata", {
    account_ids: accountIds.join(","), only_filtered_players: "true", include_info: "true", include_player_info: "true",
    match_mode: "ranked,unranked", min_unix_timestamp: since, order_by: "match_id", order_direction: "desc", limit: backfilled ? 300 : 2000,
  }, 0);
  const ids = new Set(accountIds);
  const rows: MatchHistoryRow[] = [];
  for (const m of matches) for (const p of m.players ?? []) {
    if (!ids.has(p.account_id)) continue;
    const team = teamNo(p.team), win = teamNo(m.winning_team);
    rows.push({ account_id: p.account_id, match_id: m.match_id, hero_id: p.hero_id, hero_level: p.player_level ?? 0, start_time: unix(m.start_time), game_mode: gameModeNo(m.game_mode), match_mode: modeNo(m.match_mode),
      player_team: team, player_kills: p.kills, player_deaths: p.deaths, player_assists: p.assists, denies: p.denies, net_worth: p.net_worth, last_hits: p.last_hits,
      team_abandoned: null, abandoned_time_s: p.abandon_match_time_s || null, match_duration_s: m.duration_s, match_result: win, player_match_outcome: team === win ? 1 : 2 });
  }
  if (!rows.length) { if (!backfilled) await setSetting(env, "feed_backfilled", true); return { found: 0, checked: matches.length }; }
  // Only insert what we don't have; the history copy (with ranked fields) wins when both exist.
  const known = new Set<string>();
  for (let i = 0; i < rows.length; i += 90) {
    const chunk = rows.slice(i, i + 90);
    const { results } = await env.DB.prepare(`SELECT account_id, match_id FROM player_matches WHERE match_id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk.map((r) => r.match_id)).all<{ account_id: number; match_id: number }>();
    for (const r of results) known.add(`${r.account_id}:${r.match_id}`);
  }
  const fresh = rows.filter((r) => !known.has(`${r.account_id}:${r.match_id}`));
  const stmt = env.DB.prepare(`INSERT OR IGNORE INTO player_matches
     (account_id, match_id, hero_id, start_time, duration_s, won, team, kills, deaths, assists, net_worth, last_hits, denies, hero_level, match_mode, game_mode, raw, source)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'feed')`);
  const batch = fresh.map((m) => stmt.bind(m.account_id, m.match_id, m.hero_id, m.start_time, m.match_duration_s, m.player_match_outcome === 1 ? 1 : 0, m.player_team,
    m.player_kills, m.player_deaths, m.player_assists, m.net_worth, m.last_hits, m.denies, m.hero_level, m.match_mode, m.game_mode, JSON.stringify({ ...m, source: "feed" })));
  for (let i = 0; i < batch.length; i += 50) await env.DB.batch(batch.slice(i, i + 50));
  if (!backfilled) await setSetting(env, "feed_backfilled", true);
  else {
    // Announce feed finds like any other new game (skipped on the 60-day backfill).
    const byPlayer = new Map<number, MatchHistoryRow[]>(); for (const r of fresh) byPlayer.set(r.account_id, [...(byPlayer.get(r.account_id) ?? []), r]);
    for (const [id, list] of byPlayer) { const p = await env.DB.prepare("SELECT account_id, name, avatar_url FROM players WHERE account_id=?").bind(id).first<{ account_id: number; name: string; avatar_url: string | null }>(); if (p) await notifyMatches(env, p, list, true).catch(() => {}); }
  }
  await setSetting(env, "feed_last", { at: now, checked: matches.length, found: fresh.length }).catch(() => {});
  return { found: fresh.length, checked: matches.length };
}
