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
/** Attach a hover tooltip to any element for an item. */
export function withTip(el, it) {
  if (!it) return el;
  el.addEventListener("mouseenter", (e) => { tipEl?.remove(); tipEl = itemTooltip(it); tipEl.style.position = "fixed"; document.body.append(tipEl); place(e); });
  el.addEventListener("mousemove", place); el.addEventListener("mouseleave", () => { tipEl?.remove(); tipEl = null; });
  function place(e) { if (!tipEl) return; const w = tipEl.offsetWidth, hgt = tipEl.offsetHeight; let x = e.clientX + 16, y = e.clientY + 16; if (x + w > innerWidth - 8) x = e.clientX - w - 16; if (y + hgt > innerHeight - 8) y = innerHeight - hgt - 8; tipEl.style.left = x + "px"; tipEl.style.top = y + "px"; }
  return el;
}

// ---- page chrome ----
export function shell(active) {
  const links = [["/", "Leaderboard"], ["/heroes.html", "Heroes"], ["/counters.html", "Counters"], ["/heatmap.html", "Heatmap"], ["/library.html", "Builds"], ["/items.html", "Items"], ["/setup.html", "Setup"]];
  const nav = h("nav", {}, ...links.map(([href, label]) => h("a", { href, class: href === active ? "active" : "" }, label)));
  const right = h("div", { class: "who", id: "whoami" });
  document.body.prepend(h("header", {}, h("a", { class: "brand", href: "/" }, h("img", { src: "/img/logo.webp", alt: "Soul Scribe", class: "logo" })), nav, right));
  me().then(async (m) => {
    if (m.role === "admin") nav.append(h("a", { href: "/admin.html", class: active === "/admin.html" ? "active" : "" }, "Admin"));
    if (m.account_id) {
      let p = null; try { p = (await api("/players")).find((x) => x.account_id === m.account_id); } catch {}
      right.append(h("a", { href: `/player.html?id=${m.account_id}`, class: "meLink" }, p?.avatar_url ? h("img", { src: p.avatar_url, alt: "" }) : "", p?.name ?? "My profile"));
    } else right.append(h("a", { href: "/api/auth/steam/login" }, h("img", { src: "https://community.cloudflare.steamstatic.com/public/images/signinthroughsteam/sits_small.png", alt: "Sign in through Steam", style: "height:22px;vertical-align:middle" })));
  }).catch(() => {});
}
export function showError(el, e) { el.replaceChildren(h("div", { class: "card error" }, `Error: ${e.message}`)); }
