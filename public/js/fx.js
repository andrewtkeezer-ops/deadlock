// Soul Scribe "City Never Sleeps" polish layer: display-title letter effects, section-title plates, magnetic buttons,
// row stagger, rain + neon ambience. Everything degrades to static under prefers-reduced-motion.
import { h } from "/js/app.js";

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const coarse = matchMedia("(hover: none)").matches;

/** Split a heading into per-letter spans (keeps child elements like <small>/<span> intact). */
export function splitTitle(el) {
  if (!el || el.dataset.split) return; el.dataset.split = "1";
  el.setAttribute("aria-label", el.textContent.trim());
  let i = 0;
  const walk = (node) => {
    for (const n of [...node.childNodes]) {
      if (n.nodeType === 3) {
        const frag = document.createDocumentFragment(); const parts = n.textContent.split(/(\s+)/);
        for (const part of parts) { if (!part) continue; if (/^\s+$/.test(part)) { frag.append(" "); continue; } frag.append(h("span", { class: "w", "aria-hidden": "true" }, ...[...part].map((ch) => h("span", { class: "ch", style: `--i:${Math.min(i++, 40)}` }, ch)))); }
        n.replaceWith(frag);
      } else if (n.nodeType === 1 && !n.classList.contains("sticker") && !n.matches("small,.muted,.chip,.tag,img")) walk(n);
    }
  };
  walk(el);
  el.style.setProperty("--n", i);
  if (coarse || reduced) return;
  // hover: ripple a wave outward from the letter under the cursor
  el.addEventListener("pointerenter", (e) => { const chs = [...el.querySelectorAll(".ch")]; if (!chs.length) return; const r = el.getBoundingClientRect(); const from = Math.min(chs.length - 1, Math.max(0, Math.round((e.clientX - r.left) / r.width * chs.length))); chs.forEach((c, k) => { c.style.setProperty("--d", `${Math.abs(k - from) * 28}ms`); c.classList.remove("wave"); void c.offsetWidth; c.classList.add("wave"); }); });
}

/** Orange plate that slides in behind a section title on hover, like the reference's highlighted words. */
function plateTitles() {
  document.querySelectorAll("main h2").forEach((el) => { if (el.dataset.plate) return; el.dataset.plate = "1"; el.classList.add("plated"); });
}

/** Buttons lean toward the cursor and flash a glint on hover. */
function magnetic() {
  if (coarse || reduced) return;
  const SEL = "button.primary,a.dl,.btn.primary,.rail .brand";
  document.addEventListener("pointermove", (e) => { const b = e.target.closest?.(SEL); if (!b) return; const r = b.getBoundingClientRect(); const dx = (e.clientX - (r.left + r.width / 2)) / r.width, dy = (e.clientY - (r.top + r.height / 2)) / r.height; b.style.setProperty("--mx", `${dx * 6}px`); b.style.setProperty("--my", `${dy * 4}px`); b.classList.add("mag"); });
  document.addEventListener("pointerout", (e) => { const b = e.target.closest?.(SEL); if (b && !b.contains(e.relatedTarget)) { b.style.setProperty("--mx", "0px"); b.style.setProperty("--my", "0px"); b.classList.remove("mag"); } });
}

/** Table rows and grid tiles cascade in as they're added. */
function cascade(root) {
  const mark = (els) => els.forEach((el, k) => { if (el.dataset.cas) return; el.dataset.cas = "1"; el.style.setProperty("--k", Math.min(k, 24)); el.classList.add("cas"); });
  root.querySelectorAll?.("tbody").forEach((tb) => mark([...tb.children]));
  root.querySelectorAll?.(".grid,.tiles,.hrows,.order,.ranked,.picker,.recs,.feed,.grid-h,.podium,.hp,.mu").forEach((g) => mark([...g.children]));
  if (root.matches?.("tbody")) mark([...root.children]);
}

/** Rain + neon: a sparse, slow diagonal drizzle and the occasional sign flicker. Cheap canvas, paused when the tab is hidden. */
function weather() {
  if (reduced) return;
  const cv = h("canvas", { class: "rain", "aria-hidden": "true" }); document.body.append(cv); const c = cv.getContext("2d");
  let W, H, drops = [];
  const size = () => { W = cv.width = innerWidth; H = cv.height = innerHeight; drops = Array.from({ length: Math.round(W / 14) }, () => ({ x: Math.random() * W, y: Math.random() * H, l: 14 + Math.random() * 22, v: 2.4 + Math.random() * 2.2, a: .05 + Math.random() * .09 })); };
  size(); addEventListener("resize", size);
  let last = 0, on = true; document.addEventListener("visibilitychange", () => (on = !document.hidden));
  (function tick(t) { requestAnimationFrame(tick); if (!on || t - last < 33) return; last = t; c.clearRect(0, 0, W, H); c.lineWidth = 1; c.lineCap = "round";
    for (const d of drops) { c.strokeStyle = `rgba(214,232,240,${d.a})`; c.beginPath(); c.moveTo(d.x, d.y); c.lineTo(d.x - d.l * .18, d.y + d.l); c.stroke(); d.y += d.v * 2.2; d.x -= d.v * .4; if (d.y > H) { d.y = -d.l; d.x = Math.random() * (W + 80); } } })(0);
  // neon flicker on stickers and the brand mark, at random, rarely
  const flick = () => { const els = document.querySelectorAll(".sticker,.rail .brand img.word"); if (els.length) { const el = els[Math.floor(Math.random() * els.length)]; el.classList.add("flick"); setTimeout(() => el.classList.remove("flick"), 900); } setTimeout(flick, 4000 + Math.random() * 9000); };
  setTimeout(flick, 2500);
}

/** Parallax: the atmosphere drifts opposite the cursor. */
function parallax() {
  if (coarse || reduced) return;
  const atmo = document.querySelector(".atmo"); if (!atmo) return; let tx = 0, ty = 0, x = 0, y = 0;
  addEventListener("pointermove", (e) => { tx = (e.clientX / innerWidth - .5); ty = (e.clientY / innerHeight - .5); }, { passive: true });
  (function loop() { x += (tx - x) * .04; y += (ty - y) * .04; atmo.style.setProperty("--px", `${(-x * 18).toFixed(2)}px`); atmo.style.setProperty("--py", `${(-y * 12).toFixed(2)}px`); requestAnimationFrame(loop); })();
}

export function polish() {
  const main = document.querySelector("main"); if (!main) return;
  main.querySelectorAll("h1").forEach(splitTitle);
  plateTitles(); magnetic(); cascade(main); weather(); parallax();
  new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => { if (n.nodeType !== 1) return; cascade(n); if (n.matches?.("h1")) splitTitle(n); n.querySelectorAll?.("h1").forEach(splitTitle); if (n.matches?.("h2") || n.querySelector?.("h2")) plateTitles(); }))).observe(main, { childList: true, subtree: true });
}
