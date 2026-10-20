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
      ORDER BY p.mmr_score DESC NULLS LAST, wins DESC`
  ).bind(since).all();
  return c.json({ days, players: results.map((p) => ({ ...p, avatar_url: bigAvatar(p.avatar_url as string | null) })) });
});

r.get("/", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT account_id, name, avatar_url, last_sync_at, mmr_score, mmr_rank FROM players ORDER BY name").all<Player>();
  return c.json(results.map((p) => ({ ...p, avatar_url: bigAvatar(p.avatar_url) })));
});

/** One friend's profile: recent matches + per-hero breakdown + MMR history. */
r.get("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const player = await c.env.DB.prepare("SELECT * FROM players WHERE account_id=?").bind(id).first<Player>();
  if (!player) return c.json({ error: "not tracked" }, 404);
  const [matches, heroes, mmr, ingest] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM player_matches WHERE account_id=? ORDER BY start_time DESC LIMIT 50").bind(id).all(),
    c.env.DB.prepare(
      `SELECT hero_id, COUNT(*) games, SUM(won) wins, AVG(kills) k, AVG(deaths) d, AVG(assists) a, SUM(kills) kills, SUM(deaths) deaths, SUM(assists) assists
         FROM player_matches WHERE account_id=? GROUP BY hero_id ORDER BY games DESC`
    ).bind(id).all(),
    c.env.DB.prepare("SELECT ts, score, rank FROM mmr_history WHERE account_id=? ORDER BY ts").bind(id).all(),
    new DeadlockApi(c.env).ingestStatus(id).catch(() => null),
  ]);
  return c.json({ player: { ...player, avatar_url: bigAvatar(player.avatar_url) }, matches: matches.results, heroes: heroes.results, mmr: mmr.results, ingest });
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

export default r;
