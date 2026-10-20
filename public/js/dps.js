// Raw gun DPS from the hero's weapon numbers + the items in a build. Pure math, no network.
import { h, fmt, api } from "/js/app.js";

const M = 39.37; // Source units per metre (the in-game tooltips show falloff in metres)
// Item property keys that feed the gun. Values are percentages unless noted.
const K = {
  dmgPct: ["BaseAttackDamagePercent", "BaseAttackDamagePercentBonus", "BonusDamagePercent"],
  weaponPower: ["WeaponPower", "WeaponPowerPerStack"],
  fireRate: ["BonusFireRate", "FireRateBonus"],
  clipPct: ["BonusClipSizePercent"], clipFlat: ["BonusClipSize"],
  reload: ["BonusReloadSpeed", "ReloadSpeed"],
  spirit: ["TechPower", "SpiritPower", "BonusSpirit"],
  range: ["BonusAttackRangePercent"], longRange: ["LongRangeBonusWeaponPower"],
  bulletLifesteal: ["BulletLifestealPercent"], health: ["BonusHealth", "BonusBaseHealth"], bulletResist: ["BulletResist"], spiritResist: ["TechResist"],
};
const sum = (items, keys) => items.reduce((s, it) => s + keys.reduce((a, k) => a + (it?.properties?.[k] || 0), 0), 0);

export function computeDps(w, items, { level = 1, rangeM = 10, headshots = 0 } = {}) {
  const ups = w.upgrade_levels.filter((l) => l <= level).length;
  const dmgPct = sum(items, K.dmgPct) + sum(items, K.weaponPower), fireRate = sum(items, K.fireRate), clipPct = sum(items, K.clipPct), clipFlat = sum(items, K.clipFlat), reloadPct = sum(items, K.reload);
  const spirit = sum(items, K.spirit), longRange = sum(items, K.longRange), rangePct = sum(items, K.range);
  const perBullet = (w.bullet_damage + ups * w.bullet_damage_per_upgrade) * (1 + dmgPct / 100);
  const cycle = (w.cycle_time + Math.max(0, w.burst - 1) * w.intra_burst) / (1 + fireRate / 100);
  const shotsPerSec = w.burst / Math.max(0.01, cycle);
  const clip = Math.round(w.clip_size * (1 + clipPct / 100) + clipFlat);
  const reload = w.reload_duration / (1 + reloadPct / 100);
  // falloff: full damage to start, linear down to end_scale at end
  const r = rangeM * M, f = w.falloff; const fall = r <= f.start ? 1 : r >= f.end ? f.end_scale : 1 - (r - f.start) / Math.max(1, f.end - f.start) * (1 - f.end_scale);
  const lr = r > f.start ? 1 + longRange / 100 : 1; // long-range items only kick in past the falloff start
  const hs = 1 + headshots * (w.crit - 1); // headshots: share of bullets that crit
  const bulletDmg = perBullet * fall * lr * hs, shotDmg = bulletDmg * w.bullets;
  const burst = shotDmg * shotsPerSec; // mag dump, no reload
  const clipTime = clip / shotsPerSec; const sustained = (shotDmg * clip) / (clipTime + reload);
  return { perBullet, bulletDmg, shotDmg, shotsPerSec, clip, reload, clipTime, burst, sustained, fall, ups, spirit, dmgPct, fireRate, clipPct, clipFlat, reloadPct, rangePct, longRange, magDamage: shotDmg * clip, timeToKill: (hp) => hp / Math.max(1, sustained),
    range: w.range * (1 + rangePct / 100) / M, falloffStartM: f.start / M, falloffEndM: f.end / M, health: w.max_health + ups * w.health_per_upgrade + sum(items, K.health), bulletResist: sum(items, K.bulletResist), spiritResist: sum(items, K.spiritResist), lifesteal: sum(items, K.bulletLifesteal) };
}

