import { Hono } from "hono";
import type { Env } from "../types";
import { syncAll, syncPlayer } from "../sync";
import { DeadlockApi, METRICS, type SteamProfile } from "../deadlock";
import { bigAvatar } from "../deadlock";
import { requireAdmin, type Identity } from "../auth";
import { sendInvite, inviteText } from "../email";
import { getSetting, setSetting } from "../settings";
import { discordPost, type DiscordSettings } from "../notify";

const admin = new Hono<{ Bindings: Env; Variables: { user?: Identity } }>();

admin.use("*", requireAdmin);

admin.post("/sync", async (c) => c.json(await syncAll(c.env)));

/** Usage snapshot vs. the free-tier limits that matter. */
admin.get("/usage", async (c) => {
  const count = async (t: string, where = "") => (await c.env.DB.prepare(`SELECT COUNT(*) n FROM ${t} ${where}`).first<{ n: number }>())?.n ?? 0;
  const [players, matches, mmr, meta, builds, members, metaBytes, rawBytes] = await Promise.all([count("players"), count("player_matches"), count("mmr_history"), count("match_meta"), count("builds"), count("members"),
    c.env.DB.prepare("SELECT COALESCE(SUM(LENGTH(json)),0) b FROM match_meta").first<{ b: number }>().then((r) => r?.b ?? 0), c.env.DB.prepare("SELECT COALESCE(SUM(LENGTH(raw)),0) b FROM player_matches").first<{ b: number }>().then((r) => r?.b ?? 0)]);
  const bytes = metaBytes + rawBytes;
  const lastSync = await getSetting<{ at: number; players: number; newMatches: number; errors: string[] }>(c.env, "last_sync");
  return c.json({ last_sync: lastSync, d1: { rows: { players, player_matches: matches, mmr_history: mmr, match_meta: meta, builds, members }, approx_bytes: bytes, limit_bytes: 5 * 1024 ** 3, note: "D1 free: 5 GB storage, 5M reads/day, 100k writes/day. Hourly sync writes ≈ players × 2 + new matches." },
    cache: { ...METRICS, uptime_s: Math.round((Date.now() - METRICS.started) / 1000), note: "Counters since this Worker instance started; Cloudflare recycles instances often." },
    kv: { note: "KV free: 1,000 writes/day. Only used for Access certs and the uploader throttle (≤1 write/min/player)." },
    workers: { note: "Workers free: 100k requests/day, 10 ms CPU per request. Heavy upstream payloads (heatmap) are fetched by the browser, not the Worker." } });
});

/** Discord notifications: { webhook, matches, ranks }. Webhook is masked on read. */
admin.get("/discord", async (c) => { const s = await getSetting<DiscordSettings>(c.env, "discord"); return c.json(s ? { configured: true, webhook_hint: s.webhook.replace(/(https:\/\/discord(?:app)?\.com\/api\/webhooks\/\d+\/)(.{4}).*/, "$1$2…"), matches: s.matches !== false, ranks: s.ranks !== false } : { configured: false, matches: true, ranks: true }); });
admin.put("/discord", async (c) => {
  const b = await c.req.json<{ webhook?: string; matches?: boolean; ranks?: boolean }>();
  const cur = await getSetting<DiscordSettings>(c.env, "discord");
  const webhook = (b.webhook ?? cur?.webhook ?? "").trim();
  if (!webhook) { await setSetting(c.env, "discord", null); return c.json({ ok: true, configured: false }); }
  if (!/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(webhook)) return c.json({ error: "That doesn't look like a Discord webhook URL" }, 400);
  await setSetting(c.env, "discord", { webhook, matches: b.matches ?? cur?.matches ?? true, ranks: b.ranks ?? cur?.ranks ?? true, origin: new URL(c.req.url).origin } satisfies DiscordSettings);
  return c.json({ ok: true, configured: true });
});
admin.post("/discord/test", async (c) => c.json(await discordPost(c.env, { embeds: [{ color: 0xe8c76a, title: "Soul Scribe is connected", description: "New matches and rank changes from the squad will show up here.", url: new URL(c.req.url).origin }] })));

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
