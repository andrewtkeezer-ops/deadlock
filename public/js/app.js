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
  for (const [k, v] of Object.entries(attrs)) k === "class" ? (el.className = v) : k.startsWith("on") ? el.addEventListener(k.slice(2), v) : el.setAttribute(k, v);
  for (const k of kids.flat()) el.append(k instanceof Node ? k : document.createTextNode(k ?? ""));
  return el;
};
export const pct = (x) => (x == null ? "–" : (x * 100).toFixed(1) + "%");
export const ago = (ts) => { if (!ts) return "never"; const s = Date.now() / 1000 - ts; return s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`; };
export const dur = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

let heroCache;
export async function heroes() { return (heroCache ??= await api("/heroes")); }
export async function heroName(id) { return (await heroes()).find((h) => h.id === id)?.name ?? `#${id}`; }

export function shell(active) {
  const links = [["/", "Leaderboard"], ["/heroes.html", "Heroes"], ["/counters.html", "Counters"], ["/heatmap.html", "Heatmap"], ["/builds.html", "Build wizard"], ["/setup.html", "Setup"], ["/admin.html", "Admin"]];
  document.body.prepend(h("header", {}, h("span", { class: "brand" }, "DEADLOCK SQUAD"),
    h("nav", {}, ...links.map(([href, label]) => h("a", { href, class: href === active ? "active" : "" }, label))),
    h("span", { id: "whoami", class: "muted", style: "margin-left:auto;font-size:13px" })));
  api("/auth/steam/me").then((m) => { if (m.account_id && active !== "/setup.html") $("#whoami").prepend(h("a", { href: `/player.html?id=${m.account_id}`, style: "margin-right:12px" }, "My profile")); }).catch(() => {});
  api("/me").then((me) => { const el = $("#whoami"); if (!me.unconfigured) el.textContent = me.email; if (me.role !== "admin") $('a[href="/admin.html"]')?.remove(); }).catch(() => {});
}
export function showError(el, e) { el.replaceChildren(h("div", { class: "card error" }, `Error: ${e.message}`)); }
