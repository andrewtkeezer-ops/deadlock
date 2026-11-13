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
type MetaPlayer = { account_id: number; hero_id: number; team: string | number; kills: number; deaths: number; assists: number; net_worth: number; last_hits: number; denies: number; player_level?: number; abandon_match_time_s?: number; stats_player_damage?: number[] };
type MetaMatch = { match_id: number; start_time: string | number; duration_s: number; winning_team: string | number; match_mode: string | number; game_mode: string | number; players?: MetaPlayer[] };

const teamNo = (t: string | number) => (typeof t === "number" ? t : t === "Team1" ? 1 : 0);
const MODE: Record<string, number> = { unranked: 1, privatelobby: 2, private_lobby: 2, coopbot: 3, coop_bot: 3, ranked: 4 };
const modeNo = (m: string | number) => (typeof m === "number" ? m : MODE[String(m).toLowerCase()] ?? 0);
const gameModeNo = (m: string | number) => (typeof m === "number" ? m : String(m).toLowerCase() === "normal" ? 1 : 4);
const unix = (t: string | number) => (typeof t === "number" ? t : Math.floor(Date.parse(t.includes("T") ? t : t.replace(" ", "T") + "Z") / 1000));

type Pass = { found: number; checked: number; filled: number; fresh: MatchHistoryRow[] };

