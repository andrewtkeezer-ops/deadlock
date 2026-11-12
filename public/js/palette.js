// Quick search: Ctrl/⌘ K or "/" from anywhere. Jumps to pages, squad members, heroes and items.
import { api, h, heroes, items, visit } from "/js/app.js";

const PAGES = [["Leaderboard", "/", "Squad standings"], ["Heroes", "/heroes.html", "Pick a hero"], ["Draft helper", "/counters.html", "Counters and synergies"], ["Map", "/heatmap.html", "Where kills and deaths happen"],
  ["Builds", "/library.html", "Yours and the squad's"], ["New build", "/editor.html", "Open the build editor"], ["Build wizard", "/builds.html", "Generate a build from priorities"], ["Items", "/items.html", "The shop"], ["Patch watch", "/patches.html", "Balance changes"], ["Setup", "/setup.html", "Uploader and squad coverage"]];
const RECENT = "ss.pal.recent";
const store = { get: () => { try { return JSON.parse(localStorage.getItem(RECENT) || "[]"); } catch { return []; } }, set: (v) => { try { localStorage.setItem(RECENT, JSON.stringify(v.slice(0, 6))); } catch {} } };
let data = null, wrap = null;

async function load() {
  if (data) return data;
  const [hs, ps, its] = await Promise.all([heroes().catch(() => []), api("/players").catch(() => []), items().catch(() => [])]);
  data = [...PAGES.map(([label, href, sub]) => ({ kind: "Page", label, href, sub })),
    ...ps.map((p) => ({ kind: "Player", label: p.name, href: `/player.html?id=${p.account_id}`, img: p.avatar_url, round: true })),
    ...hs.map((x) => ({ kind: "Hero", label: x.name, href: `/hero.html?id=${x.id}`, img: x.images?.icon, sub: (x.hero_type || "").replace(/_/g, " ") })),
    ...its.map((i) => ({ kind: "Item", label: i.name, href: `/items.html?item=${i.id}`, img: i.image, sub: `${i.slot} · tier ${i.tier}` }))];
  return data;
}
/** Rank a row for a query: prefix > word start > substring > letters in order. 0 = no match. */
function score(row, q) {
  const s = row.label.toLowerCase(); if (s.startsWith(q)) return 100 - s.length * 0.1; const i = s.indexOf(q);
  if (i > 0) return (/[\s&\-]/.test(s[i - 1]) ? 80 : 60) - i * 0.1;
  let k = 0; for (const ch of s) if (ch === q[k]) k++; return k === q.length && q.length > 1 ? 30 - s.length * 0.1 : 0;
}
const KIND_BOOST = { Player: 6, Hero: 4, Page: 2, Item: 0 };

export async function open() {
  if (wrap) return wrap.querySelector("input").focus();
  const prev = document.activeElement;
  const input = h("input", { type: "text", placeholder: "Jump to a hero, player, item or page…", autocomplete: "off", spellcheck: "false", "aria-label": "Search", role: "combobox", "aria-expanded": "true", "aria-controls": "pal-list" });
  const list = h("div", { class: "pal-list", id: "pal-list", role: "listbox" });
  wrap = h("div", { class: "pal-wrap", onmousedown: (e) => { if (e.target === wrap) close(); } },
    h("div", { class: "pal", role: "dialog", "aria-modal": "true", "aria-label": "Quick search" },
      h("div", { class: "pal-in" }, h("span", { class: "ic", "aria-hidden": "true" }, "⌕"), input, h("kbd", {}, "Esc")), list,
      h("div", { class: "pal-ft" }, h("span", {}, h("kbd", {}, "↑"), h("kbd", {}, "↓"), " move"), h("span", {}, h("kbd", {}, "Enter"), " open"), h("span", {}, h("kbd", {}, "/"), " search from any page"))));
  document.body.append(wrap); document.documentElement.classList.add("locked"); input.focus();
  let rows = [], idx = 0;
  function close() { wrap?.remove(); wrap = null; document.documentElement.classList.remove("locked"); prev?.focus?.({ preventScroll: true }); }
  const pick = (r) => { if (!r) return; store.set([r, ...store.get().filter((x) => x.href !== r.href)]); close(); if (r.href !== location.pathname + location.search) visit(r.href); };
  const paint = () => {
    list.replaceChildren(...(rows.length ? rows.flatMap((r, i) => [r.head ? h("div", { class: "pal-hd" }, r.head) : "",
      h("div", { class: "pal-row" + (i === idx ? " on" : ""), role: "option", "aria-selected": String(i === idx), onmousemove: () => { if (idx !== i) { idx = i; mark(); } }, onclick: () => pick(r) },
        r.img ? h("img", { src: r.img, alt: "", class: r.round ? "round" : "", loading: "lazy", onerror: (e) => e.target.replaceWith(h("span", { class: "ph" }, r.label[0])) }) : h("span", { class: "ph" }, r.kind === "Page" ? "→" : r.label[0]),
        h("span", { class: "nm" }, r.label, r.sub ? h("small", {}, r.sub) : ""), h("span", { class: "k k-" + r.kind.toLowerCase() }, r.kind))]) : [h("p", { class: "pal-none" }, data ? "Nothing matches. Try a hero, a squad member or an item name." : "Loading…")]));
  };
  const mark = () => { [...list.querySelectorAll(".pal-row")].forEach((el, i) => { el.classList.toggle("on", i === idx); el.setAttribute("aria-selected", String(i === idx)); }); list.querySelectorAll(".pal-row")[idx]?.scrollIntoView({ block: "nearest" }); };
  const run = () => {
    const q = input.value.trim().toLowerCase(); idx = 0;
    if (!data) { rows = []; return paint(); }
    if (!q) { const rec = store.get().filter((r) => data.some((d) => d.href === r.href)).map((r, i) => ({ ...r, head: i ? null : "Recent" }));
      const seen = new Set(rec.map((r) => r.href)); const rest = data.filter((d) => (d.kind === "Page" || d.kind === "Player") && !seen.has(d.href));
      let last = ""; rows = [...rec, ...rest.map((d) => { const head = d.kind !== last ? (d.kind === "Page" ? "Pages" : "Squad") : null; last = d.kind; return { ...d, head }; })]; return paint(); }
    rows = data.map((d) => ({ d, s: score(d, q) })).filter((x) => x.s > 0).map((x) => ({ ...x, s: x.s + KIND_BOOST[x.d.kind] })).sort((a, b) => b.s - a.s).slice(0, 14).map((x) => ({ ...x.d, head: null })); paint();
  };
  input.addEventListener("input", run);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) { e.preventDefault(); idx = rows.length ? (idx + 1) % rows.length : 0; mark(); }
    else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) { e.preventDefault(); idx = rows.length ? (idx - 1 + rows.length) % rows.length : 0; mark(); }
    else if (e.key === "Enter") { e.preventDefault(); pick(rows[idx]); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
  });
  paint(); await load(); if (wrap) run();
}
