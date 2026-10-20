import { Hono } from "hono";
import type { Env } from "../types";
import { DeadlockApi } from "../deadlock";

const r = new Hono<{ Bindings: Env }>();

/**
 * Kill/death locations on a 128x128 raster.
 * ?hero_id=&min_unix_timestamp=&max_match_duration_s=&min_average_badge=...
 * Not "predictive" — it's where players of this hero actually die. The frontend renders it over the map.
 */
r.get("/heatmap", async (c) => {
  const raw = Object.fromEntries(new URL(c.req.url).searchParams);
  // Upstream names: hero_ids (comma list), max_game_time_s, account_ids. Accept our older names too.
  const q: Record<string, string | undefined> = { ...raw };
  if (raw.hero_id) { q.hero_ids = raw.hero_id; delete q.hero_id; }
  if (raw.max_match_duration_s) { q.max_game_time_s = raw.max_match_duration_s; delete q.max_match_duration_s; }
  if (raw.squad === "1") { const { results } = await c.env.DB.prepare("SELECT account_id FROM players").all<{ account_id: number }>(); q.account_ids = results.map((r) => r.account_id).join(","); delete q.squad; }
  const cells = await new DeadlockApi(c.env).killDeathStats(q);
  let maxK = 0, maxD = 0, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const cell of cells) {
    maxK = Math.max(maxK, cell.kills); maxD = Math.max(maxD, cell.deaths);
    minX = Math.min(minX, cell.position_x); maxX = Math.max(maxX, cell.position_x);
    minY = Math.min(minY, cell.position_y); maxY = Math.max(maxY, cell.position_y);
  }
  // Collapse killer_team so each grid cell appears once.
  const merged = new Map<string, { x: number; y: number; kills: number; deaths: number }>();
  for (const cell of cells) {
    const k = `${cell.position_x}:${cell.position_y}`; const m = merged.get(k) ?? { x: cell.position_x, y: cell.position_y, kills: 0, deaths: 0 };
    m.kills += cell.kills; m.deaths += cell.deaths; merged.set(k, m);
  }
  return c.json({ step: 128, bounds: { minX, maxX, minY, maxY }, maxKills: maxK, maxDeaths: maxD, cells: [...merged.values()] });
});

/** Item win/pick rates for a hero. ?hero_id=&min_average_badge= */
r.get("/items", async (c) => {
  const api = new DeadlockApi(c.env);
  const q = Object.fromEntries(new URL(c.req.url).searchParams);
  const [stats, items] = await Promise.all([api.itemStats(q), api.items()]);
  const byId = new Map(items.map((i) => [i.id, i]));
  return c.json(
    stats
      .filter((s) => byId.has(s.item_id))
      .map((s) => {
        const it = byId.get(s.item_id)!;
        return { item_id: s.item_id, name: it.name, slot: it.item_slot_type, tier: it.item_tier, cost: it.cost, image: it.image,
          matches: s.matches, wins: s.wins, win_rate: s.matches ? s.wins / s.matches : 0 };
      })
      .sort((a, b) => b.matches - a.matches)
  );
});

export default r;
