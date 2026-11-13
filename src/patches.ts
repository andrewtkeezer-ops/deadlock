import { DeadlockApi } from "./deadlock";
import type { Env } from "./types";
import { discordPost, discordSettings } from "./notify";
import { getSetting, setSetting } from "./settings";

/** Patch watch: the official notes (deadlock-api `/v2/patches`, Forum changelog + Steam news), split into one line per
 *  change and matched to heroes and shop items, so each friend sees what changed on the heroes they play. */
type FeedItem = { source: string; title: string; pub_date: string; link: string; guid?: { text?: string }; content?: string };
export type Change = { id: number; name: string; lines: string[] };
export type ParsedPatch = { id: string; title: string; date: number; link: string; source: string; heroes: Change[]; items: Change[]; general: string[]; total: number };

const decode = (s: string) => s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
export function changeLines(html: string): string[] {
  const text = decode(html.replace(/<(br|\/p|\/li|li|\/div|\/h\d)[^>]*>/gi, "\n").replace(/<[^>]+>/g, ""));
  return text.split("\n").flatMap((l) => l.split(/\s+-\s+(?=[A-Z0-9][^:\n]{1,48}:)/)).map((l) => l.trim().replace(/^[-•*]\s*/, "")).filter((l) => /^[^:]{2,48}:\s*\S/.test(l));
}

export async function parsedPatches(env: Env, limit = 12): Promise<ParsedPatch[]> {
  const api = new DeadlockApi(env);
  const [feed, heroes, items] = await Promise.all([api.get<FeedItem[]>("/v2/patches", {}, 3600), api.heroes(), api.items()]);
  const H = new Map(heroes.map((x) => [x.name.toLowerCase(), x])), I = new Map(items.map((x) => [x.name.toLowerCase(), x]));
  return feed.slice(0, limit).map((p) => {
    const hs = new Map<number, Change>(), is = new Map<number, Change>(), general: string[] = [];
    for (const line of changeLines(p.content ?? "")) {
      const name = line.slice(0, line.indexOf(":")).trim(), rest = line.slice(line.indexOf(":") + 1).trim(), k = name.toLowerCase();
      const hx = H.get(k), it = I.get(k);
      if (hx) { const c = hs.get(hx.id) ?? { id: hx.id, name: hx.name, lines: [] }; c.lines.push(rest); hs.set(hx.id, c); }
      else if (it) { const c = is.get(it.id) ?? { id: it.id, name: it.name, lines: [] }; c.lines.push(rest); is.set(it.id, c); }
      else general.push(line);
    }
    const heroesC = [...hs.values()], itemsC = [...is.values()];
    return { id: p.guid?.text || p.link, title: p.title.trim(), date: Math.floor(Date.parse(p.pub_date) / 1000), link: p.link, source: p.source, heroes: heroesC, items: itemsC, general: general.slice(0, 80), total: heroesC.reduce((n, c) => n + c.lines.length, 0) + itemsC.reduce((n, c) => n + c.lines.length, 0) + general.length };
  });
}

/** What each friend cares about: their most played heroes (60 days) and the items in builds they saved. */
export async function squadInterests(env: Env) {
  const since = Math.floor(Date.now() / 1000) - 60 * 86400;
  const [{ results: players }, { results: games }, { results: builds }] = await Promise.all([
    env.DB.prepare("SELECT account_id, name, avatar_url FROM players").all<{ account_id: number; name: string; avatar_url: string | null }>(),
    env.DB.prepare("SELECT account_id, hero_id, COUNT(*) n FROM player_matches WHERE start_time>? GROUP BY account_id, hero_id ORDER BY n DESC").bind(since).all<{ account_id: number; hero_id: number; n: number }>(),
    env.DB.prepare("SELECT account_id, details FROM builds WHERE account_id IS NOT NULL").all<{ account_id: number; details: string | null }>(),
  ]);
  return players.map((p) => {
    const items = new Set<number>(); for (const b of builds) if (b.account_id === p.account_id) try { for (const c of JSON.parse(b.details || "{}").mod_categories ?? []) for (const m of c.mods ?? []) items.add(m.ability_id); } catch {}
    return { ...p, heroes: games.filter((g) => g.account_id === p.account_id).slice(0, 6).map((g) => ({ hero_id: g.hero_id, games: g.n })), items: [...items] };
  });
}

