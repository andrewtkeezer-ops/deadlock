import { Hono } from "hono";
import type { Env } from "../types";
import { DeadlockApi } from "../deadlock";
import { getSetting, setSetting } from "../settings";

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

/**
 * Danger zones opens on "everyone, last 7 days". Upstream computes that on demand in about 6 seconds, so the cron keeps
 * a copy: the response body is piped straight into KV without being parsed (2-3 MB of JSON would not fit in a free
 * Worker's CPU budget), and this route pipes it back out. One KV write an hour.
 */
const MAP_KEY = "map:7d", MAP_TTL = 55 * 60;
export async function refreshMapSnapshot(env: Env, force = false): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000), meta = await getSetting<{ at: number }>(env, "map_snapshot");
  if (!force && meta?.at && now - meta.at < MAP_TTL) return false;
  const since = Math.floor(now / 3600) * 3600 - 7 * 86400;
  const headers: Record<string, string> = { accept: "application/json", "user-agent": "deadlock-squad/0.1 (cloudflare worker)" }; if (env.DEADLOCK_API_KEY) headers["X-API-Key"] = env.DEADLOCK_API_KEY;
  const res = await fetch(new URL(`/v1/analytics/kill-death-stats?min_unix_timestamp=${since}`, env.DEADLOCK_API), { headers });
  if (!res.ok || !res.body) { await res.body?.cancel(); throw new Error(`map snapshot: upstream ${res.status}`); }
  await env.CACHE.put(MAP_KEY, res.body, { metadata: { at: now, since } });
  await setSetting(env, "map_snapshot", { at: now, since });
  return true;
}
r.get("/heatmap-snapshot", async (c) => {
  const { value, metadata } = await c.env.CACHE.getWithMetadata<{ at: number; since: number }>(MAP_KEY, "stream");
  if (!value) return c.json({ error: "no snapshot yet" }, 404);
  return new Response(value, { headers: { "content-type": "application/json", "cache-control": "private, max-age=300", "x-snapshot-at": String(metadata?.at ?? 0) } });
});

export default r;
