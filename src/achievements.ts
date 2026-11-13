import type { Env } from "./types";
import { std } from "./modes";
import { discordPost, discordSettings } from "./notify";
import { setSetting } from "./settings";

/**
 * Achievements are a pure function of stored games, so every rule backfills: the earn date is the start time of the
 * first game that met the bar. Three tiers each. Bump ACH_VERSION whenever the rules change so the next sync recounts.
 */
export const ACH_VERSION = 1;

type Row = { account_id: number; match_id: number; hero_id: number; start_time: number; duration_s: number; won: number; team: number | null; kills: number; deaths: number; assists: number; net_worth: number; match_mode: number | null };
export type AchDef = { key: string; name: string; icon: string; lane: "b" | "g" | "y" | "ink"; tiers: number[]; how: string; unit?: string; lower?: boolean; kind: "game" | "career" };

export const ACHIEVEMENTS: AchDef[] = [
  { key: "spree", name: "Killing Spree", icon: "✕", lane: "ink", tiers: [10, 15, 20], how: "Get {n} kills in one game", kind: "game" },
  { key: "untouchable", name: "Untouchable", icon: "◇", lane: "b", tiers: [5, 12, 20], how: "Finish a game with zero deaths and {n}+ kills and assists", kind: "game" },
  { key: "playmaker", name: "Playmaker", icon: "✚", lane: "g", tiers: [15, 25, 35], how: "Get {n} assists in one game", kind: "game" },
  { key: "fat_stacks", name: "Fat Stacks", icon: "$", lane: "y", tiers: [35000, 50000, 65000], how: "End a game with {n} souls", kind: "game" },
  { key: "farmer", name: "Soul Farmer", icon: "≋", lane: "y", tiers: [1000, 1300, 1600], how: "Average {n} souls per minute in a 15+ minute game", unit: "/min", kind: "game" },
  { key: "kda", name: "Clean Hands", icon: "★", lane: "b", tiers: [5, 10, 20], how: "Post a KDA of {n} or better in one game", kind: "game" },
  { key: "speedrun", name: "Speedrun", icon: "»", lane: "g", tiers: [25, 22, 19], how: "Win a game in under {n} minutes", unit: " min", lower: true, kind: "game" },
  { key: "marathon", name: "Marathon", icon: "∞", lane: "b", tiers: [40, 50, 60], how: "Play a game that lasts {n}+ minutes", unit: " min", kind: "game" },
  { key: "squad", name: "Squad Goals", icon: "◎", lane: "g", tiers: [1, 2, 3], how: "Win with {n} tracked friend(s) on your team", kind: "game" },
  { key: "streak", name: "On a Roll", icon: "▲", lane: "ink", tiers: [3, 5, 8], how: "Win {n} games in a row", kind: "career" },
  { key: "regular", name: "City Regular", icon: "▣", lane: "y", tiers: [25, 100, 250], how: "Play {n} games", kind: "career" },
  { key: "versatile", name: "Versatile", icon: "✦", lane: "b", tiers: [5, 10, 20], how: "Play {n} different heroes", kind: "career" },
  { key: "main", name: "One-Trick", icon: "♦", lane: "ink", tiers: [10, 25, 50], how: "Play {n} games on one hero", kind: "career" },
  { key: "ranked", name: "Ranked Regular", icon: "♛", lane: "y", tiers: [1, 10, 25], how: "Play {n} Ranked game(s)", kind: "career" },
];

export type AchResult = { key: string; best: number; tiers: { tier: number; earned_at: number; match_id: number }[] };

