import { Hono } from "hono";
import type { Env } from "../types";
import { DeadlockApi } from "../deadlock";
import { STAT_MAP } from "./builds";

/**
 * Shared build library. Anyone signed in through Steam can create builds; everyone can see all of them;
 * only the author can edit or delete theirs (anyone can fork a copy).
 * `details` mirrors Valve's CMsgHeroBuild.details so builds can be synced into the game later.
 */
const r = new Hono<{ Bindings: Env }>();

export type ModCategory = { name: string; description?: string; mods: { ability_id: number; annotation?: string | null }[] };
export type Details = { mod_categories: ModCategory[] };
const DEFAULT_CATEGORIES = ["Early Game", "Mid Game", "Late Game", "Situational"];

import { accountOf } from "../auth";
const parse = (b: Record<string, unknown>) => ({ ...b, details: JSON.parse((b.details as string) || '{"mod_categories":[]}'), priorities: JSON.parse((b.priorities as string) || "{}"), items: JSON.parse((b.items as string) || "[]") });

function sanitize(d: unknown): Details {
  const cats = Array.isArray((d as Details)?.mod_categories) ? (d as Details).mod_categories : [];
  return {
    mod_categories: cats.slice(0, 8).map((c) => ({
      name: String(c?.name ?? "").slice(0, 40) || "Items",
      description: c?.description ? String(c.description).slice(0, 300) : undefined,
      mods: (Array.isArray(c?.mods) ? c.mods : []).slice(0, 40).map((m) => ({ ability_id: Number(m.ability_id), annotation: m.annotation ? String(m.annotation).slice(0, 200) : null })).filter((m) => m.ability_id > 0),
    })),
  };
}

/** All shop items for the editor's picker (cached asset, trimmed). */
r.get("/items", async (c) => {
  const all = await new DeadlockApi(c.env).items();
  // Normalised 0..1 strength per stat group (see STAT_MAP), so the UI can filter and rank by "more spirit", "more ammo", …
  const raw = all.map((i) => Object.fromEntries(Object.entries(STAT_MAP).map(([k, def]) => [k, def.keys.reduce((a, key) => a + (i.properties[key] ?? 0), 0)])));
  const max: Record<string, number> = {}; for (const r of raw) for (const [k, v] of Object.entries(r)) max[k] = Math.max(max[k] ?? 0, v);
  return c.json(all.map((i, n) => ({ id: i.id, name: i.name, class_name: i.class_name, slot: i.item_slot_type, tier: i.item_tier, cost: i.cost, image: i.image, heroes: i.heroes, active: i.is_active_item, activation: i.activation, components: i.component_items, description: i.description, stats: i.stats,
    leans: Object.fromEntries(Object.entries(raw[n]).filter(([, v]) => v > 0).map(([k, v]) => [k, +(v / (max[k] || 1)).toFixed(3)])) })));
});
r.get("/retired", async (c) => c.json(await new DeadlockApi(c.env).retiredItems()));

r.get("/stat-groups", (c) => c.json(Object.entries(STAT_MAP).map(([id, s]) => ({ id, label: s.label }))));

r.get("/categories", (c) => c.json(DEFAULT_CATEGORIES));

/** Library listing. ?hero_id= ?account_id= */
r.get("/", async (c) => {
  const hero = c.req.query("hero_id"), author = c.req.query("account_id");
  const clauses: string[] = [], binds: number[] = [];
  if (hero) { clauses.push("b.hero_id=?"); binds.push(Number(hero)); }
  if (author) { clauses.push("b.account_id=?"); binds.push(Number(author)); }
  const where = clauses.join(" AND ");
  const { results } = await c.env.DB.prepare(
    `SELECT b.id, b.hero_id, b.title, b.description, b.author, b.account_id, b.votes, b.created_at, b.updated_at, b.ingame_build_id, b.ingame_version, b.sync_wanted, b.synced_at, b.sync_error, b.forked_from, b.details,
            p.name AS author_name, p.avatar_url AS author_avatar
       FROM builds b LEFT JOIN players p ON p.account_id=b.account_id
      ${where ? "WHERE " + where : ""} ORDER BY b.updated_at DESC, b.created_at DESC LIMIT 200`
  ).bind(...binds).all();
  return c.json(results.map((b) => { const d = JSON.parse((b.details as string) || '{"mod_categories":[]}') as Details; return { ...b, details: undefined, item_count: d.mod_categories.reduce((n, cat) => n + cat.mods.length, 0), preview: d.mod_categories.flatMap((cat) => cat.mods.map((m) => m.ability_id)).slice(0, 12) }; }));
});

type GameBuild = { hero_build: { hero_build_id: number; hero_id: number; name: string; description?: string; author_account_id: number; version?: number; last_updated_timestamp?: number; details?: { mod_categories?: ModCategory[] } } };

