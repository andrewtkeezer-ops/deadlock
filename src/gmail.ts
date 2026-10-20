import type { Env } from "./types";

/**
 * Send invites through the super admin's own Gmail account (Gmail API, gmail.send scope).
 * One-time "Connect Gmail" in Admin stores a refresh token in the settings table; after that every
 * invite is sent from that address — no custom domain, no third-party mailer.
 * Google Cloud needs: Gmail API enabled, scope .../auth/gmail.send on the consent screen, and
 * <origin>/api/admin/gmail/callback added as an authorized redirect URI on the OAuth client.
 */
const TOKEN = "https://oauth2.googleapis.com/token";
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.send openid email";

export type GmailLink = { refresh_token: string; email: string; connected_at: number };

export async function gmailLink(env: Env): Promise<GmailLink | null> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key='gmail'").first<{ value: string }>().catch(() => null);
  return row ? (JSON.parse(row.value) as GmailLink) : null;
}
export async function saveGmailLink(env: Env, link: GmailLink | null) {
  if (!link) return env.DB.prepare("DELETE FROM settings WHERE key='gmail'").run();
  return env.DB.prepare("INSERT OR REPLACE INTO settings(key, value, updated_at) VALUES ('gmail', ?, unixepoch())").bind(JSON.stringify(link)).run();
}

async function accessToken(env: Env, link: GmailLink): Promise<string> {
  const res = await fetch(TOKEN, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ refresh_token: link.refresh_token, client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, grant_type: "refresh_token" }) });
  const j = (await res.json()) as { access_token?: string; error?: string };
  if (!res.ok || !j.access_token) throw new Error(j.error === "invalid_grant" ? "Gmail link expired or was revoked — reconnect it in Admin" : `Gmail token ${res.status}`);
  return j.access_token;
}

const b64 = (bytes: Uint8Array) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const b64url = (s: string) => b64(new TextEncoder().encode(s)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const rfc2047 = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(new TextEncoder().encode(s))}?=`);

/** Build a multipart/alternative RFC 822 message and send it as the linked account. */
export async function gmailSend(env: Env, m: { to: string; subject: string; text: string; html: string; fromName?: string }): Promise<{ sent: boolean; reason?: string }> {
  const link = await gmailLink(env);
  if (!link) return { sent: false, reason: "Gmail not connected" };
  try {
    const token = await accessToken(env, link);
    const boundary = "sb_" + crypto.randomUUID().replace(/-/g, "");
    const raw = [
      `From: ${rfc2047(m.fromName ?? "Soul Scribe")} <${link.email}>`, `To: ${m.to}`, `Subject: ${rfc2047(m.subject)}`, "MIME-Version: 1.0",
      `Content-Type: multipart/alternative; boundary="${boundary}"`, "",
      `--${boundary}`, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", b64(new TextEncoder().encode(m.text)),
      `--${boundary}`, "Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64", "", b64(new TextEncoder().encode(m.html)),
      `--${boundary}--`, "",
    ].join("\r\n");
    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ raw: b64url(raw) }) });
    if (!res.ok) return { sent: false, reason: `Gmail ${res.status}: ${(await res.text()).slice(0, 200)}` };
    return { sent: true };
  } catch (e) { return { sent: false, reason: (e as Error).message }; }
}
