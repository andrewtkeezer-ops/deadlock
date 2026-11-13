import { Hono } from "hono";
import { std } from "../modes";
import type { Env } from "../types";
import { DeadlockApi, type ItemAsset } from "../deadlock";
import { STAT_MAP } from "./builds";

const r = new Hono<{ Bindings: Env }>();
r.use("/:id/*", async (c, next) => { if (c.req.param("id") && !/^\d+$/.test(c.req.param("id")!)) return c.json({ error: "bad_request", message: "hero id must be numeric" }, 400); await next(); });

/** Hero list (static assets) — names, images. */
r.get("/", async (c) => {
  const heroes = await new DeadlockApi(c.env).heroes();
  // Match the in-game select screen: everything not disabled. New heroes ship flagged in_development but
  // player_selectable (Violet, Baba), and a locked "coming soon" hero (Nurse Harrow) is enabled but not yet selectable.
  return c.json(heroes.filter((h) => !h.disabled).sort((a, b) => a.name.localeCompare(b.name)));
});

/** Win/pick rates. Query passthrough: ?min_average_badge=&max_average_badge=&min_unix_timestamp= */
r.get("/stats", async (c) => {
  const api = new DeadlockApi(c.env);
  const q = Object.fromEntries(new URL(c.req.url).searchParams);
  const [stats, heroes] = await Promise.all([api.heroStats(q), api.heroes()]);
  const names = new Map(heroes.map((h) => [h.id, h.name]));
  const total = stats.reduce((s, h) => s + h.matches, 0);
  return c.json(
    stats
      .map((h) => ({ hero_id: h.hero_id, name: names.get(h.hero_id) ?? String(h.hero_id), matches: h.matches, wins: h.wins,
        win_rate: h.matches ? h.wins / h.matches : 0, pick_rate: total ? (h.matches * 6) / total : 0 }))
      .sort((a, b) => b.win_rate - a.win_rate)
  );
});

/**
 * Pick suggester. Given allies (your team so far) and enemies, rank every hero by
 *   score = mean(synergy win rate with each ally) + mean(counter win rate vs each enemy)
 * ?allies=1,2&enemies=5,6&min_matches=200
 */
r.get("/suggest", async (c) => {
  const api = new DeadlockApi(c.env);
  const parse = (s?: string) => (s ? s.split(",").map(Number).filter(Boolean) : []);
  const allies = parse(c.req.query("allies"));
  const enemies = parse(c.req.query("enemies"));
  const minMatches = Number(c.req.query("min_matches") ?? 100);
  const q = { min_unix_timestamp: c.req.query("min_unix_timestamp") };

  const [synergy, counter, heroes] = await Promise.all([api.heroSynergyStats(q), api.heroCounterStats(q), api.heroes()]);

  // Synergy rows are symmetric pairs (hero_id, hero_id2). Counter rows are (hero_id vs enemy_id).
  const syn = new Map<string, number>();
  for (const s of synergy) {
    if (s.matches_played < minMatches) continue;
    const wr = s.wins / s.matches_played;
    syn.set(`${s.hero_id1}:${s.hero_id2}`, wr);
    syn.set(`${s.hero_id2}:${s.hero_id1}`, wr);
  }
  const ctr = new Map<string, number>();
  for (const s of counter) if (s.matches_played >= minMatches) ctr.set(`${s.hero_id}:${s.enemy_hero_id}`, s.wins / s.matches_played);

  const taken = new Set([...allies, ...enemies]);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0.5);
  const out = heroes
    .filter((h) => h.player_selectable !== false && !h.disabled && !taken.has(h.id))
    .map((h) => {
      const synD = allies.map((a) => ({ id: a, wr: syn.get(`${h.id}:${a}`) })).filter((x): x is { id: number; wr: number } => x.wr !== undefined);
      const ctrD = enemies.map((e) => ({ id: e, wr: ctr.get(`${h.id}:${e}`) })).filter((x): x is { id: number; wr: number } => x.wr !== undefined);
      const synWr = synD.map((x) => x.wr), ctrWr = ctrD.map((x) => x.wr);
      const bestWith = synD.length ? synD.reduce((b, x) => (x.wr > b.wr ? x : b)) : null, bestVs = ctrD.length ? ctrD.reduce((b, x) => (x.wr > b.wr ? x : b)) : null, worstVs = ctrD.length ? ctrD.reduce((b, x) => (x.wr < b.wr ? x : b)) : null;
      return { hero_id: h.id, name: h.name, synergy: avg(synWr), counter: avg(ctrWr),
        score: (avg(synWr) - 0.5) + (avg(ctrWr) - 0.5), samples: synWr.length + ctrWr.length,
        best_with: bestWith, best_vs: bestVs, worst_vs: worstVs, tags: h.tags ?? [], hero_type: h.hero_type ?? null };
    })
    .sort((a, b) => b.score - a.score);
  return c.json({ allies, enemies, suggestions: out });
});

