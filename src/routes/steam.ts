import { Hono } from "hono";
import type { Env } from "../types";
import { DeadlockApi, type SteamProfile } from "../deadlock";
import { syncPlayer } from "../sync";
import type { Identity } from "../auth";

/**
 * "Sign in through Steam" via OpenID 2.0. No Steam API key needed.
 * Flow: /api/auth/steam/login → steamcommunity.com → /api/auth/steam/callback (we verify with Steam, then
 * add the player, link them to the signed-in Google member if any, set a cookie, and redirect to their page).
 */
const r = new Hono<{ Bindings: Env; Variables: { user?: Identity } }>();
const STEAM_OPENID = "https://steamcommunity.com/openid/login";
const STEAM64_BASE = 76561197960265728n;

r.get("/login", (c) => {
  const origin = new URL(c.req.url).origin;
  const p = new URLSearchParams({
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "checkid_setup",
    "openid.return_to": `${origin}/api/auth/steam/callback`,
    "openid.realm": origin,
    "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
    "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
  });
  return c.redirect(`${STEAM_OPENID}?${p}`);
});

r.get("/callback", async (c) => {
  const url = new URL(c.req.url);
  if (url.searchParams.get("openid.mode") !== "id_res") return c.redirect("/setup.html?steam=cancelled");

  // Ask Steam to confirm the assertion is genuine.
  const verify = new URLSearchParams(url.searchParams);
  verify.set("openid.mode", "check_authentication");
  const res = await fetch(STEAM_OPENID, { method: "POST", body: verify, headers: { "content-type": "application/x-www-form-urlencoded" } });
  const ok = (await res.text()).includes("is_valid:true");
  const id64 = /\/openid\/id\/(7656119\d{10})$/.exec(url.searchParams.get("openid.claimed_id") ?? "")?.[1];
  if (!ok || !id64 || url.searchParams.get("openid.return_to") !== `${url.origin}/api/auth/steam/callback`) return c.redirect("/setup.html?steam=failed");

  const accountId = Number(BigInt(id64) - STEAM64_BASE);
  const api = new DeadlockApi(c.env);
  const [profile] = await api.steamProfiles([accountId]).catch(() => [] as SteamProfile[]);
  const name = profile?.personaname ?? `Steam ${accountId}`;
  const avatar = profile?.avatarmedium ?? profile?.avatar ?? null;

  await c.env.DB.prepare("INSERT INTO players(account_id, name, avatar_url) VALUES (?,?,?) ON CONFLICT(account_id) DO UPDATE SET name=excluded.name, avatar_url=COALESCE(excluded.avatar_url, players.avatar_url)")
    .bind(accountId, name, avatar).run();
  const user = c.get("user");
  if (user) await c.env.DB.prepare("UPDATE members SET account_id=? WHERE email=?").bind(accountId, user.email).run();

  let imported = 0;
  try { imported = await syncPlayer(c.env, api, accountId); } catch (e) { console.error("initial sync failed", e); }

  // Remember who this browser is (used for "my profile" links). Not a security boundary — Access is.
  c.header("set-cookie", `squad_steam=${accountId}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`);
  return c.redirect(`/player.html?id=${accountId}&welcome=${imported}`);
});

r.get("/me", (c) => {
  const id = /squad_steam=(\d+)/.exec(c.req.header("cookie") ?? "")?.[1];
  return c.json({ account_id: id ? Number(id) : null });
});

/** Sign out: drop the Steam cookie, and when Cloudflare Access is the door, end that session too (it bounces back to "/"). */
r.get("/logout", (c) => {
  c.header("set-cookie", "squad_steam=; Path=/; Max-Age=0; SameSite=Lax; Secure");
  return c.redirect(c.env.ACCESS_TEAM_DOMAIN && c.env.ACCESS_AUD ? "/cdn-cgi/access/logout" : "/");
});

export default r;
