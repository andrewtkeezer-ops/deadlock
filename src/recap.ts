import type { Env } from "./types";
import { discordPost, discordSettings } from "./notify";
import { getSetting, setSetting } from "./settings";

/**
 * Squad page data: the weekly recap and the all-time records wall. Both are derived from stored games (player_matches),
 * so they cost a handful of D1 reads and no upstream calls.
 *
 * Weeks run Monday 08:00 UTC to the next Monday 08:00 UTC (4 a.m. Atlantic in winter, 5 a.m. in summer), so a Sunday
 * night session that runs past midnight still counts toward the week it started in.
 */
const DAY = 86400, WEEK = 7 * DAY, ANCHOR = 8 * 3600;
export function weekWindow(offset = 0, now = Math.floor(Date.now() / 1000)) {
  const dayNo = Math.floor((now - ANCHOR) / DAY);            // epoch day 0 was a Thursday
  const start = (dayNo - ((dayNo + 3) % 7)) * DAY + ANCHOR - offset * WEEK;
  return { start, end: start + WEEK };
}

type Row = { account_id: number; match_id: number; hero_id: number; start_time: number; duration_s: number; won: number; kills: number; deaths: number; assists: number; net_worth: number };
type Who = { account_id: number; name: string; avatar_url: string | null };
export type Award = { key: string; title: string; account_id: number; value: string; blurb: string; match_id?: number; hero_id?: number };

const kdaOf = (k: number, d: number, a: number) => (k + a) / Math.max(1, d);

export async function weeklyRecap(env: Env, offset = 0) {
  const { start, end } = weekWindow(offset);
  const [players, rows, prev, mmr] = await Promise.all([
    env.DB.prepare("SELECT account_id, name, avatar_url FROM players").all<Who>(),
    env.DB.prepare("SELECT account_id, match_id, hero_id, start_time, duration_s, won, kills, deaths, assists, net_worth FROM player_matches WHERE start_time>=? AND start_time<? ORDER BY start_time").bind(start, end).all<Row>(),
    env.DB.prepare("SELECT COUNT(*) games, COALESCE(SUM(won),0) wins FROM player_matches WHERE start_time>=? AND start_time<?").bind(start - WEEK, start).first<{ games: number; wins: number }>(),
    env.DB.prepare("SELECT account_id, ts, score FROM mmr_history WHERE ts>=? AND ts<? AND score IS NOT NULL ORDER BY ts").bind(start - 2 * WEEK, end).all<{ account_id: number; ts: number; score: number }>(),
  ]);
  const games = rows.results, matchIds = new Set(games.map((g) => g.match_id));
  const secs = [...new Map(games.map((g) => [g.match_id, g.duration_s])).values()].reduce((a, b) => a + b, 0);

  const table = players.results.map((p) => {
    const mine = games.filter((g) => g.account_id === p.account_id); const n = mine.length, wins = mine.reduce((s, g) => s + g.won, 0);
    const k = mine.reduce((s, g) => s + g.kills, 0), d = mine.reduce((s, g) => s + g.deaths, 0), a = mine.reduce((s, g) => s + g.assists, 0);
    let streak = 0, cur = 0; for (const g of mine) { cur = g.won ? cur + 1 : 0; streak = Math.max(streak, cur); }
    const hist = mmr.results.filter((m) => m.account_id === p.account_id), before = hist.filter((m) => m.ts < start).at(-1) ?? hist.find((m) => m.ts >= start), after = hist.filter((m) => m.ts >= start).at(-1);
    return { ...p, games: n, wins, losses: n - wins, kills: k, deaths: d, assists: a, kda: n ? kdaOf(k, d, a) : 0, spm: n ? mine.reduce((s, g) => s + (g.net_worth * 60) / Math.max(60, g.duration_s), 0) / n : 0,
      streak, hours: mine.reduce((s, g) => s + g.duration_s, 0) / 3600, mmr_delta: before && after ? Math.round((after.score - before.score) * 10) / 10 : null };
  }).filter((p) => p.games > 0).sort((x, y) => y.wins - y.losses - (x.wins - x.losses) || y.kda - x.kda);

  const awards: Award[] = [], reg = table.filter((p) => p.games >= 3), best = <T>(list: T[], f: (x: T) => number) => list.reduce<T | null>((b, x) => (b === null || f(x) > f(b) ? x : b), null);
  const mvp = reg[0];
  if (mvp) awards.push({ key: "mvp", title: "Player of the week", account_id: mvp.account_id, value: `${mvp.wins}–${mvp.losses}`, blurb: `KDA ${mvp.kda.toFixed(2)} across ${mvp.games} games` });
  const sharp = best(reg, (p) => p.kda); if (sharp) awards.push({ key: "kda", title: "Sharpest", account_id: sharp.account_id, value: `KDA ${sharp.kda.toFixed(2)}`, blurb: `${sharp.kills}/${sharp.deaths}/${sharp.assists} over the week` });
  const farm = best(reg, (p) => p.spm); if (farm) awards.push({ key: "farm", title: "Soul hoarder", account_id: farm.account_id, value: `${Math.round(farm.spm).toLocaleString("en-US")}/min`, blurb: "best average souls per minute" });
  const grind = best(table, (p) => p.games); if (grind && grind.games >= 3) awards.push({ key: "grind", title: "Night shift", account_id: grind.account_id, value: `${grind.games} games`, blurb: `${grind.hours.toFixed(1)} hours in the city` });
  const roll = best(table, (p) => p.streak); if (roll && roll.streak >= 3) awards.push({ key: "streak", title: "On a roll", account_id: roll.account_id, value: `${roll.streak} wins`, blurb: "in a row" });
  const climb = best(table.filter((p) => (p.mmr_delta ?? 0) > 0), (p) => p.mmr_delta ?? 0); if (climb) awards.push({ key: "climb", title: "Biggest climb", account_id: climb.account_id, value: `+${climb.mmr_delta} MMR`, blurb: "rank gained this week" });
  const top = best(games, (g) => kdaOf(g.kills, g.deaths, g.assists) + g.kills / 1000);
  if (top) awards.push({ key: "game", title: "Game of the week", account_id: top.account_id, value: `${top.kills}/${top.deaths}/${top.assists}`, blurb: `KDA ${kdaOf(top.kills, top.deaths, top.assists).toFixed(1)}, ${top.won ? "a win" : "in a loss"}`, match_id: top.match_id, hero_id: top.hero_id });
  const body = best(games, (g) => g.kills); if (body && body.kills >= 10 && body !== top) awards.push({ key: "kills", title: "Body count", account_id: body.account_id, value: `${body.kills} kills`, blurb: "most in one game", match_id: body.match_id, hero_id: body.hero_id });
  const rough = best(games, (g) => g.deaths); if (rough && rough.deaths >= 10) awards.push({ key: "rough", title: "Rough night", account_id: rough.account_id, value: `${rough.deaths} deaths`, blurb: "it happens to everyone", match_id: rough.match_id, hero_id: rough.hero_id });

  const byHero = new Map<number, { hero_id: number; games: number; wins: number }>(); for (const g of games) { const h = byHero.get(g.hero_id) ?? { hero_id: g.hero_id, games: 0, wins: 0 }; h.games++; h.wins += g.won; byHero.set(g.hero_id, h); }
  const wins = games.reduce((s, g) => s + g.won, 0);
  return { offset, start, end, complete: end <= Math.floor(Date.now() / 1000),
    totals: { games: games.length, matches: matchIds.size, wins, win_rate: games.length ? wins / games.length : null, hours: secs / 3600, kills: games.reduce((s, g) => s + g.kills, 0) },
    prev: { games: prev?.games ?? 0, win_rate: prev?.games ? (prev.wins ?? 0) / prev.games : null },
    players: table, awards, heroes: [...byHero.values()].sort((x, y) => y.games - x.games).slice(0, 5) };
}

