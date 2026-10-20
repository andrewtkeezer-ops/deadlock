import { Hono, type Context } from "hono";
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
import google from "./routes/google";
import { requireMember, steamAccount, isSuperAdmin, identify, whoIs, authConfigured, hasAnySignIn, type Identity, accountOf } from "./auth";

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
/** Uploader (no login — it runs on the author's PC under their Steam session): builds flagged for in-game sync that are new or edited since the last publish. */
app.get("/api/sync/builds", async (c) => {
  const account = Number(c.req.query("account_id")); if (!account) return c.json([]);
  const { results } = await c.env.DB.prepare("SELECT id, hero_id, title, description, details, ingame_build_id, ingame_version, updated_at, synced_at FROM builds WHERE account_id=? AND sync_wanted=1 AND (synced_at IS NULL OR COALESCE(updated_at,0) > synced_at) ORDER BY updated_at DESC LIMIT 20").bind(account).all<{ id: number; hero_id: number; title: string; description: string | null; details: string | null; ingame_build_id: number | null; ingame_version: number | null }>();
  return c.json(results.map((b) => { const d = b.details ? (JSON.parse(b.details) as { mod_categories?: { name: string; description?: string; mods: { ability_id: number; annotation?: string | null; imbue_target_ability_id?: number }[] }[] }) : {};
    return { id: b.id, hero_build_id: b.ingame_build_id, version: b.ingame_version, hero_id: b.hero_id, name: (b.title || "Soul Scribe build").slice(0, 60), description: (b.description || "").slice(0, 500),
      categories: (d.mod_categories ?? []).map((cat) => ({ name: cat.name, description: cat.description ?? "", mods: cat.mods.map((m) => ({ ability_id: m.ability_id, annotation: m.annotation ?? "", imbue_target_ability_id: m.imbue_target_ability_id ?? 0 })) })) }; }));
});
app.post("/api/sync/builds/:id/result", async (c) => {
  const id = Number(c.req.param("id")); type SyncResult = { account_id?: number; hero_build_id?: number; version?: number; error?: string }; const b = await c.req.json<SyncResult>().catch(() => ({} as SyncResult));
  const row = await c.env.DB.prepare("SELECT account_id FROM builds WHERE id=?").bind(id).first<{ account_id: number | null }>();
  if (!row || row.account_id !== Number(b.account_id)) return c.json({ ok: false }, 404);
  if (b.error) await c.env.DB.prepare("UPDATE builds SET sync_error=? WHERE id=?").bind(String(b.error).slice(0, 200), id).run();
  else await c.env.DB.prepare("UPDATE builds SET ingame_build_id=?, ingame_version=?, synced_at=unixepoch(), sync_error=NULL WHERE id=?").bind(b.hero_build_id ?? null, b.version ?? null, id).run();
  return c.json({ ok: true });
});
app.route("/api/auth/google", google);
/** Public: who does this invite belong to? (name shown on the invite page). */
app.get("/api/invite/:token", async (c) => {
  const m = await c.env.DB.prepare("SELECT email, invited_by, accepted_at FROM members WHERE invite_token=?").bind(c.req.param("token")).first<{ email: string; invited_by: string | null; accepted_at: number | null }>();
  if (!m) return c.json({ error: "invalid" }, 404);
  const inviter = m.invited_by && m.invited_by.includes("@") ? (await c.env.DB.prepare("SELECT name FROM players p JOIN members mm ON mm.account_id=p.account_id WHERE mm.email=?").bind(m.invited_by).first<{ name: string }>())?.name ?? m.invited_by.split("@")[0] : (m.invited_by || "A friend");
  return c.json({ email: m.email, inviter, accepted: !!m.accepted_at });
});
app.use("/api/*", requireMember);
app.get("/api/me", async (c) => {
  const steam = accountOf(c); const sup = isSuperAdmin(c.env, steam);
  const u = c.get("user");
  const signed_in = !!u || hasAnySignIn(c);
  if (u) return c.json({ ...u, account_id: steam, signed_in, super: sup || u.email === c.env.SUPER_ADMIN_EMAIL.toLowerCase(), role: sup ? "admin" : u.role });
  return c.json({ email: null, role: sup ? "admin" : "member", account_id: steam, signed_in, super: sup, unconfigured: !authConfigured(c.env) });
});

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
  return c.json({ error: "internal", message: err.message.slice(0, 300) }, 500);
});

/**
 * The front door. Pages (/, *.html) are only for signed-in members; everyone else gets the Soul Scribe welcome page
 * at "/" with the Google button. Static files (css/js/img) and the legal pages are public. wrangler.jsonc sends
 * "/", "/*.html" and /api/* to the Worker first; everything else is served straight from /public.
 */
const PUBLIC_PAGES = new Set(["/welcome.html", "/terms.html", "/privacy.html", "/404.html", "/invite.html", "/invite"]);
const welcome = (c: Context<{ Bindings: Env; Variables: { user?: Identity } }>, qs = "") => c.env.ASSETS.fetch(new Request(new URL("/welcome.html" + qs, c.req.url), { headers: c.req.raw.headers }));
app.get("*", async (c) => {
  const path = new URL(c.req.url).pathname;
  if (path === "/invite") return c.env.ASSETS.fetch(new Request(new URL("/invite.html" + new URL(c.req.url).search, c.req.url), { headers: c.req.raw.headers }));
  const isPage = path === "/" || path.endsWith(".html");
  if (!isPage || PUBLIC_PAGES.has(path) || !authConfigured(c.env)) return c.env.ASSETS.fetch(c.req.raw);
  const id = await identify(c);
  if (id && id !== "unconfigured") return c.env.ASSETS.fetch(c.req.raw);
  if (path !== "/") return c.redirect("/");
  const who = await whoIs(c);
  const page = await welcome(c, who ? `?denied=${encodeURIComponent(who.email)}` : "");
  return new Response(page.body, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
});
app.notFound((c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(syncAll(env).then((r) => console.log("sync", JSON.stringify(r))));
  },
} satisfies ExportedHandler<Env>;
