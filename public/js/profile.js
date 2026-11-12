// Profile extras: achievements, trend charts and "compared to your rank". Mounted by player.html.
import { api, h, $, pct, heroIcon, assets, segmented, showError } from "/js/app.js";
import { achievementToast } from "/js/game.js";

const ROMAN = ["", "I", "II", "III"];
const fmtN = (v, f) => (f === "pct" ? `${(v * 100).toFixed(1)}%` : f === "n1" ? v.toFixed(1) : Math.round(v).toLocaleString());
const dateS = (t) => new Date(t * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: new Date(t * 1000).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
const store = { get: (k) => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };

/* ---------------- achievements ---------------- */
export async function mountAchievements(card, id, isMe) {
  const body = card.querySelector(".ach"), count = card.querySelector(".achcount");
  try {
    const { defs, results } = await api(`/players/${id}/achievements`);
    const R = new Map(results.map((r) => [r.key, r]));
    const total = defs.length * 3, got = results.reduce((n, r) => n + r.tiers.length, 0);
    count.textContent = `· ${got} of ${total} unlocked`;
    const rows = defs.map((d) => { const r = R.get(d.key) || { best: 0, tiers: [] }; return { d, r, tier: r.tiers.length }; }).sort((a, b) => b.tier - a.tier || (b.r.tiers.at(-1)?.earned_at ?? 0) - (a.r.tiers.at(-1)?.earned_at ?? 0));
    body.replaceChildren(...rows.map(({ d, r, tier }) => {
      const nextT = d.tiers[tier], last = r.tiers.at(-1);
      const prog = nextT == null ? 1 : d.lower ? (r.best ? Math.max(0, Math.min(1, (d.tiers[0] * 1.6 - r.best) / (d.tiers[0] * 1.6 - nextT))) : 0) : Math.max(0, Math.min(1, r.best / nextT));
      const goal = nextT == null ? "Maxed out" : d.how.replace("{n}", nextT.toLocaleString());
      const best = r.best ? (d.key === "farmer" ? Math.round(r.best) : d.key === "kda" ? r.best.toFixed(1) : d.key === "speedrun" || d.key === "marathon" ? Math.round(r.best) : r.best.toLocaleString()) + (d.unit || "") : "–";
      return h(last ? "a" : "div", { class: `ach-m t${tier} l-${d.lane}`, href: last ? `/match.html?id=${last.match_id}` : undefined, title: last ? `Unlocked ${dateS(last.earned_at)} · open the game` : goal },
        h("div", { class: "medal" }, h("span", {}, d.icon), h("i", { class: "ring" })),
        h("div", { class: "tx" },
          h("b", {}, d.name, tier ? h("em", {}, ROMAN[tier]) : ""),
          h("span", { class: "goal" }, goal),
          h("div", { class: "pips" }, ...[1, 2, 3].map((t) => h("i", { class: t <= tier ? "on" : "" }))),
          h("div", { class: "bar" }, h("i", { style: `width:${prog * 100}%` })),
          h("small", {}, last ? `Unlocked ${dateS(last.earned_at)} · best ${best}` : `Best ${best}`)));
    }));
    if (isMe) {
      // Unlock banners for anything this browser hasn't celebrated yet (one summary the very first time, so a backfill isn't 30 banners).
      const keyOf = (k, t) => `${k}:${t}`, seen = new Set(store.get("ss.ach.seen") || []), all = results.flatMap((r) => r.tiers.map((t) => ({ ...t, key: r.key })));
      const fresh = all.filter((t) => !seen.has(keyOf(t.key, t.tier))).sort((a, b) => b.earned_at - a.earned_at);
      if (!store.get("ss.ach.seen") && fresh.length > 3) achievementToast({ icon: "✦", name: `${fresh.length} achievements`, kicker: "Your record so far", how: "Every game you've played counts. They're under the Achievements tab." });
      else fresh.slice(0, 3).forEach((t) => { const d = defs.find((x) => x.key === t.key); achievementToast({ icon: d.icon, name: d.name, tier: t.tier, how: d.how.replace("{n}", d.tiers[t.tier - 1].toLocaleString()) }); });
      store.set("ss.ach.seen", all.map((t) => keyOf(t.key, t.tier)));
    }
  } catch (e) { showError(body, e); }
}

/* ---------------- trend charts ---------------- */
const METRICS = {
  wr: { label: "Win rate", win: 10, val: (g) => g.won, fmt: (v) => pct(v), axis: (v) => `${Math.round(v * 100)}%`, fixed: [0, 1] },
  kda: { label: "KDA", win: 7, val: (g) => (g.kills + g.assists) / Math.max(1, g.deaths), fmt: (v) => v.toFixed(2), axis: (v) => v.toFixed(1) },
  spm: { label: "Souls / min", win: 7, val: (g) => (g.net_worth * 60) / Math.max(60, g.duration_s), fmt: (v) => Math.round(v).toLocaleString(), axis: (v) => Math.round(v).toLocaleString() },
};
export async function mountTrends(card, id, hs) {
  const box = card.querySelector(".trend"), ctl = card.querySelector(".tctl"), sum = card.querySelector(".tsum");
  let metric = store.get("ss.trend.m") || "wr", days = 90, heroF = "", games = [];
  const heroSel = h("select", { "aria-label": "Hero" }, h("option", { value: "" }, "All heroes"));
  const daySel = h("select", { "aria-label": "Window" }, ...[[30, "Last 30 days"], [90, "Last 90 days"], [365, "Last year"], [3650, "All time"]].map(([v, l]) => h("option", { value: v, selected: v === days ? "" : undefined }, l)));
  ctl.replaceChildren(segmented(Object.entries(METRICS).map(([k, m]) => [k, m.label]), metric, (v) => { metric = v; store.set("ss.trend.m", v); draw(); }, "Trend metric"), heroSel, daySel);
  heroSel.onchange = () => { heroF = heroSel.value; draw(); }; daySel.onchange = () => { days = +daySel.value; load(); };
  async function load() {
    try { ({ games } = await api(`/players/${id}/trends?days=${days}`)); } catch (e) { return showError(box, e); }
    const counts = new Map(); games.forEach((g) => counts.set(g.hero_id, (counts.get(g.hero_id) || 0) + 1));
    const keep = heroSel.value; heroSel.replaceChildren(h("option", { value: "" }, "All heroes"), ...[...counts].sort((a, b) => b[1] - a[1]).map(([hid, n]) => h("option", { value: hid }, `${hs.find((x) => x.id === hid)?.name ?? hid} (${n})`))); heroSel.value = counts.has(+keep) ? keep : ""; heroF = heroSel.value;
    draw();
  }
  function draw() {
    const M = METRICS[metric], list = games.filter((g) => !heroF || g.hero_id === +heroF);
    if (list.length < 3) { sum.replaceChildren(); return box.replaceChildren(h("p", { class: "muted", style: "margin:30px 0;text-align:center" }, list.length ? "Play a few more games to see a trend." : "No games in this window.")); }
    const vals = list.map(M.val), W = Math.min(M.win, Math.max(3, Math.floor(list.length / 3)));
    const roll = vals.map((_, i) => { const s = vals.slice(Math.max(0, i - W + 1), i + 1); return s.reduce((a, b) => a + b, 0) / s.length; });
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const Wd = 900, Ht = 240, pl = 46, pr = 14, pt = 16, pb = 28;
    let [lo, hi] = M.fixed || [Math.min(...roll, avg) * 0.85, Math.max(...roll, avg) * 1.1]; if (hi - lo < 1e-6) hi = lo + 1;
    const X = (i) => pl + (i / (list.length - 1)) * (Wd - pl - pr), Y = (v) => pt + (1 - (v - lo) / (hi - lo)) * (Ht - pt - pb);
    const path = roll.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join("");
    const area = `${path}L${X(list.length - 1).toFixed(1)},${Ht - pb}L${pl},${Ht - pb}Z`;
    const ticks = Array.from({ length: 4 }, (_, k) => lo + ((hi - lo) * k) / 3);
    const dates = [0, Math.floor((list.length - 1) / 2), list.length - 1];
    const NS = "http://www.w3.org/2000/svg"; const svg = document.createElementNS(NS, "svg"); svg.setAttribute("viewBox", `0 0 ${Wd} ${Ht}`); svg.setAttribute("class", "tchart"); svg.setAttribute("role", "img"); svg.setAttribute("aria-label", `${M.label} over ${list.length} games`);
    svg.innerHTML = `<defs><linearGradient id="tg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--lane-y)" stop-opacity=".32"/><stop offset="1" stop-color="var(--lane-y)" stop-opacity="0"/></linearGradient></defs>
      ${ticks.map((t) => `<line x1="${pl}" x2="${Wd - pr}" y1="${Y(t)}" y2="${Y(t)}" class="grid"/><text x="${pl - 8}" y="${Y(t) + 4}" class="ax" text-anchor="end">${M.axis(t)}</text>`).join("")}
      ${dates.map((i) => `<text x="${X(i)}" y="${Ht - 8}" class="ax" text-anchor="${i === 0 ? "start" : i === list.length - 1 ? "end" : "middle"}">${dateS(list[i].start_time)}</text>`).join("")}
      <line x1="${pl}" x2="${Wd - pr}" y1="${Y(avg)}" y2="${Y(avg)}" class="avg"/><text x="${Wd - pr}" y="${Y(avg) - 6}" class="ax avgt" text-anchor="end">avg ${M.fmt(avg)}</text>
      ${list.map((g, i) => `<circle cx="${X(i)}" cy="${Y(Math.max(lo, Math.min(hi, vals[i])))}" r="2.6" class="dot ${g.won ? "w" : "l"}"/>`).join("")}
      <path d="${area}" class="area"/><path d="${path}" class="line" pathLength="1"/>
      <circle cx="${X(list.length - 1)}" cy="${Y(roll.at(-1))}" r="5" class="head"/>
      <g class="hover" opacity="0"><line class="hx" y1="${pt}" y2="${Ht - pb}"/><circle class="hp" r="5"/></g>`;
    const tip = h("div", { class: "ttipbox" }); box.replaceChildren(svg, tip);
    svg.addEventListener("pointermove", (e) => { const r = svg.getBoundingClientRect(); const x = ((e.clientX - r.left) / r.width) * Wd; const i = Math.max(0, Math.min(list.length - 1, Math.round(((x - pl) / (Wd - pl - pr)) * (list.length - 1)))); const g = list[i];
      const hv = svg.querySelector(".hover"); hv.setAttribute("opacity", "1"); hv.querySelector(".hx").setAttribute("x1", X(i)); hv.querySelector(".hx").setAttribute("x2", X(i)); hv.querySelector(".hp").setAttribute("cx", X(i)); hv.querySelector(".hp").setAttribute("cy", Y(roll[i]));
      const hx = hs.find((x) => x.id === g.hero_id); tip.replaceChildren(h("b", {}, `${M.fmt(roll[i])}`, h("span", {}, ` ${W}-game avg`)), h("div", {}, heroIcon(hx, 18), ` ${hx?.name ?? ""} · `, h("span", { class: g.won ? "win" : "loss" }, g.won ? "Win" : "Loss"), ` · ${M.fmt(vals[i])}`), h("small", {}, dateS(g.start_time)));
      tip.style.left = `${Math.min(r.width - 170, Math.max(0, (X(i) / Wd) * r.width - 85))}px`; tip.classList.add("on"); });
    svg.addEventListener("pointerleave", () => { svg.querySelector(".hover").setAttribute("opacity", "0"); tip.classList.remove("on"); });
    // summary: last stretch vs the one before it
    const n = Math.min(10, Math.floor(vals.length / 2)), recent = vals.slice(-n), before = vals.slice(-2 * n, -n), mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const d = mean(recent) - mean(before), up = d >= 0, rel = metric === "wr" ? `${up ? "+" : "−"}${Math.abs(d * 100).toFixed(0)} pts` : `${up ? "+" : "−"}${M.fmt(Math.abs(d))}`;
    sum.replaceChildren(h("span", {}, `Last ${n} games `, h("b", {}, M.fmt(mean(recent)))), h("span", { class: up ? "win" : "loss" }, `${up ? "▲" : "▼"} ${rel} vs the ${n} before`), h("span", { class: "muted" }, `${list.length} games · ${W}-game rolling average`));
  }
  load();
}

/* ---------------- compared to your rank ---------------- */
export async function mountBench(card, id, hs) {
  const box = card.querySelector(".bench"), title = card.querySelector(".btitle");
  try {
    const [b, a] = await Promise.all([api(`/players/${id}/benchmarks`), assets()]);
    if (!b.rank) { title.textContent = "Compared to your rank"; return box.replaceChildren(h("div", { class: "empty-note" }, h("b", {}, "Needs a rank first"), h("p", { class: "muted" }, "This compares your typical game with everyone else at your rank. A new ranked season started in early November, so ranks reset; play a few Ranked games and it fills in."))); }
    const r = a.ranks.find((x) => x.tier === b.tier); const rn = r?.name ?? `Tier ${b.tier}`;
    title.replaceChildren("Compared to ", h("span", { class: "hl2" }, rn), " players");
    if (!b.groups.length) return box.replaceChildren(h("p", { class: "muted" }, "Not enough games with full stats in the last 90 days yet. Games appear here once someone's uploader sends them."));
    let gi = 0; const rowsBox = h("div", { class: "brows" });
    const tabs = b.groups.length > 1 ? segmented(b.groups.map((g, i) => [i, g.hero_id ? hs.find((x) => x.id === g.hero_id)?.name ?? `#${g.hero_id}` : "Overall"]), 0, (v) => { gi = +v; render(); }, "Compare on") : null;
    box.replaceChildren(...[tabs, rowsBox, h("p", { class: "fine" }, `Your median game over the last 90 days, placed among single ${rn} games from the last 30 days (deadlock-api). 50% = a typical ${rn} game.`)].filter(Boolean));
    function render() {
      const g = b.groups[gi];
      rowsBox.replaceChildren(...g.metrics.map((m, k) => { const good = m.pct >= 60, bad = m.pct < 40;
        return h("div", { class: "brow", style: `--k:${k}` }, h("div", { class: "bl" }, h("b", {}, m.label), h("span", {}, "You ", h("strong", {}, fmtN(m.you, m.fmt)), ` · typical ${fmtN(m.median, m.fmt)}`)),
          h("div", { class: "track" }, h("i", { class: "q" }), h("span", { class: "pin " + (good ? "good" : bad ? "bad" : ""), style: `--p:${m.pct}%` }, h("em", {}, `${m.pct}`))),
          h("div", { class: "bv " + (good ? "win" : bad ? "loss" : "") }, `Better than ${m.pct}%`)); }));
    }
    render();
  } catch (e) { showError(box, e); }
}

/* ---------------- how your games unfold ---------------- */
const SRC_LABEL = { gold_lane_creep: ["Lane troopers", "var(--lane-y)"], gold_neutral_creep: ["Jungle camps", "var(--lane-g)"], gold_player: ["Hero kills", "var(--ink)"], gold_assists: ["Assists", "#e9a07a"], gold_boss: ["Objectives", "var(--lane-b)"], gold_treasure: ["Urn & treasure", "#c792ea"], gold_breakable: ["Crates", "#b0a18a"], gold_team_bonus: ["Team bonus", "#7f8c8d"], gold_denied: ["Denies", "#9aa"] };
export async function mountCurve(card, id, hs) {
  const box = card.querySelector(".curve"), sub = card.querySelector(".csub");
  try {
    const [d, a] = await Promise.all([api(`/players/${id}/curve`), assets()]);
    if (d.you.length < 3) return box.replaceChildren(h("div", { class: "empty-note" }, h("b", {}, "Not enough full games yet"), h("p", { class: "muted" }, "This needs games with full stats (uploaded by someone in the match) from the last 90 days.")));
    const rn = d.tier ? a.ranks.find((x) => x.tier === d.tier)?.name : null; const who = rn ? `typical ${rn}` : "typical player";
    sub.textContent = `· you vs a ${who}`;
    const ref = new Map(d.ref.map((p) => [p.t, p])); const pts = d.you.filter((p) => ref.has(p.t) && p.t <= 2400);
    const Wd = 900, Ht = 250, pl = 54, pr = 16, pt = 18, pb = 30, tMax = pts.at(-1).t, vMax = Math.max(...pts.map((p) => Math.max(p.nw, ref.get(p.t).nw))) * 1.06;
    const X = (t) => pl + (t / tMax) * (Wd - pl - pr), Y = (v) => pt + (1 - v / vMax) * (Ht - pt - pb);
    const line = (get) => pts.map((p, i) => `${i ? "L" : "M"}${X(p.t).toFixed(1)},${Y(get(p)).toFixed(1)}`).join("");
    const youL = line((p) => p.nw), refL = line((p) => ref.get(p.t).nw);
    const gap = `${youL}${[...pts].reverse().map((p) => `L${X(p.t).toFixed(1)},${Y(ref.get(p.t).nw).toFixed(1)}`).join("")}Z`;
    const at = (sec) => { const p = pts.reduce((b, x) => (Math.abs(x.t - sec) < Math.abs(b.t - sec) ? x : b), pts[0]); return { p, r: ref.get(p.t) }; };
    const marks = [900, 1800].filter((s) => s <= tMax).map(at);
    const NS = "http://www.w3.org/2000/svg", svg = document.createElementNS(NS, "svg"); svg.setAttribute("viewBox", `0 0 ${Wd} ${Ht}`); svg.setAttribute("class", "tchart cchart");
    const yt = [0, .25, .5, .75, 1].map((f) => vMax * f);
    svg.innerHTML = `<defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--lane-b)" stop-opacity=".25"/><stop offset="1" stop-color="var(--lane-b)" stop-opacity="0"/></linearGradient></defs>
      ${yt.map((v) => `<line x1="${pl}" x2="${Wd - pr}" y1="${Y(v)}" y2="${Y(v)}" class="grid"/><text x="${pl - 8}" y="${Y(v) + 4}" class="ax" text-anchor="end">${v >= 1000 ? Math.round(v / 1000) + "k" : 0}</text>`).join("")}
      ${pts.filter((p) => p.t % 300 === 0 || p.t === 180).map((p) => `<text x="${X(p.t)}" y="${Ht - 8}" class="ax" text-anchor="middle">${Math.round(p.t / 60)}m</text>`).join("")}
      <path d="${gap}" class="gap ${pts.at(-1).nw >= ref.get(pts.at(-1).t).nw ? "ahead" : "behind"}"/>
      <path d="${refL}" class="refl" pathLength="1"/><path d="${youL}" class="line youl" pathLength="1"/>
      ${marks.map(({ p, r }) => `<line x1="${X(p.t)}" x2="${X(p.t)}" y1="${pt}" y2="${Ht - pb}" class="mk"/><circle cx="${X(p.t)}" cy="${Y(p.nw)}" r="5" class="head"/>`).join("")}
      <text x="${X(pts.at(-1).t) - 4}" y="${Y(pts.at(-1).nw) - 10}" class="ax lab you" text-anchor="end">You</text><text x="${X(pts.at(-1).t) - 4}" y="${Y(ref.get(pts.at(-1).t).nw) + 18}" class="ax lab" text-anchor="end">${rn ?? "Typical"}</text>`;
    const callouts = marks.map(({ p, r }) => { const diff = (p.nw - r.nw) / Math.max(1, r.nw);
      return h("div", { class: "co" }, h("small", {}, `At ${Math.round(p.t / 60)} minutes`), h("b", {}, `${p.nw.toLocaleString()} souls`), h("span", { class: diff >= 0 ? "win" : "loss" }, `${diff >= 0 ? "+" : "−"}${Math.abs(diff * 100).toFixed(0)}% vs ${r.nw.toLocaleString()}`)); });
    // where the souls come from at ~15 min, you vs typical
    const { p: p15, r: r15 } = at(900); const keys = Object.keys(SRC_LABEL).filter((k) => (p15.src[k] || 0) + (r15.src[k] || 0) > 150);
    const sMax = Math.max(...keys.map((k) => Math.max(p15.src[k] || 0, r15.src[k] || 0)), 1);
    const sources = h("div", { class: "src" }, h("h4", {}, `Where the souls come from by ${Math.round(p15.t / 60)} minutes`), ...keys.sort((x, y) => (r15.src[y] || 0) - (r15.src[x] || 0)).map((k) => { const y = p15.src[k] || 0, t = r15.src[k] || 0, diff = t ? (y - t) / t : 0;
      return h("div", { class: "sr" }, h("span", { class: "sl" }, h("i", { style: `background:${SRC_LABEL[k][1]}` }), SRC_LABEL[k][0]), h("div", { class: "sb2" }, h("i", { class: "y", style: `width:${y / sMax * 100}%;background:${SRC_LABEL[k][1]}` }), h("i", { class: "t", style: `width:${t / sMax * 100}%` })),
        h("b", {}, y.toLocaleString()), h("span", { class: Math.abs(diff) < 0.08 ? "muted" : diff > 0 ? "win" : "loss" }, `${diff >= 0 ? "+" : "−"}${Math.abs(diff * 100).toFixed(0)}%`)); }),
      h("p", { class: "fine" }, `Solid bar = you, outline = ${who}.`));
    const L = d.lane; const lane = L ? h("div", { class: "lanebox" }, h("h4", {}, "Your lanes"), h("div", { class: "lk" }, h("div", {}, h("b", { class: L.souls_lead_15 >= 0 ? "win" : "loss" }, `${L.souls_lead_15 >= 0 ? "+" : "−"}${Math.abs(L.souls_lead_15).toLocaleString()}`), h("span", {}, "souls vs your lane opponents at 15 min")), h("div", {}, h("b", {}, pct(L.win_rate)), h("span", {}, `of ${L.matches} duo-lane games won`))),
      ...L.partners.map((x) => h("div", { class: "lp" }, h("span", { class: "duo" }, ...x.heroes.map((hid) => heroIcon(hs.find((y) => y.id === hid), 24))), h("span", {}, x.heroes.map((hid) => hs.find((y) => y.id === hid)?.name ?? hid).join(" + "), h("small", {}, ` · ${x.matches} lanes`)), h("b", { class: x.souls_lead_15 >= 0 ? "win" : "loss" }, `${x.souls_lead_15 >= 0 ? "+" : "−"}${Math.abs(x.souls_lead_15).toLocaleString()}`)))) : null;
    box.replaceChildren(h("div", { class: "cgrid" }, h("div", { class: "cmain" }, svg, h("div", { class: "cos" }, ...callouts)), h("div", { class: "cside" }, sources, lane)),
      h("p", { class: "fine" }, `Your average over the last 90 days of games with full stats, against ${rn ? `${rn} games` : "all games"} from the last 30 days (deadlock-api).`));
  } catch (e) { showError(box, e); }
}