const dateS = (t: number) => new Date(t * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Halifax" });

/** Post one week's recap to Discord. Returns why it didn't when it doesn't. */
export async function postWeeklyRecap(env: Env, offset = 1): Promise<{ sent: boolean; reason?: string }> {
  const s = await discordSettings(env); if (!s?.webhook) return { sent: false, reason: "no webhook" };
  const r = await weeklyRecap(env, offset); if (!r.totals.games) return { sent: false, reason: "no games that week" };
  const name = (id: number) => r.players.find((p) => p.account_id === id)?.name ?? "?";
  const delta = r.totals.win_rate != null && r.prev.win_rate != null ? Math.round((r.totals.win_rate - r.prev.win_rate) * 100) : null;
  const lines = [`**${r.totals.matches} matches** · ${Math.round((r.totals.win_rate ?? 0) * 100)}% win rate${delta != null ? ` (${delta >= 0 ? "+" : "−"}${Math.abs(delta)} pts on the week before)` : ""} · ${r.totals.hours.toFixed(1)} hours`, "",
    ...r.awards.map((a) => `**${a.title}**: ${name(a.account_id)} · ${a.value} (${a.blurb})`)];
  return discordPost(env, { embeds: [{ color: 0xe8c76a, title: `Weekly recap · ${dateS(r.start)} to ${dateS(r.end - DAY)}`, url: s.origin ? `${s.origin}/squad.html` : undefined, description: lines.join("\n").slice(0, 3900) }] });
}

/** Called from the cron: once a new week has started, post the finished one (once). The very first run only remembers the week, so deploying this never surprises the channel. */
export async function recapWatch(env: Env) {
  const id = String(weekWindow(1).start), seen = await getSetting<string>(env, "recap_posted");
  if (seen === id) return;
  await setSetting(env, "recap_posted", id);
  if (!seen) return;
  const s = await discordSettings(env); if (!s?.webhook || s.recap === false) return;
  await postWeeklyRecap(env, 1).catch((e) => console.error("recap", e));
}

/** All-time bests across everyone tracked. Each record lists the top three players (one entry per player). */
const SINGLE: { key: string; title: string; expr: string; where?: string; asc?: boolean; fmt: "int" | "kda" | "time" }[] = [
  { key: "kills", title: "Most kills in a game", expr: "kills", fmt: "int" },
  { key: "assists", title: "Most assists in a game", expr: "assists", fmt: "int" },
  { key: "kda", title: "Best KDA in a game", expr: "(kills+assists)*1.0/MAX(1,deaths)", where: "duration_s>=600", fmt: "kda" },
  { key: "souls", title: "Richest game", expr: "net_worth", fmt: "int" },
  { key: "spm", title: "Fastest farm (souls per minute)", expr: "net_worth*60.0/duration_s", where: "duration_s>=900", fmt: "int" },
  { key: "last_hits", title: "Most last hits", expr: "last_hits", fmt: "int" },
  { key: "denies", title: "Most denies", expr: "denies", fmt: "int" },
  { key: "long", title: "Longest game", expr: "duration_s", fmt: "time" },
  { key: "fast", title: "Fastest win", expr: "duration_s", where: "won=1 AND duration_s>=600", asc: true, fmt: "time" },
  { key: "deaths", title: "Most deaths in a game", expr: "deaths", fmt: "int" },
];
export async function squadRecords(env: Env) {
  const [players, career, streakRows, heroRows, ...single] = await Promise.all([
    env.DB.prepare("SELECT account_id, name, avatar_url FROM players").all<Who>(),
    env.DB.prepare("SELECT account_id, COUNT(*) games, SUM(won) wins, SUM(kills) kills, SUM(assists) assists, SUM(duration_s) secs, COUNT(DISTINCT hero_id) heroes FROM player_matches GROUP BY account_id").all<{ account_id: number; games: number; wins: number; kills: number; assists: number; secs: number; heroes: number }>(),
    env.DB.prepare("SELECT account_id, won FROM player_matches ORDER BY account_id, start_time").all<{ account_id: number; won: number }>(),
    env.DB.prepare("SELECT account_id, hero_id, COUNT(*) n, SUM(won) w FROM player_matches GROUP BY account_id, hero_id ORDER BY n DESC LIMIT 40").all<{ account_id: number; hero_id: number; n: number; w: number }>(),
    ...SINGLE.map((m) => env.DB.prepare(`SELECT account_id, match_id, hero_id, start_time, ${m.asc ? "MIN" : "MAX"}(${m.expr}) v FROM player_matches ${m.where ? "WHERE " + m.where : ""} GROUP BY account_id ORDER BY v ${m.asc ? "ASC" : "DESC"} LIMIT 3`).all<{ account_id: number; match_id: number; hero_id: number; start_time: number; v: number }>()),
  ]);
  const streak = new Map<number, number>(); { let who = 0, cur = 0; for (const r of streakRows.results) { if (r.account_id !== who) { who = r.account_id; cur = 0; } cur = r.won ? cur + 1 : 0; if (cur > (streak.get(who) ?? 0)) streak.set(who, cur); } }
  const c = career.results, top3 = <T>(list: T[], f: (x: T) => number) => [...list].sort((a, b) => f(b) - f(a)).slice(0, 3);
  const careerRec = [
    { key: "games", title: "Most games played", fmt: "int", top: top3(c, (x) => x.games).map((x) => ({ account_id: x.account_id, v: x.games })) },
    { key: "wins", title: "Most wins", fmt: "int", top: top3(c, (x) => x.wins).map((x) => ({ account_id: x.account_id, v: x.wins })) },
    { key: "winrate", title: "Best win rate (20+ games)", fmt: "pct", top: top3(c.filter((x) => x.games >= 20), (x) => x.wins / x.games).map((x) => ({ account_id: x.account_id, v: x.wins / x.games, note: `${x.games} games` })) },
    { key: "streak", title: "Longest win streak", fmt: "int", top: top3([...streak].map(([account_id, v]) => ({ account_id, v })), (x) => x.v).filter((x) => x.v > 1) },
    { key: "hours", title: "Most hours in matches", fmt: "hours", top: top3(c, (x) => x.secs).map((x) => ({ account_id: x.account_id, v: x.secs / 3600 })) },
    { key: "pool", title: "Widest hero pool", fmt: "int", top: top3(c, (x) => x.heroes).map((x) => ({ account_id: x.account_id, v: x.heroes, note: "heroes played" })) },
    { key: "main", title: "Most games on one hero", fmt: "int", top: heroRows.results.slice(0, 3).map((x) => ({ account_id: x.account_id, v: x.n, hero_id: x.hero_id, note: `${Math.round((x.w / x.n) * 100)}% wins` })) },
  ].filter((r) => r.top.length);
  return { players: players.results, total_games: c.reduce((s, x) => s + x.games, 0),
    game: SINGLE.map((m, i) => ({ key: m.key, title: m.title, fmt: m.fmt, top: single[i].results.filter((r) => r.v != null) })).filter((r) => r.top.length), career: careerRec };
}