/** Walk a player's games oldest-first and record when each tier was first reached. `squadOf` = tracked teammates per game. */
export function evaluate(rows: Row[], squadOf: (m: Row) => number): AchResult[] {
  const out = new Map<string, AchResult>(ACHIEVEMENTS.map((d) => [d.key, { key: d.key, best: d.lower ? Infinity : 0, tiers: [] }]));
  let streak = 0, games = 0, ranked = 0; const heroes = new Map<number, number>();
  for (const m of [...rows].sort((a, b) => a.start_time - b.start_time)) {
    games++; if (m.match_mode === 4) ranked++; heroes.set(m.hero_id, (heroes.get(m.hero_id) ?? 0) + 1); streak = m.won ? streak + 1 : 0;
    const mins = m.duration_s / 60;
    const v: Record<string, number> = {
      spree: m.kills, untouchable: m.deaths === 0 ? m.kills + m.assists : 0, playmaker: m.assists, fat_stacks: m.net_worth,
      farmer: m.duration_s >= 900 ? (m.net_worth * 60) / m.duration_s : 0, kda: m.kills + m.assists >= 5 ? (m.kills + m.assists) / Math.max(1, m.deaths) : 0,
      speedrun: m.won && m.duration_s > 300 ? mins : Infinity, marathon: mins, squad: m.won ? squadOf(m) : 0,
      streak, regular: games, versatile: heroes.size, main: Math.max(...heroes.values()), ranked,
    };
    for (const d of ACHIEVEMENTS) {
      const r = out.get(d.key)!; const x = v[d.key];
      r.best = d.lower ? Math.min(r.best, x) : Math.max(r.best, x);
      d.tiers.forEach((t, i) => { if (r.tiers.some((e) => e.tier === i + 1)) return; if (d.lower ? x < t : x >= t) r.tiers.push({ tier: i + 1, earned_at: m.start_time, match_id: m.match_id }); });
    }
  }
  for (const r of out.values()) if (!Number.isFinite(r.best)) r.best = 0;
  return [...out.values()];
}

async function loadAll(env: Env) {
  const { results } = await env.DB.prepare("SELECT account_id, match_id, hero_id, start_time, duration_s, won, team, kills, deaths, assists, net_worth, match_mode FROM player_matches WHERE " + std()).all<Row>();
  const byMatch = new Map<number, Row[]>(); for (const r of results) byMatch.set(r.match_id, [...(byMatch.get(r.match_id) ?? []), r]);
  const squadOf = (m: Row) => (byMatch.get(m.match_id) ?? []).filter((o) => o.account_id !== m.account_id && o.team === m.team).length;
  return { results, squadOf };
}

/** Achievements for one player (for the profile). */
export async function achievementsFor(env: Env, accountId: number) {
  const { results, squadOf } = await loadAll(env);
  return evaluate(results.filter((r) => r.account_id === accountId), squadOf);
}

/** Recount everyone, store new unlocks, and announce fresh ones (earned in the last 2 days) to Discord. */
export async function refreshAchievements(env: Env, announce: boolean) {
  const { results, squadOf } = await loadAll(env);
  const ids = [...new Set(results.map((r) => r.account_id))];
  const { results: have } = await env.DB.prepare("SELECT account_id, key, tier FROM achievements").all<{ account_id: number; key: string; tier: number }>();
  const known = new Set(have.map((h) => `${h.account_id}:${h.key}:${h.tier}`));
  const fresh: { account_id: number; key: string; tier: number; earned_at: number; match_id: number }[] = [];
  for (const id of ids) for (const r of evaluate(results.filter((x) => x.account_id === id), squadOf)) for (const t of r.tiers) if (!known.has(`${id}:${r.key}:${t.tier}`)) fresh.push({ account_id: id, key: r.key, ...t });
  const stmt = env.DB.prepare("INSERT OR IGNORE INTO achievements(account_id, key, tier, earned_at, match_id) VALUES (?,?,?,?,?)");
  const batch = fresh.map((f) => stmt.bind(f.account_id, f.key, f.tier, f.earned_at, f.match_id));
  for (let i = 0; i < batch.length; i += 50) await env.DB.batch(batch.slice(i, i + 50));
  await setSetting(env, "ach_version", ACH_VERSION);
  const recent = fresh.filter((f) => f.earned_at > Date.now() / 1000 - 2 * 86400);
  if (!announce || !recent.length) return { added: fresh.length, announced: 0 };
  const s = await discordSettings(env); if (!s?.webhook) return { added: fresh.length, announced: 0 };
  const names = new Map((await env.DB.prepare("SELECT account_id, name, avatar_url FROM players").all<{ account_id: number; name: string; avatar_url: string | null }>()).results.map((p) => [p.account_id, p]));
  const ROMAN = ["", "I", "II", "III"];
  const embeds = recent.slice(0, 8).map((f) => { const d = ACHIEVEMENTS.find((x) => x.key === f.key)!; const p = names.get(f.account_id);
    return { color: 0xffd36b, author: { name: `${p?.name ?? f.account_id} unlocked ${d.name} ${ROMAN[f.tier]}`, icon_url: p?.avatar_url ?? undefined }, description: d.how.replace("{n}", d.tiers[f.tier - 1].toLocaleString("en-US")), url: s.origin ? `${s.origin}/player.html?id=${f.account_id}#achievements` : undefined, timestamp: new Date(f.earned_at * 1000).toISOString() }; });
  await discordPost(env, { embeds }).catch(() => {});
  return { added: fresh.length, announced: embeds.length };
}