/** Squad members' record on this hero, from our D1 copy (one query instead of one per player). */
r.get("/:id/squad", async (c) => {
  const id = Number(c.req.param("id"));
  const { results } = await c.env.DB.prepare(
    `SELECT p.account_id, p.name, p.avatar_url, p.mmr_rank, COUNT(*) games, SUM(m.won) wins, AVG(m.kills) k, AVG(m.deaths) d, AVG(m.assists) a,
            AVG(m.net_worth*60.0/NULLIF(m.duration_s,0)) spm, AVG(m.hero_damage) dmg, MAX(m.start_time) last_played
       FROM player_matches m JOIN players p ON p.account_id=m.account_id WHERE m.hero_id=? AND ${std("m")} GROUP BY p.account_id ORDER BY games DESC`).bind(id).all();
  return c.json(results);
});

/**
 * "Squad's best build" for a hero: for each squad build, look at the squad's recent matches on this hero and
 * score how often the final item set overlapped with the build. Cheap, honest, and improves as data accrues.
 */
r.get("/:id/best-build", async (c) => {
  const id = Number(c.req.param("id"));
  const [{ results: builds }, { results: metas }] = await Promise.all([
    c.env.DB.prepare("SELECT b.id, b.title, b.details, b.account_id, p.name author_name FROM builds b LEFT JOIN players p ON p.account_id=b.account_id WHERE b.hero_id=?").bind(id).all<{ id: number; title: string; details: string; account_id: number; author_name: string | null }>(),
    c.env.DB.prepare("SELECT mm.json, pm.account_id, pm.won FROM player_matches pm JOIN match_meta mm ON mm.match_id=pm.match_id WHERE pm.hero_id=? AND " + std("pm") + " ORDER BY pm.start_time DESC LIMIT 60").bind(id).all<{ json: string; account_id: number; won: number }>(),
  ]);
  if (!builds.length) return c.json(null);
  const games = metas.map((m) => { const mi = JSON.parse(m.json).match_info; const me = mi?.players?.find((p: { account_id: number }) => p.account_id === m.account_id); const held = new Set<number>();
    for (const it of me?.items ?? []) if (it.sold_time_s) held.delete(it.item_id); else held.add(it.item_id); return { held, won: !!m.won }; });
  const scored = builds.map((b) => { const ids = new Set<number>(); try { for (const cat of JSON.parse(b.details).mod_categories ?? []) for (const m of cat.mods ?? []) ids.add(m.ability_id); } catch {}
    let used = 0, wins = 0; for (const g of games) { const overlap = [...ids].filter((x) => g.held.has(x)).length; if (ids.size && overlap / ids.size >= 0.5) { used++; if (g.won) wins++; } }
    return { id: b.id, title: b.title, author_name: b.author_name, items: ids.size, games_using: used, wins_using: wins, win_rate: used ? wins / used : null }; })
    .sort((a, b) => (b.games_using - a.games_using) || ((b.win_rate ?? 0) - (a.win_rate ?? 0)));
  return c.json({ sample_games: games.length, builds: scored });
});

