import { Hono } from "hono";
import { std, brawl } from "../modes";
import type { Env, Player } from "../types";
import { DeadlockApi } from "../deadlock";
import { bigAvatar } from "../deadlock";
import { ACHIEVEMENTS, achievementsFor } from "../achievements";
import { getSetting } from "../settings";

const r = new Hono<{ Bindings: Env }>();

/** Friend-group leaderboard. Computed from our own D1 copy, so it's instant. */
r.get("/leaderboard", async (c) => {
  const days = Number(c.req.query("days") ?? 30);
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const { results } = await c.env.DB.prepare(
    `SELECT p.account_id, p.name, p.avatar_url, p.mmr_score, p.mmr_rank, p.last_sync_at,
            COUNT(m.match_id)                       AS games,
            COALESCE(SUM(m.won),0)                  AS wins,
            COALESCE(AVG(m.kills),0)                AS avg_kills,
            COALESCE(AVG(m.deaths),0)               AS avg_deaths,
            COALESCE(AVG(m.assists),0)              AS avg_assists,
            COALESCE(SUM(m.kills),0)                AS kills,
            COALESCE(SUM(m.deaths),0)               AS deaths,
            COALESCE(SUM(m.assists),0)              AS assists,
            COALESCE(AVG(m.net_worth*60.0/NULLIF(m.duration_s,0)),0) AS souls_per_min,
            AVG(m.hero_damage)                      AS avg_damage,   -- NULL until a game with a full match record is stored
            COUNT(m.hero_damage)                    AS damage_games,
            MAX(m.start_time)                       AS last_played
       FROM players p
       LEFT JOIN player_matches m ON m.account_id=p.account_id AND m.start_time>=? AND ${std("m")}
      GROUP BY p.account_id
      -- Standings: MMR first (Valve's own rating); unranked players by smoothed win rate (5 phantom wins in 10 phantom games so
      -- one lucky game doesn't top the board), then KDA, then games played.
      ORDER BY p.mmr_score DESC NULLS LAST,
               (COALESCE(SUM(m.won),0) + 5.0) / (COUNT(m.match_id) + 10.0) DESC,
               (COALESCE(SUM(m.kills),0) + COALESCE(SUM(m.assists),0)) * 1.0 / MAX(COALESCE(SUM(m.deaths),0), 1) DESC,
               COUNT(m.match_id) DESC`
  ).bind(since).all();
  return c.json({ days, players: results.map((p) => ({ ...p, avatar_url: bigAvatar(p.avatar_url as string | null) })) });
});

/** Squad duos: two tracked friends on the same team in the same match. ?days= */
r.get("/duos", async (c) => {
  const days = Number(c.req.query("days") ?? 3650); const since = Math.floor(Date.now() / 1000) - days * 86400;
  const { results } = await c.env.DB.prepare(
    `SELECT a.account_id AS a, b.account_id AS b, COUNT(*) AS games, SUM(a.won) AS wins,
            AVG(a.kills + b.kills) AS kills, AVG(a.deaths + b.deaths) AS deaths, AVG(a.assists + b.assists) AS assists, MAX(a.start_time) AS last_played
       FROM player_matches a JOIN player_matches b ON a.match_id=b.match_id AND a.team=b.team AND a.account_id<b.account_id
      WHERE a.start_time>=? AND ${std("a")} GROUP BY a.account_id, b.account_id ORDER BY games DESC, wins DESC`).bind(since).all();
  return c.json(results);
});

/** The squad's newest games in one query, for the leaderboard's ticker and Recent games. Street Brawl games are listed (tagged) but never counted in stats. */
r.get("/recent", async (c) => {
  const limit = Math.max(1, Math.min(60, Number(c.req.query("limit")) || 25));
  const { results } = await c.env.DB.prepare(
    `SELECT m.account_id, p.name, m.match_id, m.hero_id, m.start_time, m.duration_s, m.won, m.kills, m.deaths, m.assists, m.net_worth, m.hero_damage, COALESCE(m.game_mode,1) game_mode
       FROM player_matches m JOIN players p ON p.account_id=m.account_id ORDER BY m.start_time DESC LIMIT ?`).bind(limit).all();
  return c.json(results);
});

r.get("/", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT account_id, name, avatar_url, last_sync_at, mmr_score, mmr_rank FROM players ORDER BY name").all<Player>();
  return c.json(results.map((p) => ({ ...p, avatar_url: bigAvatar(p.avatar_url) })));
});

/** Full 12-player match detail, fetched on demand and cached forever in D1. */
r.get("/match/:matchId", async (c) => {
  const matchId = Number(c.req.param("matchId"));
  const cached = await c.env.DB.prepare("SELECT json FROM match_meta WHERE match_id=?").bind(matchId).first<{ json: string }>();
  if (cached) return c.json(JSON.parse(cached.json));
  const meta = await new DeadlockApi(c.env).matchMetadata(matchId);
  await c.env.DB.prepare("INSERT OR REPLACE INTO match_meta(match_id, fetched_at, json) VALUES (?,?,?)")
    .bind(matchId, Math.floor(Date.now() / 1000), JSON.stringify(meta)).run();
  return c.json(meta);
});

