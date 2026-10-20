// Shared helpers. No framework, no build step.
export const api = async (path, opts = {}) => {
  const res = await fetch(`/api${path}`, { headers: { "content-type": "application/json", ...(opts.headers || {}) }, ...opts,
    body: opts.body && typeof opts.body !== "string" ? JSON.stringify(opts.body) : opts.body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || res.statusText);
  return data;
};
export const $ = (s, el = document) => el.querySelector(s);
// Let replaceChildren/append/prepend take arrays (and skip null/false), same as h() — a bare array otherwise renders as "[object HTMLDivElement]".
for (const m of ["replaceChildren", "append", "prepend"]) { const o = Element.prototype[m]; Element.prototype[m] = function (...a) { return o.apply(this, a.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false)); }; }
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

// ---- pickers ----
/** Hero picker button + popover grid. opts: { heroes, value (id|0), any ("Any hero" label or false), onChange(id) } */
export function heroPicker(opts) {
  const { heroes: hs, any = "Any hero", onChange } = opts; let value = opts.value || 0; let pop = null;
  const btn = h("button", { class: "pk-btn", type: "button" }); const wrap = h("div", { class: "pk" }, btn);
  const paint = () => { const x = hs.find((y) => y.id === value); btn.replaceChildren(x?.images?.icon ? h("img", { src: x.images.icon, alt: "" }) : h("span", { style: "width:24px;height:24px;border-radius:5px;background:rgba(255,255,255,.08);display:inline-block" }), h("span", {}, x ? x.name : any || "Pick a hero"), h("span", { class: "car" }, "▼")); };
  const close = () => { pop?.remove(); pop = null; document.removeEventListener("mousedown", onDoc); };
  const onDoc = (e) => { if (!wrap.contains(e.target)) close(); };
  const open = () => { if (pop) return close(); const q = h("input", { type: "text", placeholder: "Type a hero name…" }); const grid = h("div", { class: "pk-grid" });
    const draw = () => { const f = q.value.toLowerCase(); grid.replaceChildren(any ? h("button", { class: "chipb pk-any" + (value ? "" : " on"), type: "button", onclick: () => pick(0) }, any) : "", ...hs.filter((x) => !f || x.name.toLowerCase().includes(f)).map((x) => h("div", { class: "pk-h" + (x.id === value ? " on" : ""), title: x.name, onclick: () => pick(x.id) }, h("img", { src: x.images?.card || x.images?.icon, alt: x.name, loading: "lazy" }), h("span", {}, x.name)))); };
    q.oninput = draw; q.onkeydown = (e) => { if (e.key === "Escape") close(); if (e.key === "Enter") { const first = hs.find((x) => x.name.toLowerCase().includes(q.value.toLowerCase())); if (first) pick(first.id); } };
    pop = h("div", { class: "pk-pop" }, q, grid); wrap.append(pop); draw(); q.focus(); document.addEventListener("mousedown", onDoc); };
  const pick = (id) => { value = id; paint(); close(); onChange?.(id); };
  btn.onclick = open; paint(); wrap.value = () => value; wrap.set = (id) => { value = id; paint(); }; return wrap;
}
/** Search input with suggestions. opts: { placeholder, suggest(q) → [{label, icon?, kind, onPick}], onInput(q) } */
export function suggestInput(opts) {
  const input = h("input", { type: "text", placeholder: opts.placeholder || "Search…", autocomplete: "off" }); const wrap = h("div", { class: "sg" }, h("span", { class: "ico" }, "⌕"), input); let list = null, idx = -1, rows = [];
  const close = () => { list?.remove(); list = null; idx = -1; };
  const draw = () => { const q = input.value.trim(); rows = q ? (opts.suggest(q) || []).slice(0, 12) : []; close(); if (!rows.length) return;
    list = h("div", { class: "sg-list" }, ...rows.map((r, i) => h("div", { class: "sg-row" + (i === idx ? " on" : ""), onmousedown: (e) => { e.preventDefault(); r.onPick(); close(); } }, r.icon ? h("img", { src: r.icon, alt: "" }) : h("span", { style: "width:26px" }), h("span", {}, r.label), h("span", { class: "k " + (r.kind === "stat" ? "stat" : "") }, r.kind)))); wrap.append(list); };
  input.oninput = () => { opts.onInput?.(input.value); draw(); };
  input.onkeydown = (e) => { if (!list) return; if (e.key === "ArrowDown") { idx = Math.min(rows.length - 1, idx + 1); draw(); e.preventDefault(); } else if (e.key === "ArrowUp") { idx = Math.max(0, idx - 1); draw(); e.preventDefault(); } else if (e.key === "Enter" && idx >= 0) { rows[idx].onPick(); close(); e.preventDefault(); } else if (e.key === "Escape") close(); };
  input.onblur = () => setTimeout(close, 120); input.onfocus = draw;
  wrap.input = input; wrap.value = () => input.value; wrap.set = (v) => { input.value = v; opts.onInput?.(v); }; return wrap;
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
  out: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 17l5-5-5-5M15 12H3"/><path d="M12 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-6"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z"/><path d="M9 12l2 2 4-4"/></svg>',
};
export function shell(active) {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!document.querySelector(".atmo")) {
    document.body.prepend(h("div", { class: "atmo" }, h("div", { class: "base" }), h("div", { class: "beams" }, h("i", { class: "main" }), h("i", { class: "trail" })), h("div", { class: "fog" }), h("div", { class: "grain" }), h("div", { class: "mark" }), h("div", { class: "vig" })));
    const page = h("div", { class: "page" }); const mains = [...document.body.querySelectorAll(":scope > main")]; mains.forEach((m) => { if (active !== "/heroes.html") m.classList.add("stagger"); page.append(m); }); document.body.append(page);
  }
  const links = [["/", "Leaderboard", "trophy"], ["/heroes.html", "Heroes", "hero"], ["/counters.html", "Draft", "swords"], ["/heatmap.html", "Map", "map"], ["/library.html", "Builds", "book"], ["/items.html", "Items", "bag"], ["/setup.html", "Setup", "gear"]];
  let ix = 0;
  const mk = ([href, label, ic]) => { const a = h("a", { href, class: href === active ? "active" : "" }); a.innerHTML = `<span class="ix">${String(++ix).padStart(2, "0")}</span><span class="ic">${ICONS[ic]}</span><span class="lb">${label}</span>`; return a; };
  const pill = h("span", { class: "pill" });
  const nav = h("nav", {}, pill, ...links.map(mk));
  const who = h("div", { class: "who" });
  const rail = h("aside", { class: "rail" }, h("a", { class: "brand", href: "/", title: "Soul Scribe" }, h("img", { class: "mark", src: "/img/icon.png", alt: "" }), h("img", { class: "word", src: "/img/logo.webp", alt: "Soul Scribe" })), nav, who);
  document.body.prepend(rail);
  pageHeader();
  // sliding active pill + hover preview + click ripple
  function movePill(target) { const a = target || nav.querySelector("a.active"); if (!a) { pill.style.opacity = 0; return; } pill.style.top = a.offsetTop + "px"; pill.style.opacity = 1; }
  requestAnimationFrame(() => movePill());
  nav.addEventListener("mouseover", (e) => { const a = e.target.closest("a"); if (a) movePill(a); }); nav.addEventListener("mouseleave", () => movePill());
  nav.addEventListener("click", (e) => { const a = e.target.closest("a"); if (!a || reduced) return; const r = a.getBoundingClientRect(), s = Math.max(r.width, r.height); a.append(h("span", { class: "rp", style: `width:${s}px;height:${s}px;left:${e.clientX - r.left - s / 2}px;top:${e.clientY - r.top - s / 2}px` })); });
  me().then(async (m) => {
    if (m.role === "admin") { nav.append(mk(["/admin.html", "Admin", "shield"])); movePill(); }
    if (m.account_id) {
      let p = null; try { p = (await api("/players")).find((x) => x.account_id === m.account_id); } catch {}
      const a = h("a", { href: `/player.html?id=${m.account_id}` }, p?.avatar_url ? h("img", { class: "av", src: p.avatar_url, alt: "" }) : h("span", { class: "av" }), h("span", { class: "nm" }, p?.name ?? "My profile", h("small", {}, "View profile")));
      who.append(a); if (p?.mmr_rank) try { const b = await rankBadge(p.mmr_rank); b.style.height = "26px"; a.querySelector("small").replaceChildren(b, " ", p.mmr_score != null ? String(Math.round(p.mmr_score)) : ""); } catch {}
    } else {
      // Signed in through the Google door (Cloudflare Access) but no Steam account linked yet: show who they are + a link to connect Steam.
      if (m.email || m.signed_in) who.append(h("a", { href: "/setup.html", title: "Connect your Steam account" }, h("span", { class: "av gg" }, "G"), h("span", { class: "nm" }, m.email ?? "Signed in with Google", h("small", {}, m.role === "admin" ? "Admin · connect Steam" : "Connect Steam"))));
      else who.append(h("a", { href: "/api/auth/steam/login", title: "Sign in through Steam" }, h("img", { class: "steam", src: "https://community.cloudflare.steamstatic.com/public/images/signinthroughsteam/sits_small.png", alt: "Sign in through Steam" })));
    }
    if (m.account_id || m.email || m.signed_in) { const out = h("a", { class: "out", href: "/api/auth/google/logout", title: "Sign out" }); out.innerHTML = `<span class="ic">${ICONS.out}</span><span class="lb">Sign out</span>`; who.after(out); }
  }).catch(() => {});
  if (!reduced) alive();
}

