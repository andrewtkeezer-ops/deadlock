import { Hono } from "hono";
import type { Env } from "../types";
import { sealSession, clearCookies } from "../auth";

/**
 * "Continue with Google" handled by the Worker itself (OAuth 2.0 / OpenID Connect code flow).
 * /api/auth/google/login → accounts.google.com → /api/auth/google/callback → signed session cookie → "/".
 * Needs GOOGLE_CLIENT_ID (var), GOOGLE_CLIENT_SECRET + SESSION_SECRET (secrets). Redirect URI = <origin>/api/auth/google/callback.
 */
const r = new Hono<{ Bindings: Env }>();
const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

r.get("/login", (c) => {
  if (!c.env.GOOGLE_CLIENT_ID) return c.text("Google sign-in isn't configured (GOOGLE_CLIENT_ID)", 500);
  const origin = new URL(c.req.url).origin;
  const state = crypto.randomUUID();
  const p = new URLSearchParams({ client_id: c.env.GOOGLE_CLIENT_ID, redirect_uri: `${origin}/api/auth/google/callback`, response_type: "code", scope: "openid email profile", state, prompt: "select_account", access_type: "online" });
  c.header("set-cookie", `squad_oauth=${state}; Path=/; Max-Age=600; HttpOnly; SameSite=Lax; Secure`);
  return c.redirect(`${AUTH}?${p}`);
});

r.get("/callback", async (c) => {
  const url = new URL(c.req.url);
  const code = url.searchParams.get("code"), state = url.searchParams.get("state");
  const expected = /squad_oauth=([^;]+)/.exec(c.req.header("cookie") ?? "")?.[1];
  if (!code || !state || state !== expected) return c.redirect("/?error=state");
  const res = await fetch(TOKEN, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: c.env.GOOGLE_CLIENT_ID!, client_secret: c.env.GOOGLE_CLIENT_SECRET!, redirect_uri: `${url.origin}/api/auth/google/callback`, grant_type: "authorization_code" }) });
  if (!res.ok) { console.error("google token", res.status, await res.text()); return c.redirect("/?error=google"); }
  const { id_token } = (await res.json()) as { id_token?: string };
  // The id_token came straight from Google's token endpoint over TLS, so decoding it is enough; we still check audience + verified email.
  const claims = id_token ? (JSON.parse(new TextDecoder().decode(b64url(id_token.split(".")[1]))) as { aud: string; email?: string; email_verified?: boolean; name?: string; picture?: string }) : null;
  if (!claims || claims.aud !== c.env.GOOGLE_CLIENT_ID || !claims.email || claims.email_verified === false) return c.redirect("/?error=google");
  const cookie = await sealSession(c.env, { email: claims.email.toLowerCase(), name: claims.name, picture: claims.picture, exp: Date.now() + 30 * 86400_000 });
  c.header("set-cookie", `squad_session=${cookie}; Path=/; Max-Age=${30 * 86400}; HttpOnly; SameSite=Lax; Secure`, { append: true });
  c.header("set-cookie", "squad_oauth=; Path=/; Max-Age=0", { append: true });
  return c.redirect("/");
});

/** Sign out of everything: Google session, Steam identity cookie, and (legacy) a Cloudflare Access session if one exists. */
r.get("/logout", (c) => {
  for (const h of clearCookies()) c.header("set-cookie", h, { append: true });
  const access = /CF_Authorization=/.test(c.req.header("cookie") ?? "");
  return c.redirect(access ? "/cdn-cgi/access/logout" : "/");
});

export default r;
