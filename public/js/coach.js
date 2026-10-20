// Build coach: plain-language tips about a build's pacing, slots, order and upgrades. Pure function over the
// build + shop data; the editor renders the result. Numbers come from the player's own farm rate when known.
import { h, fmt } from "/js/app.js";

const SLOTS_PER_CATEGORY = 4; // weapon / vitality / spirit base slots; more come from flex slots earned by objectives
const TYPICAL_GAME_MIN = 34;   // most games are decided by ~30–38 min

export function analyse(build, items, { spm = 1150, games = 0, heroName = "this hero" } = {}) {
  const byId = new Map(items.map((i) => [i.id, i])), byClass = new Map(items.map((i) => [i.class_name, i]));
  const cats = build.details?.mod_categories ?? [];
  const tips = [];
  const tip = (level, title, body, phase) => tips.push({ level, title, body, phase });
  // ---- walk the build in order, tracking souls, slots and what's held
  let running = 0, held = []; const phases = [];
  cats.forEach((cat, ci) => {
    const mods = cat.mods.map((m) => byId.get(m.ability_id)).filter(Boolean);
    const cost = mods.reduce((s, it) => s + (it.cost || 0), 0);
    const start = running; running += cost;
    for (const it of mods) {
      // an upgrade replaces its components: free the slot, pay the difference
      const comps = (it.components || []).map((c) => byClass.get(c)).filter(Boolean);
      for (const c of comps) { const k = held.findIndex((x) => x.id === c.id); if (k >= 0) { held.splice(k, 1); running -= c.cost || 0; } }
      held.push(it);
    }
    const perSlot = { weapon: 0, vitality: 0, spirit: 0 }; for (const it of held) perSlot[it.slot] = (perSlot[it.slot] || 0) + 1;
    const over = Object.entries(perSlot).filter(([, n]) => n > SLOTS_PER_CATEGORY).map(([k, n]) => `${n} ${k}`);
    phases.push({ name: cat.name, cost, start, end: running, minute: running / spm, mods, over, actives: held.filter((x) => x.active).length });
    if (over.length) tip("warn", `${cat.name}: more items than slots`, `By the end of this phase you're holding ${over.join(" and ")} — only ${SLOTS_PER_CATEGORY} per category fit until you earn flex slots from objectives. Plan what to sell (lane items first) or move something later.`, ci);
    for (const it of mods) {
      if (it.tier >= 4 && start < 12000) tip("tip", `${it.name} comes early`, `A 6,400-soul item before ~${Math.round(12000 / spm)} min means skipping the cheap stats that win lane. Most builds hold T4s until the mid game unless it's the hero's core item.`, ci);
      const comps = (it.components || []).map((c) => byClass.get(c)).filter(Boolean);
      const missing = comps.filter((c) => !cats.slice(0, ci + 1).some((cc) => cc.mods.some((m) => m.ability_id === c.id)));
      if (missing.length) tip("tip", `${it.name} upgrades from ${missing.map((c) => c.name).join(" + ")}`, `Buy ${missing.map((c) => c.name).join(" and ")} first (${missing.map((c) => fmt(c.cost)).join(" + ")} souls): you get the stats early and only pay the difference (${fmt(it.cost - missing.reduce((s, c) => s + c.cost, 0))}) to upgrade later.`, ci);
      const have = comps.filter((c) => !missing.includes(c));
      if (have.length) tip("good", `${it.name} absorbs ${have.map((c) => c.name).join(" + ")}`, `Nice sequencing: it replaces ${have.map((c) => c.name).join(" and ")}, frees the slot, and you only pay the difference.`, ci);
      if (it.activation && /imbue/i.test(String(it.activation))) tip("tip", `${it.name} needs an imbue target`, `Put it on the ability you cast most on ${heroName}; the item's bonuses only apply to that one ability.`, ci);
    }
  });
  // ---- lane & pacing
  const lane = phases[0];
  if (lane && lane.cost > 4000) tip("tip", `Lane phase is ${fmt(lane.cost)} souls`, `That's about ${Math.round(lane.cost / spm)} min of farm. Grab the first two items on your first base trip and the rest after; nobody holds 4,000 souls in lane.`, 0);
  const firstVit = phases.findIndex((p) => p.mods.some((it) => it.slot === "vitality"));
  if (firstVit > 1 || (firstVit < 0 && phases.length)) tip("warn", "Nothing for survival early", `No vitality item until ${firstVit < 0 ? "never" : "phase " + (firstVit + 1)}. One 800-soul Extra Health or Healing Rite in lane is the cheapest way to not feed the first skirmish.`, Math.max(0, firstVit));
  const total = running;
  const endMin = total / spm;
  const reach = phases.findIndex((p) => p.minute > TYPICAL_GAME_MIN);
  if (reach > 0 && reach < phases.length) tip("tip", `Realistically you'll reach phase ${reach}`, `The full build costs ${fmt(total)} souls, which at ${fmt(spm)}/min is a ${Math.round(endMin)}-minute game. Most games are decided around ${TYPICAL_GAME_MIN} min, so treat "${phases[reach].name}" onward as the plan for a long game, and make sure the phases before it stand on their own.`, reach);
  const actives = Math.max(0, ...phases.map((p) => p.actives));
  if (actives >= 5) tip("tip", `${actives} active items`, "That's a lot of buttons in a fight. Two to four actives is what most people can actually use; passives give the same stats with no clicks.");
  // ---- lean
  const spend = { weapon: 0, vitality: 0, spirit: 0 }; for (const p of phases) for (const it of p.mods) spend[it.slot] = (spend[it.slot] || 0) + (it.cost || 0);
  const tot = Object.values(spend).reduce((a, b) => a + b, 0) || 1; const lean = Object.entries(spend).sort((a, b) => b[1] - a[1])[0];
  if (lean && lean[1] / tot >= 0.5) tip("good", `${lean[0] === "weapon" ? "A gun build" : lean[0] === "spirit" ? "A spirit build" : "A tanky build"} (${Math.round(lean[1] / tot * 100)}% ${lean[0]})`, lean[0] === "weapon" ? "Your damage comes from landing shots: farm camps between waves, buy the fire-rate/ammo items before the flashy ones, and respect anyone with bullet resist." : lean[0] === "spirit" ? "Abilities are your damage: cooldown and spirit power items first, and the imbues go on your highest-damage ability." : "You're built to be hard to kill: your job is to start fights and soak; let the carries farm.");
  if (!games) tip("tip", "Timings use the squad's average farm rate", `No tracked games for you yet, so the minute marks assume ${fmt(spm)} souls/min. Play a few games with the uploader running and they'll use your real pace.`);
  return { tips, phases, total, endMin, spm, spend };
}

