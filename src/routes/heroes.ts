import { Hono } from "hono";
import type { Env } from "../types";
import { DeadlockApi } from "../deadlock";

const r = new Hono<{ Bindings: Env }>();

/** Hero list (static assets) — names, images. */
r.get("/", async (c) => {
  const heroes = await new DeadlockApi(c.env).heroes();
  return c.json(heroes.filter((h) => h.player_selectable !== false && !h.disabled).map((h) => ({ id: h.id, name: h.name, images: h.images })));
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
    syn.set(`${s.hero_id}:${s.hero_id2}`, wr);
    syn.set(`${s.hero_id2}:${s.hero_id}`, wr);
  }
  const ctr = new Map<string, number>();
  for (const s of counter) if (s.matches_played >= minMatches) ctr.set(`${s.hero_id}:${s.enemy_id}`, s.wins / s.matches_played);

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

/** Raw counter/synergy tables for one hero — for the "who beats X" page. */
r.get("/:id/matchups", async (c) => {
  const id = Number(c.req.param("id"));
  const api = new DeadlockApi(c.env);
  const [synergy, counter, heroes] = await Promise.all([api.heroSynergyStats(), api.heroCounterStats(), api.heroes()]);
  const names = new Map(heroes.map((h) => [h.id, h.name]));
  const counters = counter.filter((s) => s.hero_id === id).map((s) => ({ hero_id: s.enemy_id, name: names.get(s.enemy_id!), win_rate: s.wins / s.matches_played, matches: s.matches_played }));
  const synergies = synergy.filter((s) => s.hero_id === id || s.hero_id2 === id).map((s) => {
    const other = s.hero_id === id ? s.hero_id2! : s.hero_id;
    return { hero_id: other, name: names.get(other), win_rate: s.wins / s.matches_played, matches: s.matches_played };
  });
  return c.json({ hero_id: id, name: names.get(id), counters: counters.sort((a, b) => a.win_rate - b.win_rate), synergies: synergies.sort((a, b) => b.win_rate - a.win_rate) });
});

export default r;