/** Eyebrow sticker above the page title, in the Deadlock site's postcard voice. Pages with their own hero header (hero.html) opt out with data-ph="off". */
const EYEBROWS = { "/": "The squad standings", "/index.html": "The squad standings", "/heroes.html": "Meet the locals", "/counters.html": "Know your enemy", "/heatmap.html": "Where it happens", "/library.html": "The playbook", "/items.html": "The corner shop", "/setup.html": "Get connected", "/admin.html": "Back office", "/player.html": "Squad member", "/match.html": "Match report", "/editor.html": "Build editor", "/builds.html": "Build wizard" };
function pageHeader() {
  const main = document.querySelector("main"); if (!main || main.dataset.ph === "off") return;
  const eyebrow = main.dataset.eyebrow || EYEBROWS[location.pathname]; if (!eyebrow) return;
  const h1 = main.querySelector("h1"); if (!h1 || h1.closest(".ph")) return;
  const wrap = h("div", { class: "ph" }, h("span", { class: "sticker" }, eyebrow));
  h1.replaceWith(wrap); wrap.append(h1);
}

/** Site-wide "alive" layer: pointer spotlight + tilt on glass, scroll reveals, loading shimmer, cursor halo. (Searchlight beams are pure CSS in .atmo.) */
function alive() {
  const fine = matchMedia("(hover:hover) and (pointer:fine)").matches;
  const SURF = ".card,.sec,.ab,.st,.tile,.hcard", TILT = ".ab,.st,.tile";
  if (fine) {
    const halo = h("div", { class: "halo" }); document.body.append(halo);
    let hx = innerWidth / 2, hy = innerHeight / 2, tx = hx, ty = hy;
    document.addEventListener("pointermove", (e) => {
      tx = e.clientX; ty = e.clientY;
      const s = e.target.closest?.(SURF); if (s) { const r = s.getBoundingClientRect(); s.style.setProperty("--mx", `${e.clientX - r.left}px`); s.style.setProperty("--my", `${e.clientY - r.top}px`);
        if (s.matches(TILT)) { s.classList.add("tilt", "on"); const dx = (e.clientX - r.left) / r.width - .5, dy = (e.clientY - r.top) / r.height - .5; s.style.transform = `perspective(900px) rotateX(${(-dy * 6).toFixed(2)}deg) rotateY(${(dx * 8).toFixed(2)}deg) translateY(-3px)`; } }
    }, { passive: true });
    document.addEventListener("pointerout", (e) => { const s = e.target.closest?.(TILT); if (s && !s.contains(e.relatedTarget)) { s.classList.remove("on"); s.style.transform = ""; } }, { passive: true });
    (function loop() { hx += (tx - hx) * .12; hy += (ty - hy) * .12; halo.style.transform = `translate3d(${hx}px,${hy}px,0)`; requestAnimationFrame(loop); })();
  }
  // scroll reveal for nested cards (top-level sections already stagger in)
  const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }), { rootMargin: "0px 0px -8% 0px", threshold: .08 });
  const watch = (root) => root.querySelectorAll?.(".ab,.st,.tile,.hcard,.card .card").forEach((el, i) => { if (el.classList.contains("rv")) return; el.classList.add("rv"); el.style.transitionDelay = `${Math.min(i, 8) * 45}ms`; io.observe(el); });
  const shimmer = (root) => root.querySelectorAll?.("*").forEach((el) => { if (el.childElementCount === 0 && el.textContent.trim() === "Loading…") el.classList.add("ld"); });
  const mo = new MutationObserver((ms) => ms.forEach((m) => { m.addedNodes.forEach((n) => { if (n.nodeType === 1) { watch(n); shimmer(n); if (n.classList?.contains("ld")) n.classList.remove("ld"); } }); if (m.type === "childList" && m.target.classList?.contains("ld") && m.target.textContent.trim() !== "Loading…") m.target.classList.remove("ld"); }));
  const page = document.querySelector(".page"); watch(page); shimmer(page); mo.observe(page, { childList: true, subtree: true });
  document.body.append(h("div", { class: "progress" }));
  // numbers tick up the first time they appear (stat tiles, podium, hero header)
  const NUMS = ".tile b:not(.kda b),.stat b,.pd .kv b:not(.kda b),.kv b:not(.kda b),.tile .ratio";
  const seen = new WeakSet();
  const nio = new IntersectionObserver((es) => es.forEach((e) => { if (!e.isIntersecting) return; nio.unobserve(e.target); tick(e.target); }), { threshold: .4 });
  function tick(el) { if (seen.has(el)) return; seen.add(el); const m = /^([\d,]*\.?\d+)(%?)$/.exec(el.textContent.trim()); if (!m) return; const to = parseFloat(m[1].replace(/,/g, "")); const dec = (m[1].split(".")[1] || "").length; countUp(el, to, { decimals: dec, suffix: m[2], ms: 900 }); }
  const watchNums = (root) => root.querySelectorAll?.(NUMS).forEach((el) => nio.observe(el));
  watchNums(page); new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => { if (n.nodeType === 1) { if (n.matches?.(NUMS)) nio.observe(n); watchNums(n); } }))).observe(page, { childList: true, subtree: true });
}
/** K / D / A readout: coloured triple over a proportional bar. */
export const kdOf = (k, d) => k / Math.max(1, d);
export const kdaOf = (k, d, a) => (k + a) / Math.max(1, d);
export function kda(k, d, a, { dec = 0, bar = true, size = "" } = {}) {
  const t = Math.max(1, k + d + a), f = (n) => (dec ? n.toFixed(dec) : String(Math.round(n)));
  return h("span", { class: "kda" + (size ? " " + size : "") }, h("span", { class: "t" }, h("b", { class: "k" }, f(k)), h("i", { class: "s" }, "/"), h("b", { class: "d" }, f(d)), h("i", { class: "s" }, "/"), h("b", { class: "a" }, f(a))),
    bar ? h("span", { class: "b" }, h("i", { class: "k", style: `width:${k / t * 100}%` }), h("i", { class: "d", style: `width:${d / t * 100}%` }), h("i", { class: "a", style: `width:${a / t * 100}%` })) : "");
}
/** Coloured ratio (KD, KDA): green when good, cream when even, red when behind. */
export function ratio(v, { good = 1.5, even = 1, dec = 2 } = {}) { const cls = v == null ? "" : v >= good ? "g" : v >= even ? "m" : "p"; return h("b", { class: "ratio " + cls }, v == null ? "–" : v.toFixed(dec)); }
export const KD = { good: 1.5, even: 1 }, KDA = { good: 3, even: 2 };
/** Count-up animation for a number element. */
export function countUp(el, to, { decimals = 0, suffix = "", ms = 700 } = {}) { const start = performance.now(); const from = 0; const step = (t) => { const k = Math.min(1, (t - start) / ms); const v = from + (to - from) * (1 - Math.pow(1 - k, 3)); el.textContent = v.toFixed(decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ",") + suffix; if (k < 1) requestAnimationFrame(step); }; requestAnimationFrame(step); return el; }
export function showError(el, e) { el.replaceChildren(h("div", { class: "card error" }, `Error: ${e.message}`)); }