/** When this account's uploader last asked for builds to publish. Only the Soul Scribe uploader asks, so this tells the site whether "send to game" can work. */
r.get("/sync-status", async (c) => {
  const me = accountOf(c);
  return c.json({ uploader_seen: me ? Number(await c.env.CACHE.get(`buildsync:${me}`)) || null : null });
});

/** Builds I published in the game (deadlock-api, by author), matched against my Soul Scribe builds. */
r.get("/ingame", async (c) => {
  const me = accountOf(c);
  if (!me) return c.json({ error: "Sign in through Steam to see your in-game builds" }, 401);
  const [rows, mine] = await Promise.all([
    new DeadlockApi(c.env).get<GameBuild[]>(`/v1/builds`, { author_id: me, only_latest: "true", limit: 100, sort_by: "updated_at", sort_direction: "desc" }, 120),
    c.env.DB.prepare("SELECT id, ingame_build_id, ingame_version FROM builds WHERE account_id=? AND ingame_build_id IS NOT NULL").bind(me).all<{ id: number; ingame_build_id: number; ingame_version: number | null }>(),
  ]);
  const linked = new Map(mine.results.map((b) => [b.ingame_build_id, b]));
  return c.json(rows.map(({ hero_build: g }) => { const local = linked.get(g.hero_build_id); const mods = (g.details?.mod_categories ?? []).flatMap((cat) => (cat.mods ?? []).map((m) => m.ability_id));
    return { ingame_build_id: g.hero_build_id, hero_id: g.hero_id, name: g.name, version: g.version ?? 1, updated_at: g.last_updated_timestamp ?? null, item_count: mods.length, preview: mods.slice(0, 10),
      local_id: local?.id ?? null, state: !local ? "new" : (g.version ?? 1) > (local.ingame_version ?? 0) ? "update" : "imported" }; }));
});

r.get("/:id", async (c) => {
  const b = await c.env.DB.prepare("SELECT b.*, p.name AS author_name FROM builds b LEFT JOIN players p ON p.account_id=b.account_id WHERE b.id=?").bind(Number(c.req.param("id"))).first<Record<string, unknown>>();
  return b ? c.json(parse(b)) : c.json({ error: "not found" }, 404);
});

/** Create. Body: { hero_id, title, description?, details, forked_from? }. Needs Steam sign-in. */
r.post("/", async (c) => {
  const me = accountOf(c);
  if (!me) return c.json({ error: "Sign in through Steam to save builds" }, 401);
  const b = await c.req.json<{ hero_id: number; title: string; description?: string; details: unknown; forked_from?: number }>();
  if (!b.hero_id || !b.title?.trim()) return c.json({ error: "hero and title required" }, 400);
  const player = await c.env.DB.prepare("SELECT name FROM players WHERE account_id=?").bind(me).first<{ name: string }>();
  const now = Math.floor(Date.now() / 1000);
  const res = await c.env.DB.prepare(
    "INSERT INTO builds(hero_id, author, account_id, title, description, priorities, items, details, updated_at, forked_from) VALUES (?,?,?,?,?,'{}','[]',?,?,?)"
  ).bind(b.hero_id, player?.name ?? String(me), me, b.title.trim().slice(0, 60), (b.description ?? "").slice(0, 500), JSON.stringify(sanitize(b.details)), now, b.forked_from ?? null).run();
  return c.json({ ok: true, id: res.meta.last_row_id });
});

/**
 * Bring an in-game build into my builds: { ingame_build_id, hero_id? }.
 * Someone else's build is copied. One I published myself is linked to its in-game original (so "send to game" later updates
 * that build instead of making a second one); importing it again refreshes the linked copy from the game.
 */
