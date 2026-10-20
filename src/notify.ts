import type { Env, MatchHistoryRow } from "./types";
import { getSetting } from "./settings";
import { DeadlockApi } from "./deadlock";

/**
 * Discord notifications. The admin pastes a channel webhook URL (Server settings → Integrations → Webhooks);
 * nothing else to set up. Posts a rich embed when a tracked friend's new match lands and when a rank changes.
 */
export type DiscordSettings = { webhook: string; matches: boolean; ranks: boolean; origin?: string };
const GOLD = 0xe8c76a, WIN = 0x97da79, LOSS = 0xe5574f;

export const discordSettings = (env: Env) => getSetting<DiscordSettings>(env, "discord");

export async function discordPost(env: Env, payload: Record<string, unknown>): Promise<{ sent: boolean; reason?: string }> {
  const s = await discordSettings(env);
  if (!s?.webhook) return { sent: false, reason: "no webhook" };
  const res = await fetch(s.webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "Soul Scribe", avatar_url: s.origin ? `${s.origin}/img/icon.png` : undefined, ...payload }) }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }) as Response);
  if (!res.ok) return { sent: false, reason: `Discord ${res.status}: ${(await res.text()).slice(0, 160)}` };
  return { sent: true };
}

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
const dur = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/** One embed per fresh match (newest first), capped so a backfill never floods the channel. */
export async function notifyMatches(env: Env, player: { account_id: number; name: string; avatar_url?: string | null }, fresh: MatchHistoryRow[], hadHistory: boolean) {
  const s = await discordSettings(env); if (!s?.webhook || s.matches === false) return;
  if (!hadHistory) return; // first import of a new player: skip, that's history not news
  const recent = fresh.filter((m) => m.start_time > Date.now() / 1000 - 86400).sort((a, b) => b.start_time - a.start_time).slice(0, 3);
  if (!recent.length) return;
  const heroes = await new DeadlockApi(env).heroes().catch(() => []);
  const embeds = recent.map((m) => {
    const won = m.match_result === m.player_team; const hx = heroes.find((h) => h.id === m.hero_id);
    const kda = (m.player_kills + m.player_assists) / Math.max(1, m.player_deaths);
    return {
      color: won ? WIN : LOSS,
      author: { name: `${player.name} · ${won ? "Victory" : "Defeat"} on ${hx?.name ?? "hero " + m.hero_id}`, icon_url: player.avatar_url ?? undefined },
      thumbnail: hx?.images?.icon ? { url: hx.images.icon } : undefined,
      fields: [
        { name: "K / D / A", value: `**${m.player_kills}** / ${m.player_deaths} / ${m.player_assists}  (KDA ${kda.toFixed(1)})`, inline: true },
        { name: "Souls", value: `${fmt(m.net_worth)} · ${fmt(m.net_worth * 60 / Math.max(1, m.match_duration_s))}/min`, inline: true },
        { name: "Length", value: dur(m.match_duration_s), inline: true },
      ],
      url: s.origin ? `${s.origin}/match.html?id=${m.match_id}` : undefined,
      timestamp: new Date(m.start_time * 1000).toISOString(),
    };
  });
  await discordPost(env, { embeds }).catch((e) => console.error("discord match", e));
}

/** Rank went up or down. before/after are ranks encoded tier*10+subrank. */
export async function notifyRankChanges(env: Env, changes: { name: string; avatar_url?: string | null; before: number | null; after: number; score: number | null }[]) {
  const s = await discordSettings(env); if (!s?.webhook || s.ranks === false || !changes.length) return;
  let ranks: { tier: number; name: string; large?: string; badge?: (string | undefined)[] }[] = [];
  try { ranks = (await new DeadlockApi(env).uiAssets()).ranks as typeof ranks; } catch {}
  const label = (r: number | null) => { if (!r) return "Unranked"; const t = ranks.find((x) => x.tier === Math.floor(r / 10)); return `${t?.name ?? "Tier " + Math.floor(r / 10)} ${r % 10 || ""}`.trim(); };
  const embeds = changes.slice(0, 5).map((c) => { const up = (c.before ?? 0) < c.after; const t = ranks.find((x) => x.tier === Math.floor(c.after / 10)); const img = t?.badge?.[(c.after % 10) - 1] || t?.large;
    return { color: up ? GOLD : LOSS, author: { name: `${c.name} ${up ? "climbed to" : "dropped to"} ${label(c.after)}`, icon_url: c.avatar_url ?? undefined }, description: `${label(c.before)} → **${label(c.after)}**${c.score != null ? ` · MMR ${Math.round(c.score)}` : ""}`, thumbnail: img ? { url: img } : undefined }; });
  await discordPost(env, { embeds }).catch((e) => console.error("discord rank", e));
}
