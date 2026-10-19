// Shared helpers. No framework, no build step.
export const api = async (path, opts = {}) => {
  const res = await fetch(`/api${path}`, { headers: { "content-type": "application/json", ...(opts.headers || {}) }, ...opts,
    body: opts.body && typeof opts.body !== "string" ? JSON.stringify(opts.body) : opts.body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || res.statusText);
  return data;
};
export const $ = (s, el = document) => el.querySelector(s);
export const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) k === "class" ? (el.className = v) : k.startsWith("on") ? el.addEventListener(k.slice(2), v) : v !== undefined && v !== null && el.setAttribute(k, v);
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) el.append(k instanceof Node ? k : document.createTextNode(k));
  return el;
};
export const pct = (x) => (x == null || Number.isNaN(x) ? "–" : (x * 100).toFixed(1) + "%");
export const ago = (ts) => { if (!ts) return "never"; const s = Date.now() / 1000 - ts; return s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`; };
export const dur = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
export const fmt = (n) => (n == null ? "–" : Math.round(n).toLocaleString());

// ---- cached reference data ----
let heroCache, assetCache, itemCache, meCache;
export async function heroes() { return (heroCache ??= await api("/heroes")); }
export async function hero(id) { return (await heroes()).find((x) => x.id === id); }
export async function heroName(id) { return (await hero(id))?.name ?? `#${id}`; }
export async function assets() { return (assetCache ??= await api("/assets")); }
export async function items() { return (itemCache ??= await api("/library/items")); }
export async function me() { return (meCache ??= await Promise.all([api("/me"), api("/auth/steam/me")]).then(([m, s]) => ({ ...m, account_id: m.account_id ?? s.account_id }))); }

/** Rank badge <img> for a deadlock-api `rank` value (tier*10 + subrank), or a placeholder span. */
export async function rankBadge(rank, size = "small") {
  const a = await assets(); if (!rank) return h("span", { class: "muted" }, "unranked");
  const tier = Math.floor(rank / 10), sub = rank % 10; const r = a.ranks.find((x) => x.tier === tier);
  const src = r ? (size === "large" ? (r.badge?.[sub - 1] || r.large) : (r.small?.[sub - 1] || r.large)) : null;
  const label = r ? `${r.name} ${sub || ""}`.trim() : `Rank ${rank}`;
  return src ? h("img", { src, alt: label, title: label, class: "rank " + size }) : h("span", {}, label);
}
export function heroIcon(hx, size = 28) { return hx?.images?.icon ? h("img", { src: hx.images.icon, alt: hx.name, title: hx.name, width: size, height: size, class: "hicon" }) : h("span", {}, hx?.name ?? "?"); }
export function itemImg(it, size = 26) { return it?.image ? withTip(h("img", { src: it.image, alt: it.name, width: size, height: size, class: "iimg " + (it.slot || "") }), it) : null; }

// ---- item tooltip (in-game style) ----
let tipEl;
export function itemTooltip(it) {
  const card = h("div", { class: "itip " + (it.slot || "") }, h("div", { class: "t" }, it.image ? h("img", { src: it.image, alt: "" }) : "", h("div", {}, h("b", {}, it.name), h("div", { class: "muted" }, `${(it.slot || "").toUpperCase()} · TIER ${it.tier ?? "?"} · ${(it.cost || 0).toLocaleString()} souls`))),
    it.activation && it.activation !== "passive" ? h("div", { class: "act" }, it.activation.toUpperCase()) : "",
    h("div", { class: "stats" }, ...(it.stats || []).map((st) => h("div", { class: "st" + (st.elevated ? " big" : "") }, h("span", { class: "v" }, st.value), " ", h("span", {}, st.label)))),
    it.description ? h("div", { class: "desc" }, stripHtml(it.description)) : "",
    it.components?.length ? h("div", { class: "muted", style: "font-size:11px;margin-top:6px" }, "Upgrades from " + it.components.map((c) => c.replace(/^upgrade_/, "").replace(/_/g, " ")).join(", ")) : "");
  return card;
}
export const stripHtml = (t) => { const d = document.createElement("div"); d.innerHTML = (t || "").replace(/<(?!\/?span)[^>]*>/g, ""); return d; };
export function abilityTooltip(a) {
  return h("div", { class: "itip atip" }, h("div", { class: "t" }, a.image ? h("img", { src: a.image, alt: "" }) : "", h("div", {}, h("b", {}, a.name), h("div", { class: "muted" }, a.key === "ultimate" ? "ULTIMATE" : `ABILITY ${a.key}`))),
    h("div", { class: "nums" }, a.cooldown ? h("span", {}, "⟳ ", h("b", {}, `${a.cooldown}s`), " cooldown") : "", a.duration ? h("span", {}, "⏱ ", h("b", {}, `${a.duration}s`)) : "", a.range ? h("span", {}, "↔ ", h("b", {}, `${a.range}m`)) : "", a.charges ? h("span", {}, "×", h("b", {}, String(a.charges)), " charges") : ""),
    a.description ? h("div", { class: "desc" }, stripHtml(a.description)) : "",
    ...(a.tiers || []).map((t, i) => h("div", { class: "tier" }, h("b", {}, `T${i + 1}`), stripHtml(t))));
}
/** Attach a hover tooltip built by `build()` to any element. */
export function withTipBuilder(el, build) {
  el.addEventListener("mouseenter", (e) => { tipEl?.remove(); tipEl = build(); tipEl.style.position = "fixed"; document.body.append(tipEl); place(e); });
  el.addEventListener("mousemove", place); el.addEventListener("mouseleave", () => { tipEl?.remove(); tipEl = null; });
  function place(e) { if (!tipEl) return; const w = tipEl.offsetWidth, hgt = tipEl.offsetHeight; let x = e.clientX + 16, y = e.clientY + 16; if (x + w > innerWidth - 8) x = e.clientX - w - 16; if (y + hgt > innerHeight - 8) y = innerHeight - hgt - 8; tipEl.style.left = x + "px"; tipEl.style.top = y + "px"; }
  return el;
}
/** Glass modal. Returns the body element; closes on backdrop click or Esc. */
export function modal(title, body) {
  const close = () => { wrap.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  const wrap = h("div", { class: "modal-wrap", onclick: (e) => { if (e.target === wrap) close(); } }, h("div", { class: "modal" }, h("div", { class: "mh" }, h("h2", {}, title), h("button", { class: "close", onclick: close }, "×")), h("div", { class: "mb" }, body)));
  document.body.append(wrap); document.addEventListener("keydown", onKey); return wrap;
}
/** Attach a hover tooltip to any element for an item. */
export function withTip(el, it) {
  if (!it) return el;
  el.addEventListener("mouseenter", (e) => { tipEl?.remove(); tipEl = itemTooltip(it); tipEl.style.position = "fixed"; document.body.append(tipEl); place(e); });
  el.addEventListener("mousemove", place); el.addEventListener("mouseleave", () => { tipEl?.remove(); tipEl = null; });
  function place(e) { if (!tipEl) return; const w = tipEl.offsetWidth, hgt = tipEl.offsetHeight; let x = e.clientX + 16, y = e.clientY + 16; if (x + w > innerWidth - 8) x = e.clientX - w - 16; if (y + hgt > innerHeight - 8) y = innerHeight - hgt - 8; tipEl.style.left = x + "px"; tipEl.style.top = y + "px"; }
  return el;
}

// ---- page chrome: atmosphere + left rail ----
const ICONS = {
  trophy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4z"/><path d="M7 6H4a3 3 0 0 0 3 5M17 6h3a3 3 0 0 1-3 5"/></svg>',
  hero: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7c0-2 3-4 8-4s8 2 8 4v6c0 4-4 8-8 8s-8-4-8-8V7z"/><path d="M8 11c1 1 2 1 3 0M13 11c1 1 2 1 3 0M9 16c2 1 4 1 6 0"/></svg>',
  swords: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21l6-6M21 3l-9 9M14 5l5 5M5 14l5 5M3 3l9 9M19 21l-6-6M10 5L5 10M19 14l-5 5"/></svg>',
  map: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 3v18M3 12h18M6 6l12 12M18 6L6 18"/></svg>',
  book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h7a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4V4zM20 4h-7a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h8V4z"/></svg>',
  bag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8h14l-1 12H6L5 8z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z"/><path d="M9 12l2 2 4-4"/></svg>',
};
export function shell(active) {
  if (!document.querySelector(".atmo")) {
    document.body.prepend(h("div", { class: "atmo" }, h("div", { class: "base" }), h("div", { class: "fog" }), h("div", { class: "grain" }), h("div", { class: "mark" }), h("div", { class: "vig" })));
    const page = h("div", { class: "page" }); const mains = [...document.body.querySelectorAll(":scope > main")]; mains.forEach((m) => page.append(m)); document.body.append(page);
  }
  const links = [["/", "Leaderboard", "trophy"], ["/heroes.html", "Heroes", "hero"], ["/counters.html", "Draft", "swords"], ["/heatmap.html", "Map", "map"], ["/library.html", "Builds", "book"], ["/items.html", "Items", "bag"], ["/setup.html", "Setup", "gear"]];
  const mk = ([href, label, ic]) => { const a = h("a", { href, class: href === active ? "active" : "" }); a.innerHTML = `<span class="ic">${ICONS[ic]}</span><span class="lb">${label}</span>`; return a; };
  const nav = h("nav", {}, ...links.map(mk));
  const who = h("div", { class: "who" });
  const rail = h("aside", { class: "rail" }, h("a", { class: "brand", href: "/" }, h("img", { class: "mark", src: "/img/icon.png", alt: "" }), h("img", { class: "word", src: "/img/logo.webp", alt: "Soul Scribe" })), nav, who);
  document.body.prepend(rail);
  me().then(async (m) => {
    if (m.role === "admin") nav.append(mk(["/admin.html", "Admin", "shield"]));
    if (m.account_id) {
      let p = null; try { p = (await api("/players")).find((x) => x.account_id === m.account_id); } catch {}
      const a = h("a", { href: `/player.html?id=${m.account_id}` }, p?.avatar_url ? h("img", { class: "av", src: p.avatar_url, alt: "" }) : h("span", { class: "av" }), h("span", { class: "nm" }, p?.name ?? "My profile", h("small", {}, "View profile")));
      who.append(a); if (p?.mmr_rank) try { const b = await rankBadge(p.mmr_rank); b.style.height = "26px"; a.querySelector("small").replaceChildren(b, " ", p.mmr_score != null ? String(Math.round(p.mmr_score)) : ""); } catch {}
    } else who.append(h("a", { href: "/api/auth/steam/login", title: "Sign in through Steam" }, h("img", { class: "steam", src: "https://community.cloudflare.steamstatic.com/public/images/signinthroughsteam/sits_small.png", alt: "Sign in through Steam" })));
  }).catch(() => {});
}
/** Count-up animation for a number element. */
export function countUp(el, to, { decimals = 0, suffix = "", ms = 700 } = {}) { const start = performance.now(); const from = 0; const step = (t) => { const k = Math.min(1, (t - start) / ms); const v = from + (to - from) * (1 - Math.pow(1 - k, 3)); el.textContent = v.toFixed(decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ",") + suffix; if (k < 1) requestAnimationFrame(step); }; requestAnimationFrame(step); return el; }
export function showError(el, e) { el.replaceChildren(h("div", { class: "card error" }, `Error: ${e.message}`)); }
