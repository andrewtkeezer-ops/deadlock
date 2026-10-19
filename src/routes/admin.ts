import { Hono } from "hono";
import type { Env } from "../types";
import { syncAll, syncPlayer } from "../sync";
import { DeadlockApi } from "../deadlock";

const admin = new Hono<{ Bindings: Env }>();

// Super-simple auth for a 10-person friend group: a shared token in a header.
admin.use("*", async (c, next) => {
  const token = c.req.header("x-admin-token") ?? c.req.query("token");
  if (token !== c.env.ADMIN_TOKEN) return c.json({ error: "unauthorized" }, 401);
  await next();
});

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

export default admin;
