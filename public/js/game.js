// Soul Scribe v5 "game layer": loading screen, screen-wipe page transitions, the living city behind every page,
// HUD hover frames, glare tilt and the leader's spotlight. Pure DOM + CSS transforms; everything stands down
// under prefers-reduced-motion and pauses while the tab is hidden.
import { h } from "/js/app.js";

const RM = matchMedia("(prefers-reduced-motion: reduce)").matches;
const FINE = matchMedia("(hover: hover) and (pointer: fine)").matches;
const root = document.documentElement;
const ss = { get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { sessionStorage.setItem(k, v); } catch {} }, del: (k) => { try { sessionStorage.removeItem(k); } catch {} } };

const TIPS = [
  "Souls per minute is the stat that most often separates wins from losses.",
  "One upload covers all twelve players in a match. Friends cover friends.",
  "MMR here is your rank as a number: 1 is Initiate 1, 66 is Eternus 6.",
  "Open the uploader's status window now and then. It's where updates live.",
  "Hover any item or ability icon for the full in-game tooltip.",
  "KDA counts assists. KD doesn't. Switch the leaderboard to see who carries.",
  "The Draft page ranks picks by your squad's own win rates, not just the meta.",
];

/* ---------------- loading screen (first page of each session) ---------------- */
function boot() {
  if (!root.classList.contains("booting")) return;
  if (RM) { root.classList.remove("booting"); ss.set("ss.booted", "1"); return; }
  const pctEl = h("b", {}, "0"), fill = h("i"), tip = h("p", { class: "tip" }, TIPS[Math.floor(Math.random() * TIPS.length)]);
  const el = h("div", { class: "boot", role: "status", "aria-label": "Loading Soul Scribe" },
    h("div", { class: "b-sky" }), h("div", { class: "b-city" }),
    h("div", { class: "b-core" },
      h("span", { class: "sticker" }, "Now entering"),
      h("img", { class: "b-logo", src: "/img/logo.webp", alt: "Soul Scribe" }),
      h("div", { class: "b-tag" }, "Track", h("i", {}, "✦"), "Build", h("i", {}, "✦"), "Climb"),
      h("div", { class: "b-bar" }, fill, h("span", { class: "ticks" })),
      h("div", { class: "b-meta" }, h("span", {}, "Loading the city"), h("span", {}, pctEl, "%")),
      tip),
    h("button", { class: "b-skip", type: "button" }, "Skip"));
  document.body.append(el);
  const t0 = performance.now(), MIN = 1500, MAX = 3200; let p = 0, ready = false, gone = false;
  const done = () => { ready = true; };
  if (document.readyState === "complete") done(); else addEventListener("load", done, { once: true });
  setTimeout(done, MAX);
  const exit = () => { if (gone) return; gone = true; ss.set("ss.booted", "1"); el.classList.add("out"); root.classList.remove("booting"); root.classList.add("entering"); setTimeout(() => { el.remove(); root.classList.remove("entering"); }, 1100); };
  el.querySelector(".b-skip").onclick = exit; addEventListener("keydown", (e) => e.key === "Escape" && exit(), { once: true });
  (function step() {
    if (gone) return; const t = performance.now() - t0;
    const target = ready && t > MIN ? 100 : Math.min(92, (t / MIN) * 88);
    p += (target - p) * 0.12; if (target === 100 && p > 99.4) p = 100;
    fill.style.transform = `scaleX(${p / 100})`; pctEl.textContent = String(Math.round(p));
    if (p >= 100) return setTimeout(exit, 220);
    requestAnimationFrame(step);
  })();
}

