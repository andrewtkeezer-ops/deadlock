// Buy path: turns any build (however its author grouped it) into one readable order:
// the Core you hold when your slots first fill, then every swap as "sell this (half back) → buy that".
// buildPath() is a pure function over the build + shop items; pathPanel() draws the result.
import { h, fmt, withTip } from "/js/app.js";

export const BASE_SLOTS = 9, MAX_SLOTS = 12, MAX_ACTIVES = 4; // 9 slots + 1 per enemy Walker (since the 2025-11-21 patch); 4 actives
export const WALKER_MIN = [15, 22, 30];                        // "Auto" assumes the three Walkers fall around these minutes
const OPTIONAL = /situat|option|luxur|counter|\bif\b|\bwhen\b|need|flex|defen[cs]|armou?r|\banti|\bvs\b|against|alternativ|utility|extra|\bfun\b|sometimes|\bor\b|\bpick|choose|replace|swap|instead|survival|maybe|greed|bonus/i;
const SELL_CAT = /sell\s*order|what to sell|^\W*sell\b/i;
const SELL = /\bsell|\bsold\b|\breplace|\bswap/i, NEG = /(don'?t|do not|never|not)\s+(ever\s+)?sell/i, KEEP = /\b(keep|hold)\b/i;
const SELF = /sell\s+(this|it)?\s*(later\s+)?(for|when|into|to (buy|get|fit))|replace with|swap (for|with|to)|can sell|sellable|sell\s*(later|1st|2nd|3rd|4th|first|second|third|if|when|as|only|\d)/i;
const LATE = /deep late|end ?game|super late|very late|\blast\b|only in/i;
const ORD = [[/\b(1st|first)\b/i, 1], [/\b(2nd|second)\b/i, 2], [/\b(3rd|third)\b/i, 3], [/\b(4th|fourth)\b/i, 4]];
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const clip = (s, n = 90) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

/** Finds the build's own items named in a free-text note: full names, "ammo scav", "extrahealth", initials like HSB, or one distinctive word. */
function matcher(pool) {
  const use = new Map();
  const rows = pool.map((it) => { const words = norm(it.name).split(" ").filter(Boolean); for (const w of new Set(words)) use.set(w, (use.get(w) || 0) + 1); return { it, words }; });
  return (text, skipId) => {
    const t = " " + norm(text) + " "; if (t.length < 5) return [];
    const flat = t.replace(/ /g, ""), flatPos = (i) => t.slice(0, i).replace(/ /g, "").length;
    const word = (w) => { const i = t.indexOf(" " + w + " "); return i < 0 ? -1 : flatPos(i); };
    const best = new Map(); // position → strongest match there
    for (const { it, words } of rows) {
      if (it.id === skipId || !words.length) continue;
      let pos = -1, q = 0;
      if (words.length === 1) { pos = word(words[0]); q = 3; }
      else { pos = flat.indexOf(words.join("")); q = 3;
        if (pos < 0) { pos = flat.indexOf(words[0] + words[1].slice(0, 4)); q = 2; }
        if (pos < 0 && words.length >= 3) { pos = word(words.map((w) => w[0]).join("")); q = 2; } }
      if (pos < 0) { const w = words.find((x) => x.length >= 6 && use.get(x) === 1); if (w) { const i = t.indexOf(" " + w); pos = i < 0 ? -1 : flatPos(i); q = 1; } }
      if (pos < 0) continue;
      const cur = best.get(pos); if (!cur || q > cur.q || (q === cur.q && words.length > cur.n)) best.set(pos, { it, pos, q, n: words.length });
    }
    return [...best.values()].sort((a, b) => a.pos - b.pos);
  };
}

/** What the author said about selling: per-item hints, "sell A for B" pairs, and items they said to keep. */
function readHints(cats, pool) {
  const find = matcher(pool), hint = new Map(), pairs = new Map(), keep = new Set();
  // only the clause that starts at "sell …" counts, so "sell X and Y for armor, Z on your 1" does not drag Z in
  const clause = (s) => { const i = s.search(/sell|sold|replace|swap/i); if (i < 0) return ""; const rest = s.slice(i), j = rest.slice(4).search(/[.;,!?\n(]/); return j < 0 ? rest : rest.slice(0, j + 4); };
  const set = (id, rank, quote, late) => { const cur = hint.get(id); if (!cur || (rank ?? 99) < (cur.rank ?? 99)) hint.set(id, { rank, quote, late }); };
  const pair = (buyId, sellId, quote) => { const a = pairs.get(buyId) || []; a.push({ id: sellId, quote }); pairs.set(buyId, a); };
  for (const cat of cats) {
    if (cat.role === "sell") cat.mods.forEach((m, i) => set(m.ability_id, i + 1, `listed #${i + 1} in “${cat.label}”`));
    const d = cat.description || "";
    if (SELL.test(d) && !NEG.test(d)) find(clause(d)).forEach((x, i) => set(x.it.id, i + 1, clip(d)));
    for (const m of cat.mods) {
      const a = m.annotation, id = m.ability_id; if (!a) continue;
      if (NEG.test(a) || (KEEP.test(a) && !SELL.test(a))) { keep.add(id); continue; }
      if (!SELL.test(a)) continue;
      const named = find(clause(a), id);
      if (named.length && !SELF.test(a)) { for (const x of named) pair(id, x.it.id, clip(a)); continue; } // "sell Headshot Booster to fit"
      const ord = ORD.find(([re]) => re.test(a));
      set(id, ord ? ord[1] : null, clip(a), !ord && LATE.test(a));
      for (const x of named) pair(x.it.id, id, clip(a));                                                 // "sell this for Ricochet"
    }
  }
  return { hint, pairs, keep };
}

const catLabel = (name, i) => { const n = String(name || "").trim().replace(/^#?Citadel_HeroBuilds_/i, "").replace(/([a-z])([A-Z])/g, "$1 $2"); return n && !/^category\s*\d*\w{0,3}$/i.test(n) ? n : `Group ${i + 1}`; };

/**
 * @param build  { hero_id, details: { mod_categories: [{ name, description?, mods: [{ ability_id, annotation? }] }] } }
 * @param items  shop items from /api/library/items
 * @param opts   { spm: souls per minute, slots: "auto" | 9..12 }
 */
export function buildPath(build, items, { spm = 1150, slots = "auto" } = {}) {
  const byId = new Map(items.map((i) => [i.id, i])), byClass = new Map(items.map((i) => [i.class_name, i]));
  const cats = (build.details?.mod_categories ?? []).map((c, i) => ({ ...c, label: catLabel(c.name, i), mods: (c.mods || []).filter((m) => byId.has(m.ability_id)) })).filter((c) => c.mods.length);
  for (const c of cats) c.role = SELL_CAT.test(c.label) ? "sell" : OPTIONAL.test(c.label) && !/\bcore\b/i.test(c.label) ? "optional" : "main";
  const uniq = (role) => new Set(cats.filter((c) => c.role === role).flatMap((c) => c.mods.map((m) => m.ability_id))).size;
  if (uniq("main") < 6) for (const c of cats) if (c.role === "optional") c.role = "main"; // "if you're ahead / if you're behind" style builds: follow everything
  const pool = [...new Set(cats.flatMap((c) => c.mods.map((m) => m.ability_id)))].map((id) => byId.get(id));
  const { hint, pairs, keep } = readHints(cats, pool);

  const memo = new Map();
  const compsOf = (it) => { if (memo.has(it.id)) return memo.get(it.id); const s = new Set(); memo.set(it.id, s); for (const cn of it.components || []) { const c = byClass.get(cn); if (c) { s.add(c.id); for (const x of compsOf(c)) s.add(x); } } return s; };
  const seq = (role) => { const seen = new Set(), out = []; for (const c of cats) if (c.role === role) for (const m of c.mods) if (!seen.has(m.ability_id)) { seen.add(m.ability_id); out.push({ it: byId.get(m.ability_id), cat: c.label, note: m.annotation || null }); } return out; };
  const main = seq("main");
  const futureUse = new Map(); main.forEach((e, i) => { for (const c of compsOf(e.it)) futureUse.set(c, i); });
  const promised = new Map(); main.forEach((e, i) => { for (const p of pairs.get(e.it.id) || []) promised.set(p.id, i); });

  const slotsAt = (paid) => (slots === "auto" ? BASE_SLOTS + WALKER_MIN.filter((m) => paid >= m * spm).length : Math.max(1, Math.min(MAX_SLOTS, +slots || MAX_SLOTS)));
  const held = [], steps = [], leftovers = [], sold = new Map(); let paid = 0, core = null;
  const snap = () => ({ items: held.map((x) => x.it), paid, steps: steps.length });

  const pick = (it, idx, activeOnly, long) => {
    const from = held.filter((x) => !activeOnly || x.it.active);
    for (const p of pairs.get(it.id) || []) { const v = from.find((x) => x.it.id === p.id); if (v) return { v, why: `Author: “${p.quote}”`, said: true }; }
    const can = from.filter((x) => !keep.has(x.it.id) && !((futureUse.get(x.it.id) ?? -1) > idx) && (x.it.tier < it.tier || (hint.has(x.it.id) && x.it.tier <= it.tier)) && (!long || x.it.tier <= 2));
    const free = can.filter((x) => !((promised.get(x.it.id) ?? -1) > idx)), ok = free.length ? free : can; // keep "sell this for B" items until B comes up
    if (!ok.length) return null;
    const score = (x) => { const hn = hint.get(x.it.id), base = x.it.tier * 10; return (hn ? (hn.rank != null ? hn.rank - 100 : hn.late ? base + 5 : base - 15) : base) - (x.it.slot === it.slot ? 0.5 : 0) + x.at / 1000; };
    const v = ok.sort((a, b) => score(a) - score(b))[0], hn = hint.get(v.it.id);
    return { v, said: !!hn, why: hn ? `Author: “${hn.quote}”` : activeOnly ? `Only ${MAX_ACTIVES} active items fit; this is the cheapest one you hold` : `Lowest tier you hold (T${v.it.tier})${v.it.slot === it.slot ? `, and swapping ${it.slot} for ${it.slot} keeps that bonus growing` : ""}` };
  };

  const place = (e, idx, long) => {
    const it = e.it, cost = it.cost || 0;
    if (held.some((x) => x.it.id === it.id || compsOf(x.it).has(it.id)) || sold.has(it.id)) return true;
    const base = { buy: it, cat: e.cat, note: e.note, long: !!long };
    const absorbed = held.filter((x) => compsOf(it).has(x.it.id));
    if (absorbed.length) {
      const pay = Math.max(0, cost - absorbed.reduce((s, x) => s + (x.it.cost || 0), 0)); paid += pay;
      for (const x of absorbed) held.splice(held.indexOf(x), 1);
      held.push({ it, at: steps.length }); steps.push({ ...base, type: "upgrade", from: absorbed.map((x) => x.it), pay, paid }); return true;
    }
    if (core && it.tier <= 2 && !long && !(pairs.get(it.id) || []).length) { leftovers.push(e); return false; } // a lane-tier item listed after the swapping has started
    const cap = slotsAt(paid + cost), tooManyActives = !!it.active && held.filter((x) => x.it.active).length >= MAX_ACTIVES;
    if (held.length < cap && !tooManyActives) {
      paid += cost; const extra = held.length >= BASE_SLOTS ? held.length - BASE_SLOTS + 1 : 0;
      held.push({ it, at: steps.length }); steps.push({ ...base, type: "buy", pay: cost, paid, extra }); return true;
    }
    if (!core) core = snap();
    const p = pick(it, idx, tooManyActives, long);
    if (!p) { if (!long) leftovers.push(e); return false; }
    const refund = Math.floor((p.v.it.cost || 0) / 2), pay = cost - refund; paid += pay;
    held.splice(held.indexOf(p.v), 1); held.push({ it, at: steps.length });
    const step = { ...base, type: "swap", sell: p.v.it, refund, pay, paid, why: p.why, said: p.said }; steps.push(step); sold.set(p.v.it.id, step); return true;
  };

  main.forEach((e, i) => place(e, i, false));
  const mainSteps = steps.length, mainPaid = paid;
  // A long game: lane items still in the bag get traded for the author's optional T3/T4 picks, in their order.
  let extra = 0; for (const e of seq("optional")) { if (extra >= 6) break; if (e.it.tier < 3 || main.some((m) => m.it.id === e.it.id)) continue; const n = steps.length; place(e, Infinity, true); if (steps.length > n) extra++; }

  const order = { weapon: 0, vitality: 1, spirit: 2 };
  return {
    slots, spm, steps, mainSteps, mainPaid, paid, core, sold, leftovers,
    final: held.map((x) => x.it).sort((a, b) => (order[a.slot] ?? 3) - (order[b.slot] ?? 3) || b.tier - a.tier || a.name.localeCompare(b.name)),
    options: cats.filter((c) => c.role === "optional").map((c) => ({ label: c.label, description: c.description || "", items: c.mods.map((m) => byId.get(m.ability_id)) })),
    saidCount: steps.filter((s) => s.said).length, empty: !main.length,
  };
}

// ---------------------------------------------------------------- drawing
const img = (it, size = 34) => withTip(h("img", { class: "iimg " + (it.slot || ""), src: it.image || "", alt: "", width: size, height: size }), it);
const tier = (it) => h("span", { class: "pth-t " + (it.slot || "") }, `T${it.tier}`);
const mins = (paid, spm) => { const m = Math.round(paid / spm); return m < 1 ? "start" : `~${m} min`; };
const piece = (kind, it, money) => h("div", { class: "pth-pc " + kind }, h("span", { class: "pth-k" }, kind === "sell" ? "Sell" : kind === "from" ? "Have" : "Buy"), img(it, 28), h("b", {}, it.name), tier(it), money ? h("small", {}, money) : "");

// One line per step. The plain-language reason sits in the hover title; only the author's own words get a visible line.
function stepRow(s, n, spm) {
  const why = s.type === "swap" ? s.why : s.type === "upgrade" ? `Upgrade: ${s.from.map((x) => x.name).join(" + ")} ${s.from.length > 1 ? "are" : "is"} used up, so no slot is needed and you only pay the difference.` : s.extra ? `Goes in extra slot ${s.extra}, which opens when your team destroys enemy Walker ${s.extra}. No free slot yet? Hold the souls or skip to the next swap.` : "Free slot, nothing to sell.";
  const right = h("div", { class: "pth-r", title: why }, h("b", {}, s.type === "buy" ? fmt(s.pay) : `${fmt(s.pay)} net`), h("small", {}, mins(s.paid, spm)));
  const arrow = (ch, label) => h("span", { class: "pth-a", "aria-label": label, title: why }, ch);
  const body = s.type === "swap" ? [piece("sell", s.sell, `+${fmt(s.refund)}`), arrow("→", "then"), piece("buy", s.buy)]
    : s.type === "upgrade" ? [...s.from.map((x) => piece("from", x)), arrow("⇧", "upgrades into"), piece("buy", s.buy)]
    : [piece("buy", s.buy), s.extra ? h("span", { class: "pth-tag", title: why }, `extra slot ${s.extra}`) : ""];
  return h("div", { class: "pth-row " + s.type + (s.said ? " said" : ""), "data-sell": s.sell ? String(s.sell.id) : null }, h("span", { class: "pth-i" }, String(n)), h("div", { class: "pth-m" }, h("div", { class: "pth-x" }, ...body), s.said ? h("p", { class: "pth-w" }, s.why) : ""), right);
}

/** @param opts { onSlots(value) → redraw with another slot setting } */
export function pathPanel(plan, { onSlots } = {}) {
  if (plan.empty) return h("p", { class: "muted" }, "Add items and this will show what to buy, in order, and what to sell for what.");
  const { spm } = plan, upto = plan.core ? plan.core.steps : plan.mainSteps;
  const first = plan.steps.slice(0, upto), later = plan.steps.slice(upto, plan.mainSteps), long = plan.steps.slice(plan.mainSteps);
  const corePaid = plan.core ? plan.core.paid : plan.mainPaid, coreItems = plan.core ? plan.core.items : plan.final;
  const seg = h("div", { class: "pth-seg", role: "group", "aria-label": "Item slots" }, h("span", {}, "Slots"), ...[["auto", "Auto"], [9, "9"], [12, "12"]].map(([v, l]) => h("button", { type: "button", class: String(plan.slots) === String(v) ? "on" : "", "aria-pressed": String(String(plan.slots) === String(v)), onclick: () => onSlots?.(v) }, l)));
  const hintLine = plan.slots === "auto" ? `Auto: 9 slots, plus one each around ${WALKER_MIN.join(", ")} min as enemy Walkers fall.` : plan.slots === 9 ? "No Walkers down: 9 slots all game." : "All three Walkers down: 12 slots from the start.";
  const strip = (list) => h("ol", { class: "pth-strip" }, ...list.map((s, i) => h("li", { class: s.type }, h("span", { class: "pth-i" }, String(i + 1)), img(s.buy, 30), h("b", {}, s.buy.name), h("small", {}, s.type === "upgrade" ? `⇧ ${s.from.map((x) => x.name).join(" + ")} · ${fmt(s.pay)}` : fmt(s.pay)))));
  const icons = (list, size = 30) => h("div", { class: "pth-icons" }, ...list.map((it) => img(it, size)));
  let n = upto, lastCat = null; const rows = [];
  for (const s of later) { if (s.cat !== lastCat) { rows.push(h("div", { class: "pth-cat" }, s.cat)); lastCat = s.cat; } rows.push(stepRow(s, ++n, spm)); }
  const big = plan.leftovers.filter((e) => e.it.tier >= 3).map((e) => e.it), small = plan.leftovers.filter((e) => e.it.tier < 3).map((e) => e.it);
  const swaps = later.filter((s) => s.type === "swap").length;
  return h("div", { class: "pth" },
    h("div", { class: "pth-bar" }, seg, h("span", { class: "muted" }, hintLine, " Selling returns half. Hover a price for the reason.")),
    h("section", { class: "pth-sec" },
      h("h4", {}, "Core build ", h("span", {}, `${first.length === coreItems.length ? "" : `${first.length} buys · `}${coreItems.length} slots filled · ${fmt(corePaid)} souls · ${mins(corePaid, spm)}`)),
      h("p", { class: "pth-lead" }, plan.core ? "Buy in order. After these your slots are full, so each new item replaces one." : "Buy in order. Everything fits, so there is nothing to sell."),
      strip(first)),
    later.length ? h("section", { class: "pth-sec" },
      h("h4", {}, "Then scale ", h("span", {}, swaps ? `${swaps} swap${swaps === 1 ? "" : "s"}${plan.saidCount ? ` · ${plan.saidCount} from the author’s own notes` : ""}` : "no selling needed")),
      h("div", { class: "pth-rows" }, ...rows)) : "",
    h("section", { class: "pth-sec" },
      h("h4", {}, "Finished build ", h("span", {}, `${plan.final.length} items · ${fmt(plan.mainPaid)} souls · ${mins(plan.mainPaid, spm)}`)),
      icons(plan.final, 36)),
    big.length ? h("section", { class: "pth-sec" },
      h("h4", {}, "Listed, but no room ", h("span", {}, "nothing cheaper left to sell for these")),
      h("p", { class: "pth-lead" }, "The author lists these too. By this point every slot holds something at least as strong, so take one only in place of an item you like less."),
      icons(big)) : "",
    small.length ? h("section", { class: "pth-sec" },
      h("h4", {}, "Cheap extras ", h("span", {}, "listed after your slots were already full")),
      h("p", { class: "pth-lead" }, "Lane-tier items the author mentions late. Worth it only early, while you still have an empty slot."),
      icons(small)) : "",
    long.length ? h("section", { class: "pth-sec" },
      h("h4", {}, "If the game goes long ", h("span", {}, "lane items still in your bag, traded for the author’s optional picks")),
      h("div", { class: "pth-rows" }, ...long.map((s) => stepRow(s, ++n, spm)))) : "",
    plan.options.length ? h("details", { class: "pth-opt" }, h("summary", {}, `Optional groups (${plan.options.length})`, h("span", { class: "muted" }, " not part of the path; pick what the game calls for")),
      ...plan.options.map((o) => h("div", { class: "pth-o" }, h("b", {}, o.label), o.description ? h("small", {}, clip(o.description, 160)) : "", icons(o.items, 28)))) : "");
}