/** Gun numbers for the DPS calculator. */
r.get("/:id/weapon", async (c) => c.json(await new DeadlockApi(c.env).heroWeapon(Number(c.req.param("id")))));

/** The hero's four abilities (icons, descriptions, tiers, numbers). */
r.get("/:id/abilities", async (c) => c.json(await new DeadlockApi(c.env).heroAbilities(Number(c.req.param("id")))));

type InGameBuild = { hero_build: { hero_build_id: number; name: string; author_account_id: number; description?: string; last_updated_timestamp: number; version?: number;
  details?: { mod_categories?: { name: string; description?: string; mods: { ability_id: number; annotation?: string | null }[] }[] } }; num_favorites?: number; num_weekly_favorites?: number | null };

const LEAN_GROUPS: Record<string, string[]> = {
  weapon: ["weapon_damage", "fire_rate", "ammo", "range"],
  spirit: ["spirit", "cooldown"],
  vitality: ["health", "spirit_resist", "bullet_resist", "regen", "lifesteal", "move_speed"],
};
const LEAN_LABEL: Record<string, string> = { weapon: "Weapon / gun", spirit: "Spirit", vitality: "Survivability", balanced: "Balanced" };

/** Classify an in-game build by where its items' stats point. */
function profileBuild(b: InGameBuild, byId: Map<number, ItemAsset>, maxPerStat: Record<string, number>) {
  const ids = [...new Set((b.hero_build.details?.mod_categories ?? []).flatMap((cat) => cat.mods.map((m) => m.ability_id)))].filter((i) => byId.has(i));
  const score: Record<string, number> = { weapon: 0, spirit: 0, vitality: 0 };
  const slots: Record<string, number> = { weapon: 0, spirit: 0, vitality: 0 };
  for (const i of ids) {
    const it = byId.get(i)!; if (it.item_slot_type) slots[it.item_slot_type]++;
    for (const [grp, stats] of Object.entries(LEAN_GROUPS)) for (const st of stats) { const v = STAT_MAP[st].keys.reduce((acc, k) => acc + (it.properties[k] ?? 0), 0); if (v && maxPerStat[st]) score[grp] += v / maxPerStat[st]; }
  }
  // blend stat leaning with slot distribution so an all-spirit-slot build reads as spirit even if its numbers are modest
  const tot = Object.values(score).reduce((a, x) => a + x, 0) || 1, stot = ids.length || 1;
  const share = Object.fromEntries(Object.keys(score).map((k) => [k, 0.6 * score[k] / tot + 0.4 * slots[k] / stot]));
  const top = Object.entries(share).sort((a, b) => b[1] - a[1])[0];
  const lean = top[1] >= 0.45 ? top[0] : "balanced";
  return { ids, share, lean };
}

const looksEnglish = (name: string) => !/[\u3040-\u30ff\u3400-\u9fff\u0400-\u04ff\u0600-\u06ff\uac00-\ud7af]/.test(name);

async function communityBuilds(env: Env, id: number) {
  const api = new DeadlockApi(env);
  const [rows, its] = await Promise.all([api.get<InGameBuild[]>(`/v1/builds`, { hero_id: id, limit: 40, sort_by: "favorites", sort_direction: "desc", only_latest: "true" }, 6 * 3600), api.items()]);
  const byId = new Map(its.map((i) => [i.id, i])); const maxPerStat: Record<string, number> = {};
  for (const it of its) for (const [st, def] of Object.entries(STAT_MAP)) maxPerStat[st] = Math.max(maxPerStat[st] ?? 0, def.keys.reduce((a, k) => a + (it.properties[k] ?? 0), 0));
  const out = rows.filter((b) => looksEnglish(b.hero_build.name) && (b.hero_build.details?.mod_categories?.length ?? 0) > 0).map((b) => { const p = profileBuild(b, byId, maxPerStat);
    return { id: b.hero_build.hero_build_id, name: b.hero_build.name, author: b.hero_build.author_account_id, favorites: b.num_favorites ?? 0, updated: b.hero_build.last_updated_timestamp, lean: p.lean, lean_label: LEAN_LABEL[p.lean], share: p.share, item_count: p.ids.length,
      categories: (b.hero_build.details?.mod_categories ?? []).map((cat) => ({ name: cat.name, items: cat.mods.map((m) => m.ability_id).filter((i) => byId.has(i)) })) }; });
  return out;
}

