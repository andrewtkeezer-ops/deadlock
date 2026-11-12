// "Iris" page change (v6.2). Classic script in <head> so it runs before the first paint; keep it tiny.
// Leaving: the page closes down to the spot you clicked, like a film iris. Arriving: the next page opens out of that same spot
// once its frame is built (app.js calls window.__vtReady from shell()). The look lives in app.css under "v6.2".
(function () {
  var d = document.documentElement, KEY = "ss.vt", OUT_MS = 230;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  var place = function (x, y) {
    var r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)) + 260; // reach the farthest corner, plus the soft edge
    d.style.setProperty("--vx", Math.round(x) + "px"); d.style.setProperty("--vy", Math.round(y) + "px"); d.style.setProperty("--vr", Math.round(r) + "px");
  };
  var clear = function () { d.classList.remove("vt-hold", "vt-open", "vt-close"); };

  // ---- arriving ----
  try {
    var p = JSON.parse(sessionStorage.getItem(KEY) || "null"); sessionStorage.removeItem(KEY);
    if (p && Date.now() - p.t < 6000 && !d.classList.contains("booting")) {
      place(p.x * innerWidth, p.y * innerHeight); d.classList.add("vt-hold");
      var opened = false, open = function () { if (opened) return; opened = true; d.classList.remove("vt-hold"); d.classList.add("vt-open"); setTimeout(clear, 900); };
      window.__vtReady = function () { requestAnimationFrame(function () { requestAnimationFrame(open); }); };
      setTimeout(open, 1200); // never leave a page closed if its frame didn't build
    }
  } catch (e) {}
  addEventListener("pageshow", function (e) { if (e.persisted) clear(); }); // back button restoring a closed page

  // ---- leaving ----
  addEventListener("click", function (e) {
    try {
      if (e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var a = e.target.closest && e.target.closest("a[href]"); if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
      var u = new URL(a.href, location.href); if (u.origin !== location.origin) return;
      if (u.pathname.indexOf("/api/") === 0 || /\.(exe|zip|png|jpe?g|webp|json)$/i.test(u.pathname)) return;
      if (u.pathname === location.pathname && u.search === location.search) return; // same page / hash links
      if (d.classList.contains("vt-close")) { e.preventDefault(); return; }       // already leaving
      var x = e.clientX, y = e.clientY; if (!x && !y) { x = innerWidth * 0.5; y = innerHeight * 0.42; } // keyboard, quick search
      e.preventDefault(); clear(); place(x, y); d.classList.add("vt-close");
      sessionStorage.setItem(KEY, JSON.stringify({ x: x / innerWidth, y: y / innerHeight, t: Date.now() }));
      setTimeout(function () { location.href = u.href; }, OUT_MS);
    } catch (err) {}
  });
})();
