import { Hono } from "hono";
import type { Env } from "../types";
import { DeadlockApi } from "../deadlock";

const r = new Hono<{ Bindings: Env }>();
r.use("/:id/*", async (c, next) => { if (c.req.param("id") && !/^\d+$/.test(c.req.param("id")!)) return c.json({ error: "bad_request", message: "hero id must be numeric" }, 400); await next(); });

/** Hero list (static assets) — names, images. */
r.get("/", async (c) => {
  const heroes = await new DeadlockApi(c.env).heroes();
  return c.json(heroes.filter((h) => h.player_selectable !== false && !h.disabled && !h.in_development).sort((a, b) => a.name.localeCompare(b.name)));
});

/** Win/pick rates. Query passthrough: ?min_average_badge=&max_average_badge=&min_unix_timestamp= */
r.get("/stats", async (c) => {
  const api = new DeadlockApi(c.env);
  const q = Object.fromEntries(new URL(c.req.url).searchParams);
  const [stats, heroes] = await Promise.all([api.heroStats(q), api.heroes()]);
  const names = new Map(heroes.map((h) => [h.id, h.name]));
  const total = stats.reduce((s, h) => s + h.matches, 0);
  return c.json(
    stats
      .map((h) => ({ hero_id: h.hero_id, name: names.get(h.hero_id) ?? String(h.hero_id), matches: h.matches, wins: h.wins,
        win_rate: h.matches ? h.wins / h.matches : 0, pick_rate: total ? (h.matches * 6) / total : 0 }))
      .sort((a, b) => b.win_rate - a.win_rate)
  );
});

/**
 * Pick suggester. Given allies (your team so far) and enemies, rank every hero by
 *   score = mean(synergy win rate with each ally) + mean(counter win rate vs each enemy)
 * ?allies=1,2&enemies=5,6&min_matches=200
 */
r.get("/suggest", async (c) => {
  const api = new DeadlockApi(c.env);
  const parse = (s?: string) => (s ? s.split(",").map(Number).filter(Boolean) : []);
  const allies = parse(c.req.query("allies"));
  const enemies = parse(c.req.query("enemies"));
  const minMatches = Number(c.req.query("min_matches") ?? 100);
  const q = { min_unix_timestamp: c.req.query("min_unix_timestamp") };

  const [synergy, counter, heroes] = await Promise.all([api.heroSynergyStats(q), api.heroCounterStats(q), api.heroes()]);

  // Synergy rows are symmetric pairs (hero_id, hero_id2). Counter rows are (hero_id vs enemy_id).
  const syn = new Map<string, number>();
  for (const s of synergy) {
    if (s.matches_played < minMatches) continue;
    const wr = s.wins / s.matches_played;
    syn.set(`${s.hero_id1}:${s.hero_id2}`, wr);
    syn.set(`${s.hero_id2}:${s.hero_id1}`, wr);
  }
  const ctr = new Map<string, number>();
  for (const s of counter) if (s.matches_played >= minMatches) ctr.set(`${s.hero_id}:${s.enemy_hero_id}`, s.wins / s.matches_played);

  const taken = new Set([...allies, ...enemies]);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0.5);
  const out = heroes
    .filter((h) => h.player_selectable !== false && !h.disabled && !taken.has(h.id))
    .map((h) => {
      const synWr = allies.map((a) => syn.get(`${h.id}:${a}`)).filter((x): x is number => x !== undefined);
      const ctrWr = enemies.map((e) => ctr.get(`${h.id}:${e}`)).filter((x): x is number => x !== undefined);
      return { hero_id: h.id, name: h.name, synergy: avg(synWr), counter: avg(ctrWr),
        score: (avg(synWr) - 0.5) + (avg(ctrWr) - 0.5), samples: synWr.length + ctrWr.length };
    })
    .sort((a, b) => b.score - a.score);
  return c.json({ allies, enemies, suggestions: out });
});

/** Squad members' record on this hero, from our D1 copy (one query instead of one per player). */
r.get("/:id/squad", async (c) => {
  const id = Number(c.req.param("id"));
  const { results } = await c.env.DB.prepare(
    `SELECT p.account_id, p.name, p.avatar_url, p.mmr_rank, COUNT(*) games, SUM(m.won) wins, AVG(m.kills) k, AVG(m.deaths) d, AVG(m.assists) a,
            AVG(m.net_worth*60.0/NULLIF(m.duration_s,0)) spm, MAX(m.start_time) last_played
       FROM player_matches m JOIN players p ON p.account_id=m.account_id WHERE m.hero_id=? GROUP BY p.account_id ORDER BY games DESC`).bind(id).all();
  return c.json(results);
});