/* ---------------- screen-wipe page transitions ---------------- */
function wipeEl(mode) { return h("div", { class: `wipe ${mode}`, "aria-hidden": "true" }, h("i", { class: "p1" }), h("i", { class: "p2" }), h("i", { class: "p3" }), h("span", { class: "emb" }, h("img", { src: "/img/icon.png", alt: "" }))); }
function wipes() {
  if (RM) return;
  // arriving: the panels that covered the old page slide away
  if (ss.get("ss.wipe") && !root.classList.contains("booting")) { ss.del("ss.wipe"); const w = wipeEl("out"); document.body.append(w); setTimeout(() => w.remove(), 700); }
  else ss.del("ss.wipe");
  addEventListener("pageshow", (e) => { if (e.persisted) document.querySelectorAll(".wipe").forEach((w) => w.remove()); });
  const ok = (a, e) => {
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false;
    if (a.target && a.target !== "_self") return false; if (a.hasAttribute("download") || a.dataset.nowipe != null) return false;
    const u = new URL(a.href, location.href); if (u.origin !== location.origin) return false;
    if (u.pathname.startsWith("/api/") || /\.(exe|zip|png|jpe?g|webp|json)$/i.test(u.pathname)) return false;
    if (u.pathname === location.pathname && u.search === location.search) return false; // same page / hash links
    if (document.querySelector(".wipe.in")) return false; // already leaving
    return u;
  };
  document.addEventListener("click", (e) => {
    const a = e.target.closest?.("a[href]"); const u = ok(a, e); if (!u) return;
    e.preventDefault(); ss.set("ss.wipe", "1"); document.body.append(wipeEl("in"));
    setTimeout(() => (location.href = u.href), 300);
  });
  // warm the next page while the cursor is on its link
  const pre = new Set(); document.addEventListener("pointerover", (e) => { const a = e.target.closest?.("a[href]"); if (!a) return; const u = ok(a, { button: 0 }); if (!u || pre.has(u.pathname)) return; pre.add(u.pathname); document.head.append(h("link", { rel: "prefetch", href: u.pathname })); }, { passive: true });
}

/* ---------------- the living city ---------------- */
function city() {
  const atmo = document.querySelector(".atmo"); if (!atmo || atmo.querySelector(".city")) return;
  const layer = (cls, extra = []) => h("div", { class: `cl ${cls}` }, h("div", { class: "dr" }, ...extra));
  atmo.append(h("div", { class: "city", "aria-hidden": "true" },
    h("div", { class: "moon" }), h("div", { class: "clouds" }), h("div", { class: "lights" }, h("i"), h("i")),
    h("div", { class: "blimp" }),
    layer("far"), layer("mid"), h("div", { class: "haze" }),
    layer("near", [h("div", { class: "win a" }), h("div", { class: "win b" }), h("div", { class: "win c" })]),
    h("div", { class: "fogband" })));
  if (RM) return;
  let raf = 0; const onScroll = () => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; atmo.style.setProperty("--sy", String(Math.min(scrollY, 3000))); }); };
  addEventListener("scroll", onScroll, { passive: true }); onScroll();
  document.addEventListener("visibilitychange", () => root.classList.toggle("paused", document.hidden));
}

/* ---------------- HUD: glare tilt on prints and tiles ---------------- */
function hud() {
  if (RM || !FINE) return;
  const SEL = ".pd,.rec,.hc,.hcard,.tile";
  let cur = null;
  document.addEventListener("pointermove", (e) => {
    const el = e.target.closest?.(SEL); if (cur && cur !== el) reset(cur); cur = el; if (!el) return;
    const r = el.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    const max = el.matches(".pd") ? 7 : 4;
    el.style.setProperty("--rx", `${((0.5 - y) * max).toFixed(2)}deg`); el.style.setProperty("--ry", `${((x - 0.5) * max).toFixed(2)}deg`);
    el.style.setProperty("--gx", `${(x * 100).toFixed(1)}%`); el.style.setProperty("--gy", `${(y * 100).toFixed(1)}%`); el.classList.add("lit");
  }, { passive: true });
  const reset = (el) => { el.classList.remove("lit"); el.style.setProperty("--rx", "0deg"); el.style.setProperty("--ry", "0deg"); };
  document.addEventListener("pointerleave", () => cur && reset(cur));
}

/* ---------------- "Achievement unlocked" banner ---------------- */
const queue = []; let showing = false;
/** Queue a game-style unlock banner. `a` = { icon, name, tier (1-3), how, lane }. */
export function achievementToast(a) { queue.push(a); if (!showing) next(); }
function next() {
  const a = queue.shift(); if (!a) { showing = false; return; } showing = true;
  const el = h("div", { class: `achtoast t${a.tier || 1}`, role: "status" }, h("div", { class: "medal" }, h("span", {}, a.icon || "★")),
    h("div", { class: "tx" }, h("small", {}, a.kicker || "Achievement unlocked"), h("b", {}, a.name, a.tier ? h("em", {}, ["", "I", "II", "III"][a.tier]) : ""), a.how ? h("span", {}, a.how) : ""));
  document.body.append(el); const close = () => { el.classList.add("out"); setTimeout(() => { el.remove(); next(); }, 450); };
  el.addEventListener("click", close); setTimeout(close, RM ? 3500 : 4600);
}

export function start() { city(); boot(); wipes(); hud(); }
