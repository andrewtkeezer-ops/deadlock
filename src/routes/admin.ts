import { Hono } from "hono";
import type { Env } from "../types";
import { syncAll, syncPlayer } from "../sync";
import { DeadlockApi, type SteamProfile } from "../deadlock";
import { bigAvatar } from "../deadlock";
import { requireAdmin, type Identity } from "../auth";
import { sendInvite, inviteText, inviteHtml } from "../email";
import { GMAIL_SCOPE, gmailLink, saveGmailLink, gmailSend } from "../gmail";

const admin = new Hono<{ Bindings: Env; Variables: { user?: Identity } }>();

admin.use("*", requireAdmin);

admin.post("/sync", async (c) => c.json(await syncAll(c.env)));

/** Gmail sender: one-time OAuth consent (gmail.send) by the admin; refresh token kept in settings. */
admin.get("/gmail", async (c) => { const l = await gmailLink(c.env); return c.json({ connected: !!l, email: l?.email ?? null, connected_at: l?.connected_at ?? null, resend: !!c.env.RESEND_API_KEY }); });
admin.get("/gmail/connect", (c) => {
  if (!c.env.GOOGLE_CLIENT_ID) return c.text("Google sign-in isn't configured", 500);
  const origin = new URL(c.req.url).origin, state = crypto.randomUUID();
  const p = new URLSearchParams({ client_id: c.env.GOOGLE_CLIENT_ID, redirect_uri: `${origin}/api/admin/gmail/callback`, response_type: "code", scope: GMAIL_SCOPE, state, access_type: "offline", prompt: "consent", include_granted_scopes: "true" });
  c.header("set-cookie", `squad_gmail=${state}; Path=/; Max-Age=600; HttpOnly; SameSite=Lax; Secure`);
  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${p}`);
});
admin.get("/gmail/callback", async (c) => {
  const url = new URL(c.req.url); const code = url.searchParams.get("code"), state = url.searchParams.get("state");
  const expected = /squad_gmail=([^;]+)/.exec(c.req.header("cookie") ?? "")?.[1];
  if (!code || !state || state !== expected) return c.redirect("/admin.html?gmail=state");
  const res = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: c.env.GOOGLE_CLIENT_ID!, client_secret: c.env.GOOGLE_CLIENT_SECRET!, redirect_uri: `${url.origin}/api/admin/gmail/callback`, grant_type: "authorization_code" }) });
  const j = (await res.json()) as { refresh_token?: string; id_token?: string; scope?: string };
  if (!res.ok || !j.refresh_token) { console.error("gmail token", res.status, j); return c.redirect("/admin.html?gmail=token"); }
  if (!/gmail\.send/.test(j.scope ?? "")) return c.redirect("/admin.html?gmail=scope");
  const claims = j.id_token ? (JSON.parse(atob(j.id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))) as { email?: string }) : {};
  await saveGmailLink(c.env, { refresh_token: j.refresh_token, email: claims.email ?? "", connected_at: Math.floor(Date.now() / 1000) });
  c.header("set-cookie", "squad_gmail=; Path=/; Max-Age=0");
  return c.redirect("/admin.html?gmail=ok");
});
admin.delete("/gmail", async (c) => { await saveGmailLink(c.env, null); return c.json({ ok: true }); });
admin.post("/gmail/test", async (c) => {
  const l = await gmailLink(c.env); if (!l) return c.json({ error: "Gmail not connected" }, 400);
  const origin = new URL(c.req.url).origin, i = { to: l.email, inviter: c.get("user")?.name || "You", link: `${origin}/`, origin };
  return c.json(await gmailSend(c.env, { to: l.email, subject: "Soul Scribe test invite", text: inviteText(i), html: inviteHtml(i) }));
});

/** Add a friend: { account_id, name }. Pulls their history immediately. */
admin.post("/players", async (c) => {
  const body = await c.req.json<{ account_id: number; name?: string; avatar_url?: string }>();
  if (!body.account_id) return c.json({ error: "account_id required" }, 400);
  const api = new DeadlockApi(c.env);
  let { name, avatar_url } = body;
  if (!name || !avatar_url) {
    const [p] = await api.steamProfiles([body.account_id]).catch(() => [] as SteamProfile[]);
    name ||= p?.personaname || String(body.account_id); avatar_url = bigAvatar(avatar_url ?? p?.avatarfull ?? p?.avatarmedium ?? p?.avatar) ?? undefined;
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

/** steamcommunity.com/id/<vanity> → SteamID64, via Steam's public XML profile (no API key needed). */
async function resolveVanity(vanity: string): Promise<string | null> {
  const res = await fetch(`https://steamcommunity.com/id/${encodeURIComponent(vanity)}/?xml=1`, { headers: { "user-agent": "soulscribe/1.0" } });
  if (!res.ok) return null;
  return /<steamID64>(7656119\d{10})<\/steamID64>/.exec(await res.text())?.[1] ?? null;
}

/** ?q= Steam display name, SteamID64, account_id, or a steamcommunity.com/profiles/<id64> or /id/<vanity> URL → candidate profiles. */
admin.get("/steam-search", async (c) => {
  let q = (c.req.query("q") ?? "").trim();
  if (!q) return c.json([]);
  const api = new DeadlockApi(c.env);
  const vanity = /steamcommunity\.com\/id\/([^/?#\s]+)/i.exec(q)?.[1];
  if (vanity) {
    const id64 = await resolveVanity(vanity).catch(() => null);
    if (!id64) return c.json({ error: "not_found", message: `Steam couldn't resolve the profile URL "${vanity}". Check the link, or search by their display name.` }, 404);
    q = id64;
  }
  const id64 = /7656119\d{10}/.exec(q)?.[0];
  if (id64) {
    const accountId = Number(BigInt(id64) - STEAM64_BASE);
    const found = await api.steamProfiles([accountId]).catch(() => []);
    // deadlock-api only knows players it has seen; still let the admin add the account by id.
    return c.json(found.length ? found : [{ account_id: accountId, personaname: `Steam ${accountId}`, avatar: null, avatarmedium: null, note: "Not seen by deadlock-api yet — can still be added." }]);
  }
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
  const b = await c.req.json<{ email: string; role?: "member" | "admin"; account_id?: number; send?: boolean }>();
  const email = b.email?.trim().toLowerCase();
  if (!email || !email.includes("@")) return c.json({ error: "valid email required" }, 400);
  const existing = await c.env.DB.prepare("SELECT invite_token FROM members WHERE email=?").bind(email).first<{ invite_token: string | null }>();
  const token = existing?.invite_token ?? crypto.randomUUID().replace(/-/g, "");
  const inviter = c.get("user")?.name || c.get("user")?.email || "A friend";
  await c.env.DB.prepare("INSERT INTO members(email, role, account_id, invited_by, invite_token) VALUES (?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET role=excluded.role, account_id=COALESCE(excluded.account_id, members.account_id), invite_token=COALESCE(members.invite_token, excluded.invite_token)")
    .bind(email, b.role === "admin" ? "admin" : "member", b.account_id ?? null, c.get("user")?.email ?? "admin", token).run();
  const origin = new URL(c.req.url).origin; const link = `${origin}/invite?t=${token}`;
  let mail: { sent: boolean; reason?: string } = { sent: false };
  if (b.send !== false) { mail = await sendInvite(c.env, { to: email, inviter, link, origin }); if (mail.sent) await c.env.DB.prepare("UPDATE members SET invite_sent_at=unixepoch() WHERE email=?").bind(email).run(); }
  return c.json({ ok: true, email, link, message: inviteText({ to: email, inviter, link, origin }), emailed: mail.sent, email_note: mail.reason });
});

/** Re-send / re-fetch an invite link. */
admin.post("/members/:email/invite", async (c) => {
  const email = decodeURIComponent(c.req.param("email")).toLowerCase();
  const m = await c.env.DB.prepare("SELECT invite_token FROM members WHERE email=?").bind(email).first<{ invite_token: string | null }>();
  if (!m) return c.json({ error: "not found" }, 404);
  const token = m.invite_token ?? crypto.randomUUID().replace(/-/g, "");
  if (!m.invite_token) await c.env.DB.prepare("UPDATE members SET invite_token=? WHERE email=?").bind(token, email).run();
  const origin = new URL(c.req.url).origin; const link = `${origin}/invite?t=${token}`; const inviter = c.get("user")?.name || c.get("user")?.email || "A friend";
  const mail = await sendInvite(c.env, { to: email, inviter, link, origin });
  if (mail.sent) await c.env.DB.prepare("UPDATE members SET invite_sent_at=unixepoch() WHERE email=?").bind(email).run();
  return c.json({ ok: true, link, message: inviteText({ to: email, inviter, link, origin }), emailed: mail.sent, email_note: mail.reason });
});

admin.delete("/members/:email", async (c) => {
  const email = decodeURIComponent(c.req.param("email")).toLowerCase();
  if (email === c.env.SUPER_ADMIN_EMAIL.toLowerCase()) return c.json({ error: "cannot remove the super admin" }, 400);
  await c.env.DB.prepare("DELETE FROM members WHERE email=?").bind(email).run();
  return c.json({ ok: true });
});

export default admin;