export function coachPanel(result) {
  const icon = { warn: "⚠", tip: "✦", good: "✓" };
  const order = { warn: 0, tip: 1, good: 2 };
  const tips = [...result.tips].sort((a, b) => order[a.level] - order[b.level]);
  const bar = h("div", { class: "tl" }, ...result.phases.map((p) => h("div", { class: "seg", style: `flex:${Math.max(1, p.cost)}`, title: `${p.name}: ${fmt(p.cost)} souls · about ${Math.round(p.minute)} min` }, h("b", {}, p.name), h("span", {}, `~${Math.round(p.minute)} min`))));
  return h("div", { class: "coach" }, h("div", { class: "sum" }, h("b", {}, fmt(result.total)), " souls total · ", h("b", {}, `${Math.round(result.endMin)} min`), ` to complete at ${fmt(result.spm)} souls/min`), bar,
    tips.length ? h("div", { class: "tips" }, ...tips.map((t) => h("div", { class: "t " + t.level }, h("span", { class: "i" }, icon[t.level]), h("div", {}, h("b", {}, t.title), h("p", {}, t.body))))) : h("p", { class: "muted" }, "Add items to phases and the coach will comment on pacing, slots and upgrade order."));
}

/**
 * Sell plan: early items (T1/T2 bought in the first phases) that aren't upgraded later and could be swapped for a
 * stronger late item of the same flavour. Returns Map<ability_id, { sellAtMin, reason, replacements: [{item, why, gain}] }>.
 */
