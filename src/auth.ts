import type { Context, Next } from "hono";
import type { Env } from "./types";

/**
 * Cloudflare Access puts a signed JWT in the `Cf-Access-Jwt-Assertion` header (and CF_Authorization cookie)
 * for every request that passed the login page. We verify it against the team's public keys and read the email.
 * Docs: https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
 */
export type Identity = { email: string; role: "admin" | "member" };

const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function certs(env: Env): Promise<JsonWebKey[]> {
  const key = `access:certs:${env.ACCESS_TEAM_DOMAIN}`;
  const cached = await env.CACHE.get<{ keys: JsonWebKey[] }>(key, "json");
  if (cached) return cached.keys;
  const res = await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`cannot fetch Access certs: ${res.status}`);
  const data = (await res.json()) as { keys: JsonWebKey[] };
  await env.CACHE.put(key, JSON.stringify(data), { expirationTtl: 3600 });
  return data.keys;
}

export async function verifyAccessJwt(env: Env, token: string): Promise<string | null> {
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return null;
  const header = JSON.parse(new TextDecoder().decode(b64url(h))) as { kid: string; alg: string };
  const payload = JSON.parse(new TextDecoder().decode(b64url(p))) as { email?: string; aud: string | string[]; exp: number; iss: string };
  if (header.alg !== "RS256") return null;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD!) || payload.exp * 1000 < Date.now() || payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null;
  const jwk = (await certs(env)).find((k) => (k as { kid?: string }).kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(s), new TextEncoder().encode(`${h}.${p}`));
  return ok && payload.email ? payload.email.toLowerCase() : null;
}

/** Resolve who is calling. Returns null when Access isn't configured (local dev) or the user isn't a member. */
export async function identify(c: Context<{ Bindings: Env; Variables: { user?: Identity } }>): Promise<Identity | null | "unconfigured"> {
  const env = c.env;
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return "unconfigured";
  const token = c.req.header("cf-access-jwt-assertion") ?? /CF_Authorization=([^;]+)/.exec(c.req.header("cookie") ?? "")?.[1];
  if (!token) return null;
  const email = await verifyAccessJwt(env, token).catch(() => null);
  if (!email) return null;
  if (email === env.SUPER_ADMIN_EMAIL.toLowerCase()) {
    await env.DB.prepare("INSERT OR IGNORE INTO members(email, role, invited_by) VALUES (?, 'admin', 'system')").bind(email).run();
    return { email, role: "admin" };
  }
  const m = await env.DB.prepare("SELECT role FROM members WHERE email=?").bind(email).first<{ role: Identity["role"] }>();
  if (!m) return null;
  c.executionCtx.waitUntil(env.DB.prepare("UPDATE members SET last_seen=unixepoch() WHERE email=?").bind(email).run());
  return { email, role: m.role };
}

/** Every /api route: must be an invited member (or Access not configured yet). */
export async function requireMember(c: Context<{ Bindings: Env; Variables: { user?: Identity } }>, next: Next) {
  const id = await identify(c);
  if (id === "unconfigured") return next();
  if (!id) return c.json({ error: "not invited", message: "Your Google account isn't on the squad list. Ask Andrew for an invite." }, 403);
  c.set("user", id);
  return next();
}

/** /api/admin routes: super admin / admins, with the shared token as a fallback for local dev. */
export async function requireAdmin(c: Context<{ Bindings: Env; Variables: { user?: Identity } }>, next: Next) {
  const user = c.get("user");
  if (user?.role === "admin") return next();
  // Access not configured yet (open/testing mode): everything is admin. Turn on Access before sharing the URL widely.
  if (!c.env.ACCESS_TEAM_DOMAIN || !c.env.ACCESS_AUD) return next();
  const token = c.req.header("x-admin-token") ?? c.req.query("token");
  if (!user && token && token === c.env.ADMIN_TOKEN) return next();
  return c.json({ error: "unauthorized" }, 401);
}
