import { Hono } from "hono";
import type { Env } from "../types";
import { DeadlockApi } from "../deadlock";

/**
 * Shared build library. Anyone signed in through Steam can create builds; everyone can see all of them;
 * only the author can edit or delete theirs (anyone can fork a copy).
 * `details` mirrors Valve's CMsgHeroBuild.details so builds can be synced into the game later.
 */
const r = new Hono<{ Bindings: Env }>();

export type ModCategory = { name: string; description?: string; mods: { ability_id: number; annotation?: string | null }[] };
export type Details = { mod_categories: ModCategory[] };
const DEFAULT_CATEGORIES = ["Early Game", "Mid Game", "Late Game", "Situational"];

const steamId = (cookie?: string) => { const m = /squad_steam=(\d+)/.exec(cookie ?? ""); return m ? Number(m[1]) : null; };
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
r.get("/items", async (c) => c.json((await new DeadlockApi(c.env).items()).map((i) => ({ id: i.id, name: i.name, class_name: i.class_name, slot: i.item_slot_type, tier: i.item_tier, cost: i.cost, image: i.image, heroes: i.heroes, active: i.is_active_item, activation: i.activation, components: i.component_items, description: i.description, stats: i.stats }))));

r.get("/categories", (c) => c.json(DEFAULT_CATEGORIES));

/** Library listing. ?hero_id= ?account_id= */
r.get("/", async (c) => {
  const hero = c.req.query("hero_id"), author = c.req.query("account_id");
  const clauses: string[] = [], binds: number[] = [];
  if (hero) { clauses.push("b.hero_id=?"); binds.push(Number(hero)); }
  if (author) { clauses.push("b.account_id=?"); binds.push(Number(author)); }
  const where = clauses.join(" AND ");
  const { results } = await c.env.DB.prepare(
    `SELECT b.id, b.hero_id, b.title, b.description, b.author, b.account_id, b.votes, b.created_at, b.updated_at, b.ingame_build_id, b.forked_from, b.details,
            p.name AS author_name, p.avatar_url AS author_avatar
       FROM builds b LEFT JOIN players p ON p.account_id=b.account_id
      ${where ? "WHERE " + where : ""} ORDER BY b.updated_at DESC, b.created_at DESC LIMIT 200`
  ).bind(...binds).all();
  return c.json(results.map((b) => { const d = JSON.parse((b.details as string) || '{"mod_categories":[]}') as Details; return { ...b, details: undefined, item_count: d.mod_categories.reduce((n, cat) => n + cat.mods.length, 0), preview: d.mod_categories.flatMap((cat) => cat.mods.map((m) => m.ability_id)).slice(0, 12) }; }));
});

r.get("/:id", async (c) => {
  const b = await c.env.DB.prepare("SELECT b.*, p.name AS author_name FROM builds b LEFT JOIN players p ON p.account_id=b.account_id WHERE b.id=?").bind(Number(c.req.param("id"))).first<Record<string, unknown>>();
  return b ? c.json(parse(b)) : c.json({ error: "not found" }, 404);
});

/** Create. Body: { hero_id, title, description?, details, forked_from? }. Needs Steam sign-in. */
r.post("/", async (c) => {
  const me = steamId(c.req.header("cookie"));
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

/** Copy an in-game library build into my builds: { hero_id, ingame_build_id }. */
r.post("/import", async (c) => {
  const me = steamId(c.req.header("cookie"));
  if (!me) return c.json({ error: "Sign in through Steam to save builds" }, 401);
  const b = await c.req.json<{ hero_id: number; ingame_build_id: number }>();
  const rows = await new DeadlockApi(c.env).get<{ hero_build: { hero_build_id: number; name: string; description?: string; author_account_id: number; details?: { mod_categories?: ModCategory[] } } }[]>(`/v1/builds`, { build_id: b.ingame_build_id, only_latest: "true", limit: 1 }, 3600);
  const src = rows[0]?.hero_build; if (!src) return c.json({ error: "build not found" }, 404);
  const player = await c.env.DB.prepare("SELECT name FROM players WHERE account_id=?").bind(me).first<{ name: string }>();
  const details = sanitize({ mod_categories: (src.details?.mod_categories ?? []).map((cat) => ({ name: cat.name, description: cat.description, mods: cat.mods })) });
  const res = await c.env.DB.prepare("INSERT INTO builds(hero_id, author, account_id, title, description, priorities, items, details, updated_at) VALUES (?,?,?,?,?,'{}','[]',?,?)")
    .bind(b.hero_id, player?.name ?? String(me), me, src.name.slice(0, 60), `Copied from in-game build #${src.hero_build_id} by ${src.author_account_id}. ${(src.description ?? "").slice(0, 400)}`.trim(), JSON.stringify(details), Math.floor(Date.now() / 1000)).run();
  return c.json({ ok: true, id: res.meta.last_row_id });
});

r.put("/:id", async (c) => {
  const me = steamId(c.req.header("cookie"));
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
  const me = steamId(c.req.header("cookie"));
  const id = Number(c.req.param("id"));
  const owner = await c.env.DB.prepare("SELECT account_id FROM builds WHERE id=?").bind(id).first<{ account_id: number | null }>();
  if (!owner) return c.json({ error: "not found" }, 404);
  if (!me || owner.account_id !== me) return c.json({ error: "Only the author can delete this build" }, 403);
  await c.env.DB.prepare("DELETE FROM builds WHERE id=?").bind(id).run();
  return c.json({ ok: true });
});

r.post("/:id/vote", async (c) => { await c.env.DB.prepare("UPDATE builds SET votes=votes+1 WHERE id=?").bind(Number(c.req.param("id"))).run(); return c.json({ ok: true }); });

export default r;