export function sellPlan(build, items, { spm = 1150 } = {}) {
  const byId = new Map(items.map((i) => [i.id, i])), byClass = new Map(items.map((i) => [i.class_name, i]));
  const cats = build.details?.mod_categories ?? [];
  const inBuild = new Set(cats.flatMap((c) => c.mods.map((m) => m.ability_id)));
  const upgradedLater = new Set(); for (const c of cats) for (const m of c.mods) for (const comp of byId.get(m.ability_id)?.components || []) { const ci = byClass.get(comp); if (ci) upgradedLater.add(ci.id); }
  let running = 0; const out = new Map();
  cats.forEach((cat, ci) => {
    for (const m of cat.mods) {
      const it = byId.get(m.ability_id); if (!it) continue;
      const boughtAt = running; running += it.cost || 0;
      if (it.tier > 2 || boughtAt > 10000 || upgradedLater.has(it.id)) continue;
      const leans = Object.entries(it.leans || {}).sort((a, b) => b[1] - a[1]); if (!leans.length) continue;
      const top = leans.slice(0, 2).map(([k]) => k);
      // direct upgrades first (pay the difference), then same-slot T3/T4 items that lean the same way
      const direct = items.filter((x) => (x.components || []).includes(it.class_name) && !inBuild.has(x.id)).map((x) => ({ item: x, score: 10 + x.tier, why: `upgrades from ${it.name} — pay the difference (${fmt(x.cost - it.cost)})` }));
      const similar = items.filter((x) => x.slot === it.slot && x.tier >= 3 && !inBuild.has(x.id) && x.id !== it.id && (!x.heroes?.length || x.heroes.includes(build.hero_id)))
        .map((x) => { const sim = top.reduce((s, k) => s + (x.leans?.[k] || 0), 0); return { item: x, score: sim * x.tier, why: `${top.map((k) => k.replace(/_/g, " ")).join(" + ")} like ${it.name}, but T${x.tier}` }; })
        .filter((r) => r.score > 0.3);
      const picks = [...direct, ...similar].sort((a, b) => b.score - a.score).filter((r, i, a) => a.findIndex((q) => q.item.id === r.item.id) === i).slice(0, 3);
      if (!picks.length) continue;
      const gain = (x) => (x.stats || []).slice(0, 3).map((st) => `${st.value} ${st.label}`).join(" · ");
      out.set(it.id, { sellAtMin: Math.round(Math.max(18, 20000 / spm)), phase: ci, reason: `${it.name} is a T${it.tier} lane item; once slots fill (~${Math.round(Math.max(18, 20000 / spm))} min) it's the first thing to sell.`, replacements: picks.map((r) => ({ item: r.item, why: r.why, gain: gain(r.item) })) });
    }
  });
  return out;
}

/** Tooltip body for a sell suggestion. `onAdd(item)` adds the replacement to the build. */
export function sellTip(plan, onAdd) {
  return h("div", { class: "itip selltip" }, h("div", { class: "t" }, "↻ Sell this later"), h("p", { class: "desc" }, plan.reason), h("div", { class: "reps" }, ...plan.replacements.map((r) => h("div", { class: "rep", onclick: () => onAdd?.(r.item) }, r.item.image ? h("img", { src: r.item.image, alt: "" }) : "", h("div", {}, h("b", {}, r.item.name, " ", h("span", { class: "muted" }, `T${r.item.tier} · ${fmt(r.item.cost)}`)), h("small", {}, r.why), r.gain ? h("small", { class: "gain" }, r.gain) : "")))), onAdd ? h("p", { class: "muted hint" }, "Click a replacement to add it to the last phase.") : "");
}