/** Live panel: hero gun card + sliders (level, range, headshot %) + DPS readouts; call .update(items) when the build changes. */
export function dpsPanel(heroId, { compact = false } = {}) {
  const el = h("div", { class: "dps" }); let w = null, items = [], st = { level: 12, rangeM: 10, headshots: 0 }; let base = null;
  const slider = (key, label, min, max, step, f) => { const v = h("span", { class: "v" }); const i = h("input", { type: "range", min, max, step, value: st[key], oninput: (e) => { st[key] = +e.target.value; paint(); } }); return { row: h("label", { class: "sl" }, h("span", {}, label), i, v), v, f, input: i }; };
  const sl = { level: slider("level", "Level", 1, 32, 1, (x) => `${x}`), rangeM: slider("rangeM", "Target range", 1, 60, 1, (x) => `${x} m`), headshots: slider("headshots", "Headshots", 0, 1, 0.05, (x) => `${Math.round(x * 100)}%`) };
  const stat = (label, big, sub) => h("div", { class: "st" }, h("b", {}, big), h("span", {}, label), sub ? h("small", {}, sub) : "");
  const out = h("div", { class: "out" }); const head = h("div", { class: "gun" });
  el.append(head, h("div", { class: "sls" }, sl.level.row, sl.rangeM.row, sl.headshots.row), out);
  function paint() {
    if (!w) return;
    for (const k in sl) sl[k].v.textContent = sl[k].f(st[k]); sl.level.input.max = w.max_level || 32;
    const d = computeDps(w, items, st), b = computeDps(w, [], st); const delta = (x, y, unit = "") => { const p = y ? (x - y) / y * 100 : 0; return Math.abs(p) < 0.5 ? "" : `${p > 0 ? "+" : ""}${p.toFixed(0)}% vs no items`; };
    out.replaceChildren(
      stat("sustained DPS", fmt(d.sustained), delta(d.sustained, b.sustained) || "with reloads"),
      stat("burst DPS", fmt(d.burst), delta(d.burst, b.burst) || "mag dump"),
      stat("per bullet", d.bulletDmg.toFixed(1), `${d.fall < 1 ? `${Math.round(d.fall * 100)}% at ${st.rangeM} m` : "full damage"}`),
      stat("clip", `${d.clip}`, `${fmt(d.magDamage)} dmg · ${d.clipTime.toFixed(1)}s`),
      stat("fire rate", `${d.shotsPerSec.toFixed(1)}/s`, d.fireRate ? `+${d.fireRate}%` : ""),
      stat("reload", `${d.reload.toFixed(2)}s`, d.reloadPct ? `+${d.reloadPct}% speed` : ""),
      stat("spirit power", `+${Math.round(d.spirit)}`, ""),
      stat("health", fmt(d.health), [d.bulletResist ? `${d.bulletResist}% bullet` : "", d.spiritResist ? `${d.spiritResist}% spirit` : ""].filter(Boolean).join(" · ") || "resist"),
      stat("time to kill", `${d.timeToKill(d.health).toFixed(1)}s`, "a mirror with this HP"));
    head.replaceChildren(w.image ? h("img", { src: w.image, alt: "" }) : "", h("div", {}, h("b", {}, w.name || "Primary weapon"), h("span", { class: "muted" }, ` ${w.bullet_damage}${w.bullets > 1 ? `×${w.bullets}` : ""} dmg · ${w.clip_size} clip · ${(w.burst / (w.cycle_time + (w.burst - 1) * w.intra_burst)).toFixed(1)}/s · falloff ${Math.round(d.falloffStartM)}–${Math.round(d.falloffEndM)} m${w.crit > 1 ? ` · headshot ×${w.crit}` : ""}`)));
  }
  el.update = (its) => { items = (its || []).filter(Boolean); paint(); };
  el.setHero = async (id) => { w = null; out.replaceChildren(h("span", { class: "muted" }, "Loading gun…")); try { w = await api(`/heroes/${id}/weapon`); if (!w) throw 0; paint(); } catch { out.replaceChildren(h("span", { class: "muted" }, "No weapon data for this hero yet.")); } };
  el.setHero(heroId); return el;
}
