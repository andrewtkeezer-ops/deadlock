import { Hono } from "hono";
import type { Env } from "../types";
import { syncAll, syncPlayer } from "../sync";
import { DeadlockApi, type SteamProfile } from "../deadlock";
import { requireAdmin, type Identity } from "../auth";

const admin = new Hono<{ Bindings: Env; Variables: { user?: Identity } }>();

admin.use("*", requireAdmin);

admin.post("/sync", async (c) => c.json(await syncAll(c.env)));

/** Add a friend: { account_id, name }. Pulls their history immediately. */
admin.post("/players", async (c) => {
  const body = await c.req.json<{ account_id: number; name?: string; avatar_url?: string }>();
  if (!body.account_id) return c.json({ error: "account_id required" }, 400);
  const api = new DeadlockApi(c.env);
  let { name, avatar_url } = body;
  if (!name || !avatar_url) {
    const [p] = await api.steamProfiles([body.account_id]).catch(() => [] as SteamProfile[]);
    name ||= p?.personaname || String(body.account_id); avatar_url ||= p?.avatarmedium ?? p?.avatar;
  }
  await c.env.DB.prepare("INSERT OR REPLACE INTO players(account_id, name, avatar_url) VALUES (?,?,?)")
    .bind(body.account_id, name, avatar_url ?? null).run();
  const added = await syncPlayer(c.env, api, body.account_id);
  return c.json({ ok: true, matchesImported: added });
});

admin.delete("/players/:id", async (c) => {
  const id = Number(c.req.param("id"));
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM player_matches WHERE account_id=?").bind(id),
    c.env.DB.prepare("DELETE FROM mmr_history WHERE account_id=?").bind(id),
    c.env.DB.prepare("DELETE FROM players WHERE account_id=?").bind(id),
  ]);
  return c.json({ ok: true });
});

// ---- finding people on Steam ----
const STEAM64_BASE = 76561197960265728n;

/** ?q= Steam display name, SteamID64, or steamcommunity.com/profiles/<id64> URL → candidate profiles. */
admin.get("/steam-search", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  if (!q) return c.json([]);
  const api = new DeadlockApi(c.env);
  const id64 = /7656119\d{10}/.exec(q)?.[0];
  if (id64) return c.json(await api.steamProfiles([Number(BigInt(id64) - STEAM64_BASE)]));
  const direct = /^\d{5,10}$/.test(q) ? await api.steamProfiles([Number(q)]).catch(() => []) : [];
  const results = await api.steamSearch(q, 10);
  return c.json([...direct, ...results.filter((r) => !direct.some((d) => d.account_id === r.account_id))]);
});

/** Steam friends of a tracked player who have played Deadlock recently — one-click adds. */
admin.get("/steam-friends/:id", async (c) => {
  const api = new DeadlockApi(c.env);
  const [me] = await api.steamProfiles([Number(c.req.param("id"))]);
  const ids = (me?.friends ?? []).map((f) => f.account_id);
  if (!ids.length) return c.json({ note: "Steam friends list is private or empty", friends: [] });
  const { results: tracked } = await c.env.DB.prepare("SELECT account_id FROM players").all<{ account_id: number }>();
  const have = new Set(tracked.map((t) => t.account_id));
  const profiles: SteamProfile[] = [];
  for (let i = 0; i < ids.length; i += 100) profiles.push(...(await api.steamProfiles(ids.slice(i, i + 100)).catch(() => [])));
  return c.json({ friends: profiles.filter((p) => (p.matches_played_last_30d ?? 0) > 0 || have.has(p.account_id))
    .map((p) => ({ ...p, friends: undefined, tracked: have.has(p.account_id) }))
    .sort((a, b) => (b.matches_played_last_30d ?? 0) - (a.matches_played_last_30d ?? 0)) });
});

// ---- invites ----
admin.get("/members", async (c) => c.json((await c.env.DB.prepare("SELECT * FROM members ORDER BY invited_at").all()).results));

/** Invite by email: { email, role?: 'member'|'admin', account_id? }. They sign in with Google and they're in. */
admin.post("/members", async (c) => {
  const b = await c.req.json<{ email: string; role?: "member" | "admin"; account_id?: number }>();
  const email = b.email?.trim().toLowerCase();
  if (!email || !email.includes("@")) return c.json({ error: "valid email required" }, 400);
  await c.env.DB.prepare("INSERT OR REPLACE INTO members(email, role, account_id, invited_by) VALUES (?,?,?,?)")
    .bind(email, b.role === "admin" ? "admin" : "member", b.account_id ?? null, c.get("user")?.email ?? "token").run();
  return c.json({ ok: true, email });
});

admin.delete("/members/:email", async (c) => {
  const email = decodeURIComponent(c.req.param("email")).toLowerCase();
  if (email === c.env.SUPER_ADMIN_EMAIL.toLowerCase()) return c.json({ error: "cannot remove the super admin" }, 400);
  await c.env.DB.prepare("DELETE FROM members WHERE email=?").bind(email).run();
  return c.json({ ok: true });
});

export default admin;
