import type { Env } from "./types";

/**
 * Invite email. Sends through Resend (https://resend.com, free tier 3k/month) when RESEND_API_KEY and
 * INVITE_FROM are set; otherwise returns { sent: false } and the admin shares the link by hand.
 */
export type Invite = { to: string; inviter: string; link: string; origin: string };

export function inviteHtml(i: Invite): string {
  const art = `${i.origin}/img/bg-1200.jpg`, logo = `${i.origin}/img/logo.webp`, mark = `${i.origin}/img/icon.png`;
  return `<!doctype html><html><body style="margin:0;background:#06100b;font-family:Georgia,'Times New Roman',serif;color:#ece7d8">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#06100b"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#0c1611;border:1px solid #1f3b2b;border-radius:16px;overflow:hidden">
<tr><td style="padding:0;background:#06100b url('${art}') center/cover no-repeat;height:220px;text-align:center;vertical-align:middle">
  <img src="${mark}" width="72" height="72" alt="" style="display:block;margin:34px auto 6px"><img src="${logo}" width="300" alt="Soul Scribe" style="display:block;margin:0 auto 20px"></td></tr>
<tr><td style="padding:28px 36px 8px;text-align:center"><div style="font-size:11px;letter-spacing:.3em;text-transform:uppercase;color:#49d17e">You're invited</div>
  <h1 style="font-size:26px;margin:10px 0 6px;color:#f1e6c4;letter-spacing:.02em">${esc(i.inviter)} invited you to Soul Scribe</h1>
  <p style="font-size:15px;line-height:1.6;color:#c9c4b4;margin:8px 0 22px">The squad's private Deadlock tracker: every match, every build, the leaderboard, and who's actually carrying. Sign in with the Google account this was sent to.</p>
  <a href="${i.link}" style="display:inline-block;background:#e8c76a;color:#1a1200;font-weight:700;font-size:16px;padding:14px 30px;border-radius:10px;text-decoration:none">Accept invite →</a>
  <p style="font-size:12px;color:#8d92a4;margin:22px 0 0">Track · Build · Climb</p></td></tr>
<tr><td style="padding:16px 36px 26px;text-align:center;font-size:12px;color:#5c6072;border-top:1px solid #1f3b2b">If the button doesn't work, open this link:<br><a href="${i.link}" style="color:#49d17e;word-break:break-all">${i.link}</a><br><br>Soul Scribe is a private site for friends and isn't affiliated with Valve.</td></tr>
</table></td></tr></table></body></html>`;
}
export const inviteText = (i: Invite) => `${i.inviter} invited you to Soul Scribe — the squad's private Deadlock tracker (matches, builds, leaderboard).\n\nAccept: ${i.link}\n\nSign in with the Google account this was sent to.`;
const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch] as string));

export async function sendInvite(env: Env, i: Invite): Promise<{ sent: boolean; reason?: string }> {
  if (!env.RESEND_API_KEY) return { sent: false, reason: "email not configured (RESEND_API_KEY)" };
  const from = env.INVITE_FROM || "Soul Scribe <onboarding@resend.dev>";
  const res = await fetch("https://api.resend.com/emails", { method: "POST", headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from, to: [i.to], subject: `${i.inviter} invited you to Soul Scribe`, html: inviteHtml(i), text: inviteText(i) }) });
  if (!res.ok) return { sent: false, reason: `Resend ${res.status}: ${(await res.text()).slice(0, 200)}` };
  return { sent: true };
}