/** Steam names/avatars for a set of account ids (match scoreboards). ?ids=1,2,3 */
r.get("/steam-names", async (c) => {
  const ids = (c.req.query("ids") ?? "").split(",").map(Number).filter(Boolean).slice(0, 24);
  if (!ids.length) return c.json([]);
  const profiles = await new DeadlockApi(c.env).steamProfiles(ids).catch(() => []);
  return c.json(profiles.map((p) => ({ account_id: p.account_id, name: p.personaname, avatar: bigAvatar(p.avatarfull ?? p.avatar) })));
});

/** Global leaderboard passthrough (cached 1h). */
r.get("/global/:region", async (c) => {
  const region = c.req.param("region") as "NAmerica";
  return c.json(await new DeadlockApi(c.env).leaderboard(region));
});

// Catch-all for a single account id — must stay LAST or it swallows /steam-names, /match/… etc.
/** Squad coverage: who has recent games, how many the feed rescued, and whether their uploader has been seen. */
r.get("/coverage", async (c) => {
  const now = Math.floor(Date.now() / 1000), d7 = now - 7 * 86400, d30 = now - 30 * 86400;
  const { results } = await c.env.DB.prepare(
    `SELECT p.account_id, p.name, p.avatar_url, MAX(m.start_time) last_game, SUM(m.start_time > ?) g7, SUM(m.start_time > ?) g30, SUM(m.source='feed' AND m.start_time > ?) feed30, COUNT(m.match_id) total
       FROM players p LEFT JOIN player_matches m ON m.account_id=p.account_id GROUP BY p.account_id ORDER BY last_game DESC`
  ).bind(d7, d30, d30).all<{ account_id: number; name: string; avatar_url: string | null; last_game: number | null; g7: number; g30: number; feed30: number; total: number }>();
  const api = new DeadlockApi(c.env);
  const ingest = await Promise.all(results.map((p) => api.ingestStatus(p.account_id).catch(() => null)));
  const [feed, sync] = await Promise.all([getSetting(c.env, "feed_last"), getSetting(c.env, "last_sync")]);
  return c.json({ players: results.map((p, i) => ({ ...p, g7: p.g7 ?? 0, g30: p.g30 ?? 0, feed30: p.feed30 ?? 0, ingest: ingest[i] })), feed, sync });
});

/** Every stored game in a window, oldest first, for the trend charts (rolling averages are drawn client-side). */
r.get("/:id{[0-9]+}/trends", async (c) => {
  const id = Number(c.req.param("id")), days = Math.min(3650, Math.max(7, Number(c.req.query("days")) || 90));
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const { results } = await c.env.DB.prepare("SELECT match_id, start_time, hero_id, won, kills, deaths, assists, net_worth, duration_s, hero_damage FROM player_matches WHERE account_id=? AND start_time>? AND " + std() + " ORDER BY start_time ASC LIMIT 1500").bind(id, since).all();
  return c.json({ days, games: results });
});

/** Achievements, recomputed from stored games (so they always include old games). */
r.get("/:id{[0-9]+}/achievements", async (c) => {
  const id = Number(c.req.param("id"));
  return c.json({ defs: ACHIEVEMENTS, results: await achievementsFor(c.env, id) });
});

/** "Compared to your rank": the player's typical game (median per match, last 90 days) placed inside the distribution of
 *  single games at their rank tier (last 30 days), overall and on their three most played heroes. Uses the last known
 *  rank; with none there is nothing honest to compare against. */