/** Called from the sync: when a new patch with gameplay changes lands, tell Discord which friends' heroes it touches. */
export async function patchWatch(env: Env) {
  const patches = await parsedPatches(env, 6); const latest = patches.find((p) => p.heroes.length || p.items.length); if (!latest) return;
  const seen = await getSetting<string>(env, "patch_seen"); if (seen === latest.id) return;
  await setSetting(env, "patch_seen", latest.id);
  if (!seen) return; // first run: remember, don't announce an old patch
  const s = await discordSettings(env); if (!s?.webhook) return;
  const squad = await squadInterests(env);
  const lines = squad.map((p) => { const hit = latest.heroes.filter((c) => p.heroes.some((h) => h.hero_id === c.id)); return hit.length ? `**${p.name}**: ${hit.map((c) => `${c.name} (${c.lines.length})`).join(", ")}` : null; }).filter(Boolean);
  await discordPost(env, { embeds: [{ color: 0xdd6638, title: `Patch: ${latest.title}`, url: s.origin ? `${s.origin}/patches.html` : latest.link,
    description: `${latest.heroes.length} heroes and ${latest.items.length} items changed.${lines.length ? "\n\n" + lines.join("\n") : ""}`, timestamp: new Date(latest.date * 1000).toISOString() }] }).catch(() => {});
}

/** Patch impact: for the latest balance patches, how each changed hero did in the 14 days before the patch and since it
 *  (until the next balance patch), for the squad (stored games) and for everyone (deadlock-api hero stats). */
export async function patchImpact(env: Env, count = 3) {
  const DAY = 86400, now = Math.floor(Date.now() / 1000), api = new DeadlockApi(env);
  const balance = (await parsedPatches(env, 15)).filter((p) => p.heroes.length && p.date > 0).sort((a, b) => b.date - a.date);
  const out = [];
  for (let i = 0; i < Math.min(count, balance.length); i++) {
    const p = balance[i], since = p.date, until = i > 0 ? balance[i - 1].date : now, from = since - 14 * DAY, ids = p.heroes.map((h) => h.id);
    const { results } = await env.DB.prepare(`SELECT hero_id, SUM(CASE WHEN start_time<? THEN 1 ELSE 0 END) bg, SUM(CASE WHEN start_time<? THEN won ELSE 0 END) bw, SUM(CASE WHEN start_time>=? THEN 1 ELSE 0 END) ag, SUM(CASE WHEN start_time>=? THEN won ELSE 0 END) aw
        FROM player_matches WHERE start_time>=? AND start_time<? AND hero_id IN (${ids.map(() => "?").join(",")}) GROUP BY hero_id`).bind(since, since, since, since, from, until, ...ids).all<{ hero_id: number; bg: number; bw: number; ag: number; aw: number }>();
    // Everyone's win rate either side of the patch. Needs at least a day of games after it to mean anything; upstream trouble just leaves it out.
    const [gb, ga] = until - since >= DAY ? await Promise.all([api.heroStats({ min_unix_timestamp: from, max_unix_timestamp: since }).catch(() => null), api.heroStats({ min_unix_timestamp: since, max_unix_timestamp: until }).catch(() => null)]) : [null, null];
    const wr = (rows: { hero_id: number; wins: number; matches: number }[] | null, id: number) => { const r = rows?.find((x) => x.hero_id === id); return r && r.matches >= 200 ? r.wins / r.matches : null; };
    out.push({ id: p.id, since, until, days_after: Math.round(((until - since) / DAY) * 10) / 10,
      heroes: ids.map((id) => { const s = results.find((r) => r.hero_id === id); return { id, squad: { before: [s?.bg ?? 0, s?.bw ?? 0], after: [s?.ag ?? 0, s?.aw ?? 0] }, global: { before: wr(gb, id), after: wr(ga, id) } }; }) });
  }
  return out;
}