r.post("/import", async (c) => {
  const me = accountOf(c);
  if (!me) return c.json({ error: "Sign in through Steam to save builds" }, 401);
  const b = await c.req.json<{ hero_id?: number; ingame_build_id: number }>();
  if (!Number(b.ingame_build_id)) return c.json({ error: "build id required" }, 400);
  const rows = await new DeadlockApi(c.env).get<GameBuild[]>(`/v1/builds`, { build_id: Number(b.ingame_build_id), only_latest: "true", limit: 1 }, 120);
  const src = rows[0]?.hero_build; if (!src) return c.json({ error: "build not found" }, 404);
  const player = await c.env.DB.prepare("SELECT name FROM players WHERE account_id=?").bind(me).first<{ name: string }>();
  const known = new Set((await new DeadlockApi(c.env).items()).map((i) => i.id));
  const details = sanitize({ mod_categories: (src.details?.mod_categories ?? []).map((cat) => ({ name: (cat.name || "").trim() || "Items", description: cat.description, mods: cat.mods.filter((m) => known.has(m.ability_id)) })).filter((cat) => cat.mods.length) });
  const heroId = src.hero_id || Number(b.hero_id); if (!heroId) return c.json({ error: "hero required" }, 400);
  const now = Math.floor(Date.now() / 1000);
  if (src.author_account_id === me) {
    const title = (src.name || "In-game build").slice(0, 60), desc = (src.description ?? "").slice(0, 500), version = src.version ?? 1;
    const existing = await c.env.DB.prepare("SELECT id FROM builds WHERE account_id=? AND ingame_build_id=?").bind(me, src.hero_build_id).first<{ id: number }>();
    if (existing) {
      await c.env.DB.prepare("UPDATE builds SET hero_id=?, title=?, description=?, details=?, ingame_version=?, updated_at=?, synced_at=?, sync_error=NULL WHERE id=?").bind(heroId, title, desc, JSON.stringify(details), version, now, now, existing.id).run();
      return c.json({ ok: true, id: existing.id, updated: true });
    }
    const own = await c.env.DB.prepare("INSERT INTO builds(hero_id, author, account_id, title, description, priorities, items, details, updated_at, ingame_build_id, ingame_version, synced_at) VALUES (?,?,?,?,?,'{}','[]',?,?,?,?,?)")
      .bind(heroId, player?.name ?? String(me), me, title, desc, JSON.stringify(details), now, src.hero_build_id, version, now).run();
    return c.json({ ok: true, id: own.meta.last_row_id, linked: true });
  }
  const res = await c.env.DB.prepare("INSERT INTO builds(hero_id, author, account_id, title, description, priorities, items, details, updated_at) VALUES (?,?,?,?,?,'{}','[]',?,?)")
    .bind(heroId, player?.name ?? String(me), me, src.name.slice(0, 60), `Copied from in-game build #${src.hero_build_id} by ${src.author_account_id}. ${(src.description ?? "").slice(0, 400)}`.trim(), JSON.stringify(details), now).run();
  return c.json({ ok: true, id: res.meta.last_row_id });
});

/** Author toggles "send to my in-game builds". The uploader on their PC does the publishing (see /api/sync/builds). */
r.post("/:id/sync", async (c) => {
  const me = accountOf(c); const id = Number(c.req.param("id"));
  const owner = await c.env.DB.prepare("SELECT account_id FROM builds WHERE id=?").bind(id).first<{ account_id: number | null }>();
  if (!owner) return c.json({ error: "not found" }, 404);
  if (!me || owner.account_id !== me) return c.json({ error: "Only the author can sync this build to their game (fork it first)" }, 403);
  const b = await c.req.json<{ wanted: boolean }>();
  await c.env.DB.prepare("UPDATE builds SET sync_wanted=?, sync_error=NULL, synced_at=CASE WHEN ? THEN synced_at ELSE NULL END WHERE id=?").bind(b.wanted ? 1 : 0, b.wanted ? 1 : 0, id).run();
  return c.json({ ok: true, wanted: !!b.wanted });
});

r.put("/:id", async (c) => {
  const me = accountOf(c);
  const id = Number(c.req.param("id"));
  const owner = await c.env.DB.prepare("SELECT account_id FROM builds WHERE id=?").bind(id).first<{ account_id: number | null }>();
  if (!owner) return c.json({ error: "not found" }, 404);
  if (!me || owner.account_id !== me) return c.json({ error: "Only the author can edit this build (fork it instead)" }, 403);
  const b = await c.req.json<{ title?: string; description?: string; details?: unknown; hero_id?: number }>();
  await c.env.DB.prepare("UPDATE builds SET title=COALESCE(?,title), description=COALESCE(?,description), details=COALESCE(?,details), hero_id=COALESCE(?,hero_id), updated_at=? WHERE id=?")
    .bind(b.title?.trim().slice(0, 60) ?? null, b.description?.slice(0, 500) ?? null, b.details ? JSON.stringify(sanitize(b.details)) : null, b.hero_id ?? null, Math.floor(Date.now() / 1000), id).run();
  return c.json({ ok: true });
});

r.delete("/:id", async (c) => {
  const me = accountOf(c);
  const id = Number(c.req.param("id"));
  const owner = await c.env.DB.prepare("SELECT account_id FROM builds WHERE id=?").bind(id).first<{ account_id: number | null }>();
  if (!owner) return c.json({ error: "not found" }, 404);
  if (!me || owner.account_id !== me) return c.json({ error: "Only the author can delete this build" }, 403);
  // Removes the Soul Scribe copy only. Nothing tells the game to unpublish: a build already sent to (or imported from) the in-game menu stays there.
  await c.env.DB.prepare("DELETE FROM builds WHERE id=?").bind(id).run();
  return c.json({ ok: true });
});

r.post("/:id/vote", async (c) => { await c.env.DB.prepare("UPDATE builds SET votes=votes+1 WHERE id=?").bind(Number(c.req.param("id"))).run(); return c.json({ ok: true }); });

export default r;