const BENCH: { key: string; label: string; fmt: "n1" | "n0" | "pct"; lower?: boolean }[] = [
  { key: "kda", label: "KDA", fmt: "n1" }, { key: "net_worth_per_min", label: "Souls / min", fmt: "n0" }, { key: "player_damage_per_min", label: "Hero damage / min", fmt: "n0" },
  { key: "last_hits", label: "Last hits", fmt: "n0" }, { key: "accuracy", label: "Accuracy", fmt: "pct" }, { key: "deaths", label: "Deaths", fmt: "n1", lower: true },
];
type MV = { avg: number | null; percentile1: number | null; percentile5: number | null; percentile10: number | null; percentile25: number | null; percentile50: number | null; percentile75: number | null; percentile90: number | null; percentile95: number | null; percentile99: number | null };
function placeIn(v: number, m: MV): number | null {
  const pts = ([[1, m.percentile1], [5, m.percentile5], [10, m.percentile10], [25, m.percentile25], [50, m.percentile50], [75, m.percentile75], [90, m.percentile90], [95, m.percentile95], [99, m.percentile99]] as [number, number | null][]).filter((p): p is [number, number] => p[1] != null && Number.isFinite(p[1]));
  if (pts.length < 3) return null;
  if (v <= pts[0][1]) return pts[0][0]; if (v >= pts[pts.length - 1][1]) return pts[pts.length - 1][0];
  for (let i = 1; i < pts.length; i++) { const [p0, v0] = pts[i - 1], [p1, v1] = pts[i]; if (v <= v1) return v1 === v0 ? (p0 + p1) / 2 : p0 + ((v - v0) / (v1 - v0)) * (p1 - p0); }
  return null;
}
r.get("/:id{[0-9]+}/benchmarks", async (c) => {
  const id = Number(c.req.param("id"));
  const p = await c.env.DB.prepare("SELECT mmr_rank FROM players WHERE account_id=?").bind(id).first<{ mmr_rank: number | null }>();
  if (!p?.mmr_rank) return c.json({ rank: null });
  const tier = Math.floor(p.mmr_rank / 10); const since = Math.floor(Date.now() / 1000) - 90 * 86400;
  const { results: top } = await c.env.DB.prepare("SELECT hero_id, COUNT(*) n FROM player_matches WHERE account_id=? AND start_time>? AND " + std() + " GROUP BY hero_id ORDER BY n DESC LIMIT 3").bind(id, since).all<{ hero_id: number; n: number }>();
  const api = new DeadlockApi(c.env), path = "/v1/analytics/player-stats/metrics", band = { min_average_badge: tier * 10 + 1, max_average_badge: tier * 10 + 6 };
  const heroIds = top.map((t) => t.hero_id).join(",");
  type Bucket = Record<string, MV> & { bucket?: number };
  const [bracket, bracketH, own, ownH] = await Promise.all([
    api.get<Bucket>(path, band, 6 * 3600),
    heroIds ? api.get<Bucket[]>(path, { ...band, bucket: "hero", hero_ids: heroIds }, 6 * 3600) : Promise.resolve([] as Bucket[]),
    api.get<Bucket>(path, { account_ids: id, min_unix_timestamp: since }, 3600),
    heroIds ? api.get<Bucket[]>(path, { account_ids: id, min_unix_timestamp: since, bucket: "hero", hero_ids: heroIds }, 3600) : Promise.resolve([] as Bucket[]),
  ]);
  const group = (label: string, hero_id: number | null, mine: Bucket | undefined, them: Bucket | undefined, games?: number) => ({ label, hero_id, games,
    metrics: BENCH.map((b) => { const you = mine?.[b.key]?.percentile50, ref = them?.[b.key]; if (you == null || !Number.isFinite(you) || !ref) return null; const at = placeIn(you, ref); if (at == null) return null;
      return { ...b, you, median: ref.percentile50, p25: ref.percentile25, p75: ref.percentile75, pct: Math.round(b.lower ? 100 - at : at) }; }).filter(Boolean) });
  const groups = [group("Overall", null, own, bracket), ...top.map((t) => group("", t.hero_id, ownH.find((b) => b.bucket === t.hero_id), bracketH.find((b) => b.bucket === t.hero_id), t.n))].filter((g) => g.metrics.length);
  return c.json({ rank: p.mmr_rank, tier, groups });
});

/** How a player's games unfold: their average souls/kills/deaths by game minute (player-performance-curve, 90 days)
 *  against typical games at their rank (or all ranks when unranked), plus where their souls come from and how their
 *  lanes go (souls lead at 15 min, lane-matchup-stats). */
r.get("/:id{[0-9]+}/curve", async (c) => {
  const id = Number(c.req.param("id")); const now = Math.floor(Date.now() / 1000);
  const p = await c.env.DB.prepare("SELECT mmr_rank FROM players WHERE account_id=?").bind(id).first<{ mmr_rank: number | null }>();
  const tier = p?.mmr_rank ? Math.floor(p.mmr_rank / 10) : null;
  const api = new DeadlockApi(c.env), path = "/v1/analytics/player-performance-curve";
  type Pt = Record<string, number> & { game_time: number };
  const band = tier ? { min_average_badge: tier * 10 + 1, max_average_badge: tier * 10 + 6 } : {};
  // (The per-player lane numbers that used to come from lane-matchup-stats were wrong: its account filter picks matches, not sides,
  //  so both duos of every lane were averaged together. The lane report now works from match records; see /lanes-raw.)
  const [you, ref] = await Promise.all([
    api.get<Pt[]>(path, { account_ids: id, resolution: 0, min_unix_timestamp: now - 90 * 86400 }, 3600),
    api.get<Pt[]>(path, { resolution: 0, ...band }, 12 * 3600),
  ]);
  const SRC = ["gold_player", "gold_lane_creep", "gold_neutral_creep", "gold_boss", "gold_treasure", "gold_breakable", "gold_assists", "gold_team_bonus", "gold_denied", "gold_death_loss"];
  const trim = (pts: Pt[]) => pts.filter((x) => x.game_time > 0 && x.game_time <= 2700).map((x) => ({ t: x.game_time, nw: Math.round(x.net_worth_avg), k: +x.kills_avg.toFixed(2), d: +x.deaths_avg.toFixed(2), a: +x.assists_avg.toFixed(2),
    src: Object.fromEntries(SRC.map((k) => [k, Math.round((x[`${k}_avg`] ?? 0) + (x[`${k}_orbs_avg`] ?? x[`${k}_orb_avg`] ?? 0))])) }));
  const lane = null;
  return c.json({ tier, you: trim(you), ref: trim(ref), lane });
});

