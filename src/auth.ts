import type { Context, Next } from "hono";
import type { Env } from "./types";

/**
 * Who is calling?
 *  1. Google sign-in handled by the Worker (routes/google.ts): a signed `squad_session` cookie. Preferred.
 *  2. Legacy: Cloudflare Access JWT (`Cf-Access-Jwt-Assertion` / CF_Authorization) if ACCESS_* are set.
 *  3. Neither configured (local dev): "unconfigured" → no auth at all.
 * Either way the email must then be on the members list (or be SUPER_ADMIN_EMAIL).
 */
export type Identity = { email: string; role: "admin" | "member"; name?: string; picture?: string; account_id?: number | null; super?: boolean };
export type Session = { email: string; name?: string; picture?: string; exp: number };

/** Steam account from the squad_steam cookie (set by /api/auth/steam/callback). Not a security boundary on its own. */
export const steamAccount = (cookie?: string): number | null => { const m = /squad_steam=(\d+)/.exec(cookie ?? ""); return m ? Number(m[1]) : null; };
export const isSuperAdmin = (env: Env, accountId: number | null) => !!accountId && String(accountId) === env.SUPER_ADMIN_ACCOUNT_ID;
export const authConfigured = (env: Env) => !!env.GOOGLE_CLIENT_ID || !!(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD);

const enc = new TextEncoder();
const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const toB64url = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function hmacKey(env: Env) {
  const secret = env.SESSION_SECRET || env.GOOGLE_CLIENT_SECRET || "dev-only-not-secret";
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
/** payload.signature, HMAC-SHA256 with SESSION_SECRET. */
export async function sealSession(env: Env, s: Session): Promise<string> {
  const body = toB64url(enc.encode(JSON.stringify(s)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(env), enc.encode(body));
  return `${body}.${toB64url(sig)}`;
}
export async function openSession(env: Env, cookie?: string): Promise<Session | null> {
  const m = /squad_session=([^;]+)/.exec(cookie ?? ""); if (!m) return null;
  const [body, sig] = m[1].split("."); if (!body || !sig) return null;
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(env), b64url(sig), enc.encode(body)).catch(() => false);
  if (!ok) return null;
  try { const s = JSON.parse(new TextDecoder().decode(b64url(body))) as Session; return s.exp > Date.now() ? s : null; } catch { return null; }
}
/** Set-Cookie headers that sign a browser out of everything we own. */
export const clearCookies = () => ["squad_session=; Path=/; Max-Age=0; SameSite=Lax; Secure", "squad_steam=; Path=/; Max-Age=0; SameSite=Lax; Secure", "squad_oauth=; Path=/; Max-Age=0"];
/** Does this browser carry any sign-in at all (even one we couldn't verify)? Used only for showing the Sign out button. */
type Ctx = { env: Env; req: { header(name: string): string | undefined } };
export const hasAnySignIn = (c: Ctx) => /squad_session=|CF_Authorization=/.test(c.req.header("cookie") ?? "") || !!c.req.header("cf-access-jwt-assertion");

// ---- legacy Cloudflare Access ----
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
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(s), enc.encode(`${h}.${p}`));
  return ok && payload.email ? payload.email.toLowerCase() : null;
}

/** The signed-in Google account (email + profile), before the members check. null = signed out. */
export async function whoIs(c: Ctx): Promise<Session | null> {
  const env = c.env;
  if (env.GOOGLE_CLIENT_ID) { const s = await openSession(env, c.req.header("cookie")); if (s) return s; }
  if (env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) {
    const token = c.req.header("cf-access-jwt-assertion") ?? /CF_Authorization=([^;]+)/.exec(c.req.header("cookie") ?? "")?.[1];
    const email = token ? await verifyAccessJwt(env, token).catch(() => null) : null;
    if (email) return { email, exp: Infinity };
  }
  return null;
}

/** Resolve the caller to a member. null = signed out or not invited; "unconfigured" = no auth set up (local dev). */
export async function identify(c: Context<{ Bindings: Env; Variables: { user?: Identity } }>): Promise<Identity | null | "unconfigured"> {
  const env = c.env;
  if (!authConfigured(env)) return "unconfigured";
  const s = await whoIs(c);
  if (!s) return null;
  const { email, name, picture } = s;
  if (email === env.SUPER_ADMIN_EMAIL.toLowerCase()) {
    await env.DB.prepare("INSERT OR IGNORE INTO members(email, role, invited_by) VALUES (?, 'admin', 'system')").bind(email).run();
    c.executionCtx.waitUntil(env.DB.prepare("UPDATE members SET last_seen=unixepoch(), accepted_at=COALESCE(accepted_at, unixepoch()) WHERE email=?").bind(email).run());
    return { email, name, picture, role: "admin" };
  }
  const m = await env.DB.prepare("SELECT role FROM members WHERE email=?").bind(email).first<{ role: Identity["role"] }>();
  if (!m) return null;
  c.executionCtx.waitUntil(env.DB.prepare("UPDATE members SET last_seen=unixepoch(), accepted_at=COALESCE(accepted_at, unixepoch()) WHERE email=?").bind(email).run());
  return { email, name, picture, role: m.role };
}

/** Every /api route: must be an invited member (or auth not configured yet). */
export async function requireMember(c: Context<{ Bindings: Env; Variables: { user?: Identity } }>, next: Next) {
  const id = await identify(c);
  if (id === "unconfigured") return next();
  if (!id) {
    const signedIn = !!(await whoIs(c));
    return c.json(signedIn ? { error: "not invited", message: "Your Google account isn't on the squad list. Ask Andrew for an invite." } : { error: "signed out", message: "Sign in first." }, signedIn ? 403 : 401);
  }
  c.set("user", id);
  return next();
}

/** /api/admin routes: admins only (role from the members table, or the super admin by email / Steam account). */
export async function requireAdmin(c: Context<{ Bindings: Env; Variables: { user?: Identity } }>, next: Next) {
  const user = c.get("user");
  if (user?.role === "admin") return next();
  if (isSuperAdmin(c.env, steamAccount(c.req.header("cookie")))) return next();
  // Auth not configured yet (local dev / open mode): everything is admin. Turn on Google sign-in before sharing the URL widely.
  if (!authConfigured(c.env)) return next();
  return c.json({ error: "unauthorized" }, 401);
}