/**
 * "Squad's best build" for a hero: for each squad build, look at the squad's recent matches on this hero and
 * score how often the final item set overlapped with the build. Cheap, honest, and improves as data accrues.
 */
r.get("/:id/best-build", async (c) => {
  const id = Number(c.req.param("id"));
  const [{ results: builds }, { results: metas }] = await Promise.all([
    c.env.DB.prepare("SELECT b.id, b.title, b.details, b.account_id, p.name author_name FROM builds b LEFT JOIN players p ON p.account_id=b.account_id WHERE b.hero_id=?").bind(id).all<{ id: number; title: string; details: string; account_id: number; author_name: string | null }>(),
    c.env.DB.prepare("SELECT mm.json, pm.account_id, pm.won FROM player_matches pm JOIN match_meta mm ON mm.match_id=pm.match_id WHERE pm.hero_id=? ORDER BY pm.start_time DESC LIMIT 60").bind(id).all<{ json: string; account_id: number; won: number }>(),
  ]);
  if (!builds.length) return c.json(null);
  const games = metas.map((m) => { const mi = JSON.parse(m.json).match_info; const me = mi?.players?.find((p: { account_id: number }) => p.account_id === m.account_id); const held = new Set<number>();
    for (const it of me?.items ?? []) if (it.sold_time_s) held.delete(it.item_id); else held.add(it.item_id); return { held, won: !!m.won }; });
  const scored = builds.map((b) => { const ids = new Set<number>(); try { for (const cat of JSON.parse(b.details).mod_categories ?? []) for (const m of cat.mods ?? []) ids.add(m.ability_id); } catch {}
    let used = 0, wins = 0; for (const g of games) { const overlap = [...ids].filter((x) => g.held.has(x)).length; if (ids.size && overlap / ids.size >= 0.5) { used++; if (g.won) wins++; } }
    return { id: b.id, title: b.title, author_name: b.author_name, items: ids.size, games_using: used, wins_using: wins, win_rate: used ? wins / used : null }; })
    .sort((a, b) => (b.games_using - a.games_using) || ((b.win_rate ?? 0) - (a.win_rate ?? 0)));
  return c.json({ sample_games: games.length, builds: scored });
});

/** The hero's four abilities (icons, descriptions, tiers, numbers). */
r.get("/:id/abilities", async (c) => c.json(await new DeadlockApi(c.env).heroAbilities(Number(c.req.param("id")))));

/** Top community builds for a hero straight from the in-game build library. */
r.get("/:id/builds", async (c) => {
  const id = Number(c.req.param("id"));
  const rows = await new DeadlockApi(c.env).get<{ hero_build: { hero_build_id: number; name: string; author_account_id: number; description?: string; last_updated_timestamp: number; details?: { mod_categories?: { name: string; mods: { ability_id: number }[] }[] } }; num_favorites?: number; num_weekly_favorites?: number }[]>(
    `/v1/builds`, { hero_id: id, limit: 8, sort_by: "weekly_favorites", sort_direction: "desc", only_latest: "true" }, 3600);
  return c.json(rows.map((b) => ({ id: b.hero_build.hero_build_id, name: b.hero_build.name, author: b.hero_build.author_account_id, favorites: b.num_favorites ?? 0, weekly: b.num_weekly_favorites ?? 0,
    updated: b.hero_build.last_updated_timestamp, categories: (b.hero_build.details?.mod_categories ?? []).map((cat) => ({ name: cat.name, items: cat.mods.map((m) => m.ability_id) })) })));
});

/** Raw counter/synergy tables for one hero — for the "who beats X" page. */
r.get("/:id/matchups", async (c) => {
  const id = Number(c.req.param("id"));
  const api = new DeadlockApi(c.env);
  const [synergy, counter, heroes] = await Promise.all([api.heroSynergyStats(), api.heroCounterStats(), api.heroes()]);
  const names = new Map(heroes.map((h) => [h.id, h.name]));
  const counters = counter.filter((s) => s.hero_id === id).map((s) => ({ hero_id: s.enemy_hero_id, name: names.get(s.enemy_hero_id), win_rate: s.wins / s.matches_played, matches: s.matches_played }));
  const synergies = synergy.filter((s) => s.hero_id1 === id || s.hero_id2 === id).map((s) => {
    const other = s.hero_id1 === id ? s.hero_id2 : s.hero_id1;
    return { hero_id: other, name: names.get(other), win_rate: s.wins / s.matches_played, matches: s.matches_played };
  });
  return c.json({ hero_id: id, name: names.get(id), counters: counters.sort((a, b) => a.win_rate - b.win_rate), synergies: synergies.sort((a, b) => b.win_rate - a.win_rate) });
});

export default r;