/** Lane report source: this player's recent matches with every player's lane and soul curve. The page normally asks
 *  deadlock-api for this itself (it allows browser calls); this is the fallback when that fails. */
export const LANE_COLUMNS = "assigned_lane,stats.net_worth,stats.time_stamp_s,stats.kills,stats.deaths";
r.get("/:id{[0-9]+}/lanes-raw", async (c) => {
  const id = Number(c.req.param("id")), days = Math.max(7, Math.min(120, Number(c.req.query("days")) || 60));
  return c.json(await new DeadlockApi(c.env).get<unknown[]>("/v1/matches/metadata", { account_ids: id, limit: 200, order_by: "match_id", order_direction: "desc", min_unix_timestamp: Math.floor(Date.now() / 1000) - days * 86400,
    include_info: "true", game_mode: "normal", extra_player_columns: LANE_COLUMNS }, 1800));
});

/** One friend's profile: recent matches + per-hero breakdown + MMR history. */
r.get("/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  const player = await c.env.DB.prepare("SELECT * FROM players WHERE account_id=?").bind(id).first<Player>();
  if (!player) return c.json({ error: "not tracked" }, 404);
  const isBrawl = c.req.query("mode") === "brawl", only = isBrawl ? brawl() : std();
  const [matches, heroes, mmr, ingest] = await Promise.all([
    c.env.DB.prepare(`SELECT * FROM player_matches WHERE account_id=? AND ${only} ORDER BY start_time DESC LIMIT 50`).bind(id).all(),
    c.env.DB.prepare(
      `SELECT hero_id, COUNT(*) games, SUM(won) wins, AVG(kills) k, AVG(deaths) d, AVG(assists) a, SUM(kills) kills, SUM(deaths) deaths, SUM(assists) assists, AVG(hero_damage) dmg
         FROM player_matches WHERE account_id=? AND ${only} GROUP BY hero_id ORDER BY games DESC`
    ).bind(id).all(),
    // Rank history straight from Valve's after-match badge on each Ranked game (match_mode 4).
    c.env.DB.prepare("SELECT start_time ts, json_extract(raw, '$.ranked_display_badge') rank FROM player_matches WHERE account_id=? AND match_mode=4 AND json_extract(raw, '$.ranked_display_badge') > 0 ORDER BY start_time").bind(id).all<{ ts: number; rank: number }>(),
    new DeadlockApi(c.env).ingestStatus(id).catch(() => null),
  ]);
  // Coverage: of the newest 10 matches, how many have full stats upstream. This is the honest "is the uploader working" signal.
  const newest = (matches.results as { match_id: number }[]).slice(0, 10).map((m) => m.match_id);
  const withStats = await new DeadlockApi(c.env).matchesWithStats(newest).catch(() => null);
  const coverage = withStats ? { checked: newest.length, with_stats: newest.filter((i) => withStats.has(i)).length, missing: newest.filter((i) => !withStats.has(i)) } : null;
  // Score = rank as one number, 1 (Initiate 1) … 66 (Eternus 6); Eternus badges past 116 are capped like upstream does.
  const mmrPts = mmr.results.map((r) => { const b = Math.min(Number(r.rank), 116); return { ts: r.ts, rank: b, score: (Math.floor(b / 10) - 1) * 6 + (b % 10) }; });
  const rankedGames = await c.env.DB.prepare("SELECT COUNT(*) n FROM player_matches WHERE account_id=? AND match_mode=4").bind(id).first<number>("n");
  const brawlGames = await c.env.DB.prepare(`SELECT COUNT(*) n FROM player_matches WHERE account_id=? AND ${brawl()}`).bind(id).first<number>("n");
  return c.json({ player: { ...player, avatar_url: bigAvatar(player.avatar_url) }, mode: isBrawl ? "brawl" : "standard", brawl_games: brawlGames ?? 0, matches: matches.results, heroes: heroes.results, mmr: mmrPts, ranked_games: rankedGames ?? 0, ingest, coverage });
});

export default r;
