// Hero page extras: skill order, build path by game phase, laning. Data: deadlock-api analytics via our Worker.
import { api, h, pct, heroIcon, itemImg, abilityTooltip, withTipBuilder, segmented, showError } from "/js/app.js";

const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const signed = (n) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(Math.round(n)).toLocaleString()}`;

/* ---------------- skill order ---------------- */
export async function mountSkillOrder(el, id) {
  try {
    const d = await api(`/heroes/${id}/skill-order`);
    if (!d.orders.length) return el.replaceChildren(h("p", { class: "muted" }, "Not enough recent games to read a skill order."));
    const ab = new Map(d.abilities.map((a) => [a.id, a]));
    const icon = (aid, size = 34) => { const a = ab.get(aid); const im = a?.image ? h("img", { src: a.image, alt: a.name, width: size, height: size }) : h("span", { class: "ab0" }, "?"); return a ? withTipBuilder(im, () => abilityTooltip(a)) : im; };
    const legend = h("div", { class: "so-legend" }, ...d.abilities.map((a) => h("span", { class: `so-key s${a.slot}` }, icon(a.id, 26), h("b", {}, a.key === "ultimate" ? "Ult" : a.key), a.name)));
    const rows = d.orders.map((o, i) => {
      // number each ability's points (1st, 2nd, 3rd point in it…) so "unlock" vs "upgrade" reads at a glance
      const seen = new Map(); const cells = o.abilities.map((aid, k) => { const n = (seen.get(aid) || 0) + 1; seen.set(aid, n); const slot = ab.get(aid)?.slot ?? 0;
        return h("div", { class: `so-c s${slot}` + (n === 1 ? " unlock" : ""), style: `--k:${k}` }, icon(aid, 30), h("i", {}, n === 1 ? "new" : `T${n - 1}`), h("small", {}, mmss(o.times[k] ?? 0))); });
      return h("div", { class: "so-row" + (o.best ? " best" : "") },
        h("div", { class: "so-hd" }, h("b", {}, o.best ? "Highest win rate" : i === 0 ? "Most played" : `Option ${i + 1}`), h("span", {}, `${pct(o.share)} of games`), h("span", { class: o.win_rate >= 0.5 ? "win" : "loss" }, `${pct(o.win_rate)} win`), h("span", { class: "muted" }, `${o.matches.toLocaleString()} games`)),
        h("div", { class: "so-track" }, ...cells));
    });
    el.replaceChildren(legend, ...rows, h("p", { class: "fine" }, `Ability point order across ${d.total.toLocaleString()} games in the last 3 weeks (all ranks). "new" = first point in that ability; time = when the point usually goes in.`));
  } catch (e) { showError(el, e); }
}

/* ---------------- build path ---------------- */
export async function mountBuildPath(el, id, items) {
  try {
    const d = await api(`/heroes/${id}/build-path`); let mode = "best";
    const item = (i) => items.find((x) => x.id === i);
    const grid = h("div", { class: "bp" });
    const render = () => grid.replaceChildren(...d.columns.map((c, ci) => h("div", { class: "bp-col", style: `--c:${ci}` },
      h("div", { class: "bp-hd" }, h("span", { class: "marker" + (ci === 3 ? " gold" : "") }, String(ci + 1)), h("div", {}, h("b", {}, c.label), h("small", {}, c.reached ? `${c.reached.toLocaleString()} games · ${pct(c.base_win_rate)} win` : "few games"))),
      ...(c[mode].length ? c[mode].map((n, k) => { const it = item(n.item_id); const diff = c.base_win_rate != null ? n.win_rate - c.base_win_rate : 0;
        return h("div", { class: "bp-it", style: `--k:${k}` }, itemImg(it, 34) || h("span", { class: "ab0" }, "?"), h("div", { class: "nm" }, h("b", {}, it?.name ?? n.item_id), h("small", {}, `${pct(n.pick_rate)} buy it · at ${n.souls_at_buy.toLocaleString()} souls`), h("div", { class: "bar" }, h("i", { style: `width:${Math.min(100, (n.pick_rate || 0) * 250)}%` }))),
          h("span", { class: "wr " + (diff >= 0.01 ? "win" : diff <= -0.01 ? "loss" : "") }, pct(n.win_rate), h("small", {}, `${diff >= 0 ? "+" : "−"}${Math.abs(diff * 100).toFixed(1)}`))); }) : [h("p", { class: "muted" }, "Not enough games.")]))));
    el.replaceChildren(h("div", { class: "bp-ctl" }, segmented([["best", "Best win rate"], ["popular", "Most bought"]], mode, (v) => { mode = v; render(); }, "Sort items")), grid,
      h("p", { class: "fine" }, "Last 3 weeks, all ranks. Win rates are adjusted for how rich players were when they bought the item, so items people buy when already ahead don't look better than they are. The small number is the difference from the phase's average."));
    render();
  } catch (e) { showError(el, e); }
}

/* ---------------- laning ---------------- */
export async function mountLaning(partnersEl, toughEl, id, hs) {
  const hero = (i) => hs.find((x) => x.id === i);
  try {
    const d = await api(`/heroes/${id}/laning`);
    const max = Math.max(1, ...[...d.partners, ...d.tough, ...d.easy].map((r) => Math.abs(r.souls_lead_15)));
    const row = (r) => h("div", { class: "ln-r" }, h("span", { class: "duo" }, ...r.heroes.map((x) => heroIcon(hero(x), 30))), h("span", { class: "nm" }, r.heroes.map((x) => hero(x)?.name ?? x).join(" + "), h("small", {}, `${r.matches.toLocaleString()} lanes · ${pct(r.win_rate)} win`)),
      h("div", { class: "lead" }, h("i", { class: r.souls_lead_15 >= 0 ? "pos" : "neg", style: `width:${Math.abs(r.souls_lead_15) / max * 50}%` })), h("b", { class: r.souls_lead_15 >= 0 ? "win" : "loss" }, signed(r.souls_lead_15)));
    partnersEl.replaceChildren(...(d.partners.length ? d.partners.map(row) : [h("p", { class: "muted" }, "Not enough duo lanes yet.")]), h("p", { class: "fine" }, "Souls ahead of the enemy duo at 15 minutes, last 30 days."));
    toughEl.replaceChildren(...(d.tough.length ? d.tough.map(row) : [h("p", { class: "muted" }, "Not enough duo lanes yet.")]), h("p", { class: "fine" }, "Enemy duos that leave you furthest behind at 15 minutes."));
  } catch (e) { showError(partnersEl, e); toughEl.replaceChildren(); }
}
