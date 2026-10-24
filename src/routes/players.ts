import { Hono } from "hono";
import type { Env, Player } from "../types";
import { DeadlockApi } from "../deadlock";
import { bigAvatar } from "../deadlock";

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
            MAX(m.start_time)                       AS last_played
       FROM players p
       LEFT JOIN player_matches m ON m.account_id=p.account_id AND m.start_time>=?
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
      WHERE a.start_time>=? GROUP BY a.account_id, b.account_id ORDER BY games DESC, wins DESC`).bind(since).all();
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
/** One friend's profile: recent matches + per-hero breakdown + MMR history. */
r.get("/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  const player = await c.env.DB.prepare("SELECT * FROM players WHERE account_id=?").bind(id).first<Player>();
  if (!player) return c.json({ error: "not tracked" }, 404);
  const [matches, heroes, mmr, ingest] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM player_matches WHERE account_id=? ORDER BY start_time DESC LIMIT 50").bind(id).all(),
    c.env.DB.prepare(
      `SELECT hero_id, COUNT(*) games, SUM(won) wins, AVG(kills) k, AVG(deaths) d, AVG(assists) a, SUM(kills) kills, SUM(deaths) deaths, SUM(assists) assists
         FROM player_matches WHERE account_id=? GROUP BY hero_id ORDER BY games DESC`
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
  return c.json({ player: { ...player, avatar_url: bigAvatar(player.avatar_url) }, matches: matches.results, heroes: heroes.results, mmr: mmrPts, ranked_games: rankedGames ?? 0, ingest, coverage });
});

export default r;
