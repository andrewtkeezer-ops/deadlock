import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { syncAll, syncPlayer } from "./sync";
import { ApiError, DeadlockApi } from "./deadlock";
import players from "./routes/players";
import heroes from "./routes/heroes";
import builds from "./routes/builds";
import library from "./routes/builds-library";
import analytics from "./routes/analytics";
import admin from "./routes/admin";
import steam from "./routes/steam";
import { requireMember, type Identity } from "./auth";

const app = new Hono<{ Bindings: Env; Variables: { user?: Identity } }>();
app.use("/api/*", cors());
app.get("/api/assets", async (c) => c.json(await new DeadlockApi(c.env).uiAssets()));
app.get("/api/health", (c) => c.json({ ok: true, now: Date.now() }));
/**
 * Called by the squad uploader (our deadlock-api-ingest fork) right after it uploads a match.
 * No login: the uploader has no cookie. It can only trigger a re-sync of an already-tracked
 * player, throttled to once a minute, so there's nothing to abuse.
 */
app.post("/api/ingest/notify", async (c) => {
  const body = await c.req.json<{ match_id?: number; account_id?: number }>().catch(() => ({} as { account_id?: number }));
  const accountId = Number(body.account_id);
  if (!accountId) return c.json({ ok: false, reason: "no account_id" });
  const tracked = await c.env.DB.prepare("SELECT 1 FROM players WHERE account_id=?").bind(accountId).first();
  if (!tracked) return c.json({ ok: false, reason: "not tracked" });
  const key = `notify:${accountId}`;
  if (await c.env.CACHE.get(key)) return c.json({ ok: true, queued: false, reason: "throttled" });
  await c.env.CACHE.put(key, "1", { expirationTtl: 60 });
  // deadlock-api needs a moment to process the salts before the match shows in history.
  c.executionCtx.waitUntil(new Promise((r) => setTimeout(r, 20000)).then(() => syncPlayer(c.env, new DeadlockApi(c.env), accountId)).catch((e) => console.error("notify sync", e)));
  return c.json({ ok: true, queued: true });
});
app.use("/api/*", requireMember);
app.get("/api/me", (c) => c.json(c.get("user") ?? { email: "dev", role: "admin", unconfigured: true }));

app.route("/api/players", players);
app.route("/api/heroes", heroes);
app.route("/api/library", library);
app.route("/api/builds", builds);
app.route("/api/analytics", analytics);
app.route("/api/admin", admin);
app.route("/api/auth/steam", steam);

app.onError((err, c) => {
  console.error(err);
  if (err instanceof ApiError) return c.json({ error: "upstream", status: err.status, message: err.message }, 502);
  return c.json({ error: "internal", message: err.message }, 500);
});

// Anything that isn't /api/* is a static file in /public.
app.notFound((c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(syncAll(env).then((r) => console.log("sync", JSON.stringify(r))));
  },
} satisfies ExportedHandler<Env>;