/** One request to the match-record endpoint for a time window, stored with as few D1 queries as possible (4 at most). */
async function pass(env: Env, api: DeadlockApi, accountIds: number[], since: number, until: number | undefined, limit: number): Promise<Pass> {
  const matches = await api.get<MetaMatch[]>("/v1/matches/metadata", {
    account_ids: accountIds.join(","), only_filtered_players: "true", include_info: "true", include_player_info: "true",
    match_mode: "ranked,unranked", min_unix_timestamp: since, max_unix_timestamp: until, order_by: "match_id", order_direction: "desc", limit, extra_player_columns: "stats.player_damage",
  }, 0);
  const ids = new Set(accountIds);
  const rows: MatchHistoryRow[] = [], damage = new Map<string, number>();
  for (const m of matches) for (const p of m.players ?? []) {
    if (!ids.has(p.account_id)) continue;
    const series = p.stats_player_damage; // cumulative, so the last sample is the match total
    if (series?.length) damage.set(`${p.account_id}:${m.match_id}`, series[series.length - 1]);
    const team = teamNo(p.team), win = teamNo(m.winning_team);
    rows.push({ account_id: p.account_id, match_id: m.match_id, hero_id: p.hero_id, hero_level: p.player_level ?? 0, start_time: unix(m.start_time), game_mode: gameModeNo(m.game_mode), match_mode: modeNo(m.match_mode),
      player_team: team, player_kills: p.kills, player_deaths: p.deaths, player_assists: p.assists, denies: p.denies, net_worth: p.net_worth, last_hits: p.last_hits,
      team_abandoned: null, abandoned_time_s: p.abandon_match_time_s || null, match_duration_s: m.duration_s, match_result: win, player_match_outcome: team === win ? 1 : 2 });
  }
  if (!rows.length) return { found: 0, checked: matches.length, filled: 0, fresh: [] };
  // Only insert what we don't have; the history copy (with ranked fields) wins when both exist. One query, ids passed as JSON.
  const known = new Set<string>(), hasDamage = new Set<string>();
  const { results } = await env.DB.prepare("SELECT account_id, match_id, hero_damage FROM player_matches WHERE match_id IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify([...new Set(rows.map((r) => r.match_id))])).all<{ account_id: number; match_id: number; hero_damage: number | null }>();
  for (const r of results) { known.add(`${r.account_id}:${r.match_id}`); if (r.hero_damage != null) hasDamage.add(`${r.account_id}:${r.match_id}`); }
  const fresh = rows.filter((r) => !known.has(`${r.account_id}:${r.match_id}`));
  if (fresh.length) {
    const stmt = env.DB.prepare(`INSERT OR IGNORE INTO player_matches
     (account_id, match_id, hero_id, start_time, duration_s, won, team, kills, deaths, assists, net_worth, last_hits, denies, hero_level, match_mode, game_mode, raw, source)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'feed')`);
    await env.DB.batch(fresh.map((m) => stmt.bind(m.account_id, m.match_id, m.hero_id, m.start_time, m.match_duration_s, m.player_match_outcome === 1 ? 1 : 0, m.player_team,
      m.player_kills, m.player_deaths, m.player_assists, m.net_worth, m.last_hits, m.denies, m.hero_level, m.match_mode, m.game_mode, JSON.stringify({ ...m, source: "feed" }))));
  }
  // Hero damage for every row that doesn't have it yet (rows just inserted, and older rows from match history). One statement for the lot.
  const fills = [...damage].filter(([k]) => !hasDamage.has(k)).map(([k, v]) => { const [acc, mid] = k.split(":").map(Number); return [acc, mid, Math.round(v)]; });
  if (fills.length) await env.DB.prepare(`UPDATE player_matches SET hero_damage = json_extract(j.value, '$[2]') FROM json_each(?) AS j
     WHERE player_matches.account_id = json_extract(j.value, '$[0]') AND player_matches.match_id = json_extract(j.value, '$[1]') AND player_matches.hero_damage IS NULL`).bind(JSON.stringify(fills)).run();
  return { found: fresh.length, checked: matches.length, filled: fills.length, fresh };
}

const DAY = 86400, DMG_STEP = 10, DMG_DAYS = 90; // damage backfill: ten days of older games per run, back to 90 days

export async function feedSync(env: Env, api: DeadlockApi, accountIds: number[]): Promise<{ found: number; checked: number }> {
  if (!accountIds.length) return { found: 0, checked: 0 };
  const now = Math.floor(Date.now() / 1000);
  // First run looks back 60 days, after that 4 days is plenty for a 10-minute cron.
  const backfilled = await getSetting<boolean>(env, "feed_backfilled");
  const main = await pass(env, api, accountIds, now - (backfilled ? 4 : 60) * DAY, undefined, backfilled ? 300 : 2000);
  if (!backfilled) await setSetting(env, "feed_backfilled", true);
  else if (main.fresh.length) {
    // Announce feed finds like any other new game (skipped on the 60-day backfill).
    const byPlayer = new Map<number, MatchHistoryRow[]>(); for (const r of main.fresh) byPlayer.set(r.account_id, [...(byPlayer.get(r.account_id) ?? []), r]);
    for (const [id, list] of byPlayer) { const p = await env.DB.prepare("SELECT account_id, name, avatar_url FROM players WHERE account_id=?").bind(id).first<{ account_id: number; name: string; avatar_url: string | null }>(); if (p) await notifyMatches(env, p, list, true).catch(() => {}); }
  }
  // Hero damage (added 2026-11) for games stored before the column existed: walk back a small slice per run so no single run
  // is heavy. `feed_damage_days` is how far back has been done; a failed slice is retried next run and never blocks the feed above.
  let dmg: Record<string, unknown> | undefined;
  const done = (await getSetting<number>(env, "feed_damage_days")) ?? 4;
  if (done < DMG_DAYS) {
    try {
      const r = await pass(env, api, accountIds, now - (done + DMG_STEP) * DAY, now - done * DAY + 3600, 1000);
      await setSetting(env, "feed_damage_days", done + DMG_STEP);
      dmg = { days: done + DMG_STEP, of: DMG_DAYS, filled: r.filled };
    } catch (e) { dmg = { days: done, of: DMG_DAYS, error: (e as Error).message.slice(0, 200) }; }
  }
  await setSetting(env, "feed_last", { at: now, checked: main.checked, found: main.found, damage_filled: main.filled, ...(dmg ? { damage_backfill: dmg } : {}) }).catch(() => {});
  return { found: main.found, checked: main.checked };
}
