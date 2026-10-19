import { Hono } from "hono";
import type { Env } from "../types";
import { DeadlockApi, type ItemAsset } from "../deadlock";

const r = new Hono<{ Bindings: Env }>();

/**
 * BUILD WIZARD
 * The user sets priorities (0–5) for a handful of stats. Each shop item's properties are mapped
 * onto those stats, normalised, weighted, and combined with the item's hero-specific win rate.
 *
 * PROPERTY KEYS: the asset API exposes each item's modifiers under `properties`, keyed by Valve's
 * internal names. The map below is a best-effort starting point — hit GET /api/builds/property-keys
 * to see every key that actually exists for the current patch and adjust STAT_MAP accordingly.
 */
export const STAT_MAP: Record<string, { label: string; keys: string[] }> = {
  // keys = property names observed on live shop items (GET /api/builds/property-keys lists them with counts)
  weapon_damage: { label: "Weapon damage",         keys: ["BaseAttackDamagePercent", "BaseAttackDamagePercentBonus", "BonusDamagePercent", "WeaponPowerPerStack", "BaseAttackDamagePercentAtMaxDuration"] },
  spirit:        { label: "Spirit power",          keys: ["TechPower", "SpiritPower", "BonusSpirit", "TechPowerPercent", "ImbuedTechPower"] },
  ammo:          { label: "Ammo / clip size",      keys: ["BonusClipSizePercent", "BonusClipSize", "BonusClipPerKill"] },
  range:         { label: "Range / long-range dmg", keys: ["LongRangeBonusWeaponPower", "BonusAttackRangePercent", "BonusBulletSpeedPercent", "BonusZoomPercent"] },
  fire_rate:     { label: "Fire rate",             keys: ["BonusFireRate", "FireRateBonus", "ActiveBonusFireRate", "FireRatePerKill"] },
  health:        { label: "Health",                keys: ["BonusHealth", "BonusBaseHealth"] },
  spirit_resist: { label: "Spirit resist",         keys: ["TechResist"] },
  bullet_resist: { label: "Bullet resist",         keys: ["BulletResist"] },
  move_speed:    { label: "Move / sprint speed",   keys: ["BonusMoveSpeed", "BonusSprintSpeed", "ActiveBonusMoveSpeed"] },
  lifesteal:     { label: "Lifesteal",             keys: ["BulletLifestealPercent", "AbilityLifestealPercentHero", "BonusSpiritLifesteal", "ActiveBonusLifesteal"] },
  cooldown:      { label: "Cooldown reduction",    keys: ["CooldownReduction", "ItemCooldownReduction", "UltimateCooldownReduction"] },
  regen:         { label: "Health regen",          keys: ["BonusHealthRegen", "OutOfCombatHealthRegen"] },
};

const numericProp = (it: ItemAsset, key: string): number => it.properties[key] ?? 0;

r.get("/stat-options", (c) => c.json(Object.entries(STAT_MAP).map(([id, s]) => ({ id, label: s.label }))));

/** Debug helper: every property key present on shop items, with how many items carry it. */
r.get("/property-keys", async (c) => {
  const items = await new DeadlockApi(c.env).items();
  const counts: Record<string, number> = {};
  for (const it of items) for (const k of Object.keys(it.properties)) counts[k] = (counts[k] ?? 0) + 1;
  return c.json(Object.entries(counts).sort((a, b) => b[1] - a[1]));
});

/**
 * POST { hero_id, priorities: {weapon_damage:5, spirit:3, ...}, budget: 40000, winrate_weight: 0.5 }
 * → ranked items per slot + a suggested purchase order within budget.
 */
