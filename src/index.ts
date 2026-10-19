import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { syncAll } from "./sync";
import { ApiError } from "./deadlock";
import players from "./routes/players";
import heroes from "./routes/heroes";
import builds from "./routes/builds";
import analytics from "./routes/analytics";
import admin from "./routes/admin";
import { requireMember, type Identity } from "./auth";

const app = new Hono<{ Bindings: Env; Variables: { user?: Identity } }>();
app.use("/api/*", cors());
app.get("/api/health", (c) => c.json({ ok: true, now: Date.now() }));
app.use("/api/*", requireMember);
app.get("/api/me", (c) => c.json(c.get("user") ?? { email: "dev", role: "admin", unconfigured: true }));

app.route("/api/players", players);
app.route("/api/heroes", heroes);
app.route("/api/builds", builds);
app.route("/api/analytics", analytics);
app.route("/api/admin", admin);

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