/** Top community builds (most favourited, English-named), with their lean. */
r.get("/:id/builds", async (c) => c.json(await communityBuilds(c.env, Number(c.req.param("id")))));

/** Starter picks: the most-favourited build for each lean (weapon / spirit / survivability) plus the best balanced one. */
r.get("/:id/starter-builds", async (c) => {
  const all = await communityBuilds(c.env, Number(c.req.param("id")));
  const pick = (lean: string) => all.find((b) => b.lean === lean) ?? null;
  return c.json({ weapon: pick("weapon"), spirit: pick("spirit"), vitality: pick("vitality"), balanced: pick("balanced"), labels: LEAN_LABEL });
});

/** Raw counter/synergy tables for one hero — for the "who beats X" page. */
r.get("/:id/matchups", async (c) => {
  const id = Number(c.req.param("id"));
  const api = new DeadlockApi(c.env);
  const [synergy, counter, heroes] = await Promise.all([api.heroSynergyStats(), api.heroCounterStats(), api.heroes()]);
  const names = new Map(heroes.map((h) => [h.id, h.name]));
  const counters = counter.filter((s) => s.hero_id === id).map((s) => ({ hero_id: s.enemy_hero_id, name: names.get(s.enemy_hero_id), win_rate: s.wins / s.matches_played, matches: s.matches_played }));
  const synergies = synergy.filter((s) => s.hero_id1 === id || s.hero_id2 === id).map((s) => {
    const other = s.hero_id1 === id ? s.hero_id2 : s.hero_id1;
    return { hero_id: other, name: names.get(other), win_rate: s.wins / s.matches_played, matches: s.matches_played };
  });
  return c.json({ hero_id: id, name: names.get(id), counters: counters.sort((a, b) => a.win_rate - b.win_rate), synergies: synergies.sort((a, b) => b.win_rate - a.win_rate) });
});

const DAY = 86400, nowS = () => Math.floor(Date.now() / 1000);

/** Skill order: the most played ability-upgrade orders over the last 3 weeks (deadlock-api ability-order-stats), with
 *  win rates and when each point usually goes in. Orders are compared on the first 12 points. */
r.get("/:id/skill-order", async (c) => {
  const id = Number(c.req.param("id")); const api = new DeadlockApi(c.env);
  type Row = { abilities: number[]; avg_upgrade_times_s: number[]; wins: number; losses: number; matches: number };
  const [rows, abilities] = await Promise.all([api.get<Row[]>("/v1/analytics/ability-order-stats", { hero_id: id, min_matches: 30, min_unix_timestamp: nowS() - 21 * DAY }, 6 * 3600), api.heroAbilities(id)]);
  const merged = new Map<string, Row>();
  for (const r0 of rows) { const k = r0.abilities.slice(0, 12).join(","); const m = merged.get(k); if (!m) merged.set(k, { ...r0, abilities: r0.abilities.slice(0, 16), avg_upgrade_times_s: r0.avg_upgrade_times_s.slice(0, 16) }); else { m.wins += r0.wins; m.losses += r0.losses; m.matches += r0.matches; } }
  const all = [...merged.values()].sort((a, b) => b.matches - a.matches); const total = all.reduce((n, r0) => n + r0.matches, 0);
  const popular = all.slice(0, 4), floor = Math.max(100, (popular[0]?.matches ?? 0) * 0.08);
  const best = [...all].filter((r0) => r0.matches >= floor).sort((a, b) => b.wins / b.matches - a.wins / a.matches)[0];
  const pick = [...popular]; if (best && !pick.includes(best)) pick.push(best);
  return c.json({ abilities, total, orders: pick.map((r0) => ({ abilities: r0.abilities, times: r0.avg_upgrade_times_s.map((t) => Math.round(t)), matches: r0.matches, share: total ? r0.matches / total : 0, win_rate: r0.wins / Math.max(1, r0.matches), best: r0 === best })) });
});