r.post("/wizard", async (c) => {
  const body = await c.req.json<{ hero_id: number; priorities: Record<string, number>; budget?: number; winrate_weight?: number }>();
  const api = new DeadlockApi(c.env);
  const [items, stats] = await Promise.all([api.items(), api.itemStats({ hero_id: body.hero_id }).catch(() => [])]);
  const wr = new Map(stats.map((s) => [s.item_id, { wr: s.matches ? s.wins / s.matches : 0.5, n: s.matches }] as const));
  const wrWeight = body.winrate_weight ?? 0.5;
  const budget = body.budget ?? 40000;

  const shop = items.filter((i) => i.cost && (!i.heroes?.length || i.heroes.includes(body.hero_id)));

  // Normalise each stat across the shop so a +40 clip and a +12% damage are comparable.
  const maxPerStat: Record<string, number> = {};
  const raw = shop.map((it) => {
    const s: Record<string, number> = {};
    for (const [stat, def] of Object.entries(STAT_MAP)) {
      s[stat] = def.keys.reduce((acc, k) => acc + numericProp(it, k), 0);
      maxPerStat[stat] = Math.max(maxPerStat[stat] ?? 0, s[stat]);
    }
    return { it, s };
  });

  const scored = raw.map(({ it, s }) => {
    let statScore = 0, weightSum = 0;
    for (const [stat, w] of Object.entries(body.priorities ?? {})) {
      if (!w || !maxPerStat[stat]) continue;
      statScore += w * (s[stat] / maxPerStat[stat]);
      weightSum += w;
    }
    statScore = weightSum ? statScore / weightSum : 0;            // 0..1
    const w = wr.get(it.id);
    const winScore = w ? (w.wr - 0.5) * 2 : 0;                   // -1..1, 0 if unknown
    const score = (1 - wrWeight) * statScore + wrWeight * winScore;
    return { item_id: it.id, name: it.name, slot: it.item_slot_type, tier: it.item_tier, cost: it.cost!, image: it.image,
      stat_score: +statScore.toFixed(3), win_rate: w?.wr ?? null, samples: w?.n ?? 0, score: +score.toFixed(3),
      contributes: Object.fromEntries(Object.entries(s).filter(([, v]) => v > 0)) };
  }).sort((a, b) => b.score - a.score);

  // Pick the best-scoring items first (4 slots per category, within budget, ignore filler below a score floor),
  // then present them in a sensible purchase order: cheap tiers early, expensive late.
  const slots: Record<string, number> = { weapon: 4, vitality: 4, spirit: 4 };
  const picked: typeof scored = [];
  let spent = 0;
  for (const item of scored) {
    if (!item.slot || !slots[item.slot] || item.score < 0.05) continue;
    if (spent + item.cost > budget) continue;
    picked.push(item); spent += item.cost; slots[item.slot]--;
  }
  const order = [...picked].sort((a, b) => (a.tier ?? 0) - (b.tier ?? 0) || a.cost - b.cost || b.score - a.score);
  return c.json({ hero_id: body.hero_id, budget, spent, order, ranked: scored.slice(0, 60) });
});

// ---- saved builds shared with the group ----
r.get("/", async (c) => {
  const hero = c.req.query("hero_id");
  const q = hero
    ? c.env.DB.prepare("SELECT * FROM builds WHERE hero_id=? ORDER BY votes DESC, created_at DESC").bind(Number(hero))
    : c.env.DB.prepare("SELECT * FROM builds ORDER BY created_at DESC LIMIT 100");
  const { results } = await q.all();
  return c.json(results.map((b) => ({ ...b, priorities: JSON.parse(b.priorities as string), items: JSON.parse(b.items as string) })));
});

r.post("/", async (c) => {
  const b = await c.req.json<{ hero_id: number; author: string; title: string; priorities: unknown; items: unknown; notes?: string }>();
  if (!b.hero_id || !b.author || !b.title) return c.json({ error: "hero_id, author, title required" }, 400);
  const res = await c.env.DB.prepare("INSERT INTO builds(hero_id, author, title, priorities, items, notes) VALUES (?,?,?,?,?,?)")
    .bind(b.hero_id, b.author, b.title, JSON.stringify(b.priorities ?? {}), JSON.stringify(b.items ?? []), b.notes ?? null).run();
  return c.json({ ok: true, id: res.meta.last_row_id });
});

r.post("/:id/vote", async (c) => {
  await c.env.DB.prepare("UPDATE builds SET votes=votes+1 WHERE id=?").bind(Number(c.req.param("id"))).run();
  return c.json({ ok: true });
});

export default r;
