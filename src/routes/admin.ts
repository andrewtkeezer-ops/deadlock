import { Hono } from "hono";
import type { Env } from "../types";
import { syncAll, syncPlayer } from "../sync";
import { DeadlockApi } from "../deadlock";
import { requireAdmin, type Identity } from "../auth";

const admin = new Hono<{ Bindings: Env; Variables: { user?: Identity } }>();

admin.use("*", requireAdmin);

admin.post("/sync", async (c) => c.json(await syncAll(c.env)));

/** Add a friend: { account_id, name }. Pulls their history immediately. */
admin.post("/players", async (c) => {
  const body = await c.req.json<{ account_id: number; name: string; avatar_url?: string }>();
  if (!body.account_id || !body.name) return c.json({ error: "account_id and name required" }, 400);
  await c.env.DB.prepare("INSERT OR REPLACE INTO players(account_id, name, avatar_url) VALUES (?,?,?)")
    .bind(body.account_id, body.name, body.avatar_url ?? null).run();
  const added = await syncPlayer(c.env, new DeadlockApi(c.env), body.account_id);
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