/** Build path: which items win most in each phase of the game (0-9, 9-20, 20-30, 30+ min), from item-flow-stats.
 *  Uses the wealth-adjusted win rate so items bought by players already ahead don't look better than they are. */
r.get("/:id/build-path", async (c) => {
  const id = Number(c.req.param("id")); const api = new DeadlockApi(c.env);
  type Node = { column: number; item_id: number; wins: number; matches: number; adjusted_win_rate: number; avg_net_worth_at_buy: number };
  const [flow, items] = await Promise.all([api.get<{ nodes: Node[]; reached_per_column?: number[]; reached_wins_per_column?: number[] }>("/v1/analytics/item-flow-stats", { hero_ids: id, min_unix_timestamp: nowS() - 21 * DAY, min_matches: 30 }, 6 * 3600), api.items()]);
  const shop = new Set(items.map((i) => i.id)); const LABELS = ["0–9 min", "9–20 min", "20–30 min", "30+ min"];
  const columns = LABELS.map((label, col) => {
    const reached = flow.reached_per_column?.[col] ?? 0, base = reached ? (flow.reached_wins_per_column?.[col] ?? 0) / reached : null;
    const nodes = flow.nodes.filter((n) => n.column === col && shop.has(n.item_id) && n.matches >= Math.max(40, reached * 0.03));
    const fmtN = (n: Node) => ({ item_id: n.item_id, matches: n.matches, pick_rate: reached ? n.matches / reached : null, win_rate: n.adjusted_win_rate, raw_win_rate: n.wins / n.matches, souls_at_buy: Math.round(n.avg_net_worth_at_buy) });
    return { label, reached, base_win_rate: base, best: [...nodes].sort((a, b) => b.adjusted_win_rate - a.adjusted_win_rate).slice(0, 6).map(fmtN), popular: [...nodes].sort((a, b) => b.matches - a.matches).slice(0, 6).map(fmtN) };
  });
  return c.json({ columns });
});

/** Laning: best lane partners for this hero and the enemy duos it struggles against (souls lead at 15 min + win rate). */
r.get("/:id/laning", async (c) => {
  const id = Number(c.req.param("id")); const api = new DeadlockApi(c.env);
  type Lane = { hero_ids: number[]; enemy_hero_ids: number[]; wins: number; matches_played: number; net_worth_diff: number };
  const q = { hero_ids: id, min_unix_timestamp: nowS() - 30 * DAY, sample_time_s: 900 };
  const [partners, enemies] = await Promise.all([
    api.get<Lane[]>("/v1/analytics/lane-matchup-stats", { ...q, group_by: "hero_ids", min_matches: 100 }, 6 * 3600),
    api.get<Lane[]>("/v1/analytics/lane-matchup-stats", { ...q, group_by: "enemy_hero_ids", min_matches: 60 }, 6 * 3600),
  ]);
  const row = (l: Lane, ids: number[]) => ({ heroes: ids, matches: l.matches_played, win_rate: l.wins / Math.max(1, l.matches_played), souls_lead_15: Math.round(l.net_worth_diff) });
  const P = partners.filter((l) => l.hero_ids.includes(id) && l.hero_ids.length === 2).map((l) => row(l, l.hero_ids.filter((x) => x !== id)));
  const E = enemies.filter((l) => l.enemy_hero_ids.length === 2).map((l) => row(l, l.enemy_hero_ids));
  const byLead = (a: { souls_lead_15: number }, b: { souls_lead_15: number }) => b.souls_lead_15 - a.souls_lead_15;
  return c.json({ partners: [...P].sort(byLead).slice(0, 8), tough: [...E].sort((a, b) => a.souls_lead_15 - b.souls_lead_15).slice(0, 6), easy: [...E].sort(byLead).slice(0, 6) });
});

export default r;
