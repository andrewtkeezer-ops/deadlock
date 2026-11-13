// Guided tour (steps last brought up to date 2026-11-12, v8): a "Take a tour" button on each page (never automatic). Steps spotlight real elements and explain
// what they're for. Steps whose element isn't on the page (or is hidden) are skipped.
import { h, pageKey } from "/js/app.js";

const RAIL = ".rail nav";
const TOURS = {
  "/": [
    [RAIL, "The rail", "Everything lives here: standings, the squad page, heroes, the draft helper, the map, builds, the shop, patches and setup. The highlighted entry is where you are."],
    [".rail-find", "Search", "Jump straight to any hero, player, item or page. Ctrl K (or ⌘ K), or just press / from anywhere."],
    ["#sortSeg", "Sort", "Standings by MMR, KDA or KD. You can also click most column headers in the table to sort by that column."],
    ["#days", "Window", "Every number on this page is for this time window. Switch to 7 days to see who's hot this week, or all time for the long game."],
    ["#wire", "The wire", "The squad's latest results scroll past here. Hover to pause it; click a name to open their profile."],
    ["#podium", "The podium", "Top three by the current sort. Click a card for the full profile."],
    ["#out", "Standings", "Click a row to open that player. K / D / A is colour-coded (cream kills, red deaths, blue assists) with a bar showing the mix. Your own row is tagged You. Street Brawl games never count here."],
    ["#duos", "Duos", "Who wins together. Two tracked friends on the same team in the same match count as a duo."],
    ["#recent", "Recent games", "The squad's newest matches. Click a row, or its Scoreboard button, for the full 12-player breakdown. A Brawl tag marks Street Brawl games."],
  ],
  "/heroes.html": [
    ["#hfind", "Find a hero", "Type to narrow the roster; Enter opens the first match. Press / to jump here."],
    ["#filters", "Filters", "Narrow the roster by role, and pick a rank band to see how a hero performs at your level rather than overall."],
    ["#grid", "The roster", "Every hero, same as the in-game select screen. Hover to preview, click to lock, double-click or Enter to open (tap twice on a phone). Arrow keys walk the grid."],
    ["#stage", "The stage", "Win rate, pick rate, complexity and abilities for the hero you're previewing. The buttons jump to builds, matchups and the map for that hero."],
    ["#metaBtn", "Meta table", "The whole roster as a sortable table: win rate, pick rate and sample size at a glance."],
  ],
  "/hero.html": [
    ["#head", "Hero header", "The hero's role and headline numbers for the last 14 days."],
    ["#hstep", "Previous and next", "Step through the roster alphabetically. The [ and ] keys do the same."],
    ["#secnav", "Sections", "This bar follows you down the page and jumps to any section."],
    ["#abilities", "Abilities", "The four abilities with their upgrade tiers; the same tooltip appears on ability icons across the site."],
    ["#skillorder", "Skill order", "How players put their ability points in, the most common order and the one that wins most."],
    ["#squad", "Your squad", "How the squad does on this hero, and the builds squad members have saved for it."],
    ["#buildpath", "Build path", "The items that win in each phase of the game, by win rate or by how often they're bought."],
    ["#lanep", "Laning", "The lane partners this hero does best with, and the enemy duos that leave it furthest behind."],
    ["#counters", "Matchups", "Who this hero struggles against and the teammates it pairs best with."],
    ["#starters", "Starter builds", "The strongest community builds by lean (gun, spirit, survivability). Add one to your builds and tune it."],
  ],
  "/counters.html": [
    ["#allySlots", "Your team", "Add the heroes already locked on your side. The ringed team is the one you're filling; click a slot or the buttons below to switch."],
    ["#enemySlots", "Enemy team", "Same for the enemy locks. The more you fill in, the better the suggestions."],
    ["#picker", "Roster", "Click a hero to add them to the ringed side, or type in the filter and press Enter. Greyed heroes are already picked."],
    ["#out", "Suggestions", "Every remaining hero scored by synergy with your allies and win rate against their picks, with a one-line 'why'. A ★ means you personally win a lot on that hero; your own record nudges the ranking."],
    ["#shareDraft", "Share it", "The line-up lives in the address bar, so Copy link gives the squad the same draft."],
  ],
  "/heatmap.html": [
    ["#mapwrap", "The map", "Where kills and deaths actually happen. Red is deaths, green is kills; 'Net' shows who wins each patch of the map. The default view opens instantly from a copy refreshed every hour."],
    ["#hp", "Hero filter", "Pick a hero to see only their deaths and kills. Filtered views are counted on demand and take 5 to 15 seconds the first time."],
    [".side .card:nth-of-type(2)", "Filters", "Window (up to 14 days: longer than that is more than the data source can count in time), squad-only and game phase all change the picture a lot."],
  ],
  "/library.html": [
    ["#tabMine", "My builds / Squad builds", "Your saved builds, or everything the squad has shared. Builds are shared by default; that's the point."],
    ["#hgrid", "Pick a hero", "The number on a tile is how many builds exist for that hero. Click through to see yours, the squad's and the best community builds."],
    ["#list", "Build list", "Open a build to view it; fork it to make your own copy. Only the author can edit the original."],
  ],
  "/editor.html": [
    ["#title", "Name and hero", "Give it a name people will recognise in the squad library and in your in-game build menu."],
    ["#syncRow", "Send to the game", "Flip this and your uploader publishes the build into Deadlock's build menu the next time it runs with the game closed."],
    ["#coachCard", "Coach", "When you'll afford each phase at your own farm rate, slot limits, what to buy first, and whether the late phases are realistic."],
    ["#dpsCard", "Damage calculator", "Raw gun numbers for everything in the build: sustained and burst DPS, falloff at range, clip, reload, time to kill. Drag the sliders."],
    ["#tidy", "Tidy tools", "Rename phases to the standard Lane / Early / Mid / Late, sort by tier, clear removed items, add or remove a phase."],
    ["#phases", "Phases", "Click a phase to target it, then click items on the right to add them. Drag items between phases. A '↻ sell' badge marks a lane item worth swapping later; click it for replacements."],
    ["#items", "Shop", "Search by name or by what an item gives you (the chips), hover for tooltips, click to add to the targeted phase."],
  ],
  "/builds.html": [
    ["#pri", "Priorities", "Tell the wizard what you care about: weapon damage, spirit, ammo, range, survivability. Presets fill common shapes."],
    ["#budget", "Budget and trust", "How many souls to plan for, and how much to weight real win-rate data against raw stats."],
    ["#go", "Build it", "You get a purchase order within budget, the gun numbers it produces, and a one-click way to open it in the editor."],
  ],
  "/items.html": [
    ["#qwrap", "Search", "Type an item name or a stat ('spirit', 'fire rate'); suggestions appear as you type."],
    ["#chips", "Stat chips", "Combine chips to filter by what items give you. The bar under each item shows how much."],
    ["#shop", "The shop", "Laid out like the in-game shop: weapon, vitality, spirit, by tier. Hover for the tooltip; click an item for its full details."],
  ],
  "/player.html": [
    ["#head", "Profile", "Rank, MMR and when the matches were last synced."],
    ["#modebar", "Game mode", "Street Brawl games are kept apart from everything else. Switch here to see them on their own."],
    ["#tiles", "Headline stats", "Recent games, win rate, KD, KDA, average K / D / A, souls per minute and current streak."],
    ["#ptabbar", "Sections", "Overview, Matches, Progress (trends and how you compare at your rank), Game flow (soul curve and the lane report), Achievements and Builds. Swipe between them on a phone."],
    ["#rrCard", "Road to Ranked", "Hero points toward placement matches: a hero is ready at 35 points (2 for a win, 1 for a loss) and three ready heroes open placements. An estimate from the games stored here."],
    ["#recs", "Records", "Best games on record: most kills, best KDA, richest game, fastest farm, best hero, streaks."],
  ],
  "/match.html": [
    ["#squadline", "The squad", "Who from the squad was in this game and how it went. Click a name for their profile."],
    ["#story", "Match story", "The handful of facts that explain the game: First Blood, biggest lead, lead changes, top damage, longest streak, Rejuvenator claims and who was ahead in each lane."],
    ["#lead", "Soul lead", "Team net-worth difference over the match. Move over it, the timeline, the player graph or the kill map and the same moment is marked on all four."],
    ["#feed", "Timeline", "Every kill and objective in order, with First Blood tagged."],
    ["#pg", "Player graph", "Souls, hero damage or damage taken over time for the players you pick below it."],
    ["#km", "Kill map", "Where every death happened, in the dead hero's team colour, with a line back to the killer."],
    ["#teams", "Scoreboards", "Click any player row for their item timeline, accuracy, headshot rate, damage by gun, ability and melee, and where their souls came from."],
    ["#matrix", "Who hit whom", "Hero-vs-hero damage dealt. Rows deal to columns; darker means more."],
  ],
  "/squad.html": [
    ["#tabs", "Two views", "The weekly recap and the all-time records wall."],
    ["#wknav", "Pick a week", "Step back through earlier weeks, or look at the week in progress. Weeks run Monday to Monday."],
    ["#recap", "The week", "Squad totals against the week before, the awards (three games needed to qualify), the week's table and the most played heroes. Award cards with a game behind them open that match."],
    ["#records", "Records wall", "Single-game and career bests, top three each, one entry per player. Click a record to open the match it was set in."],
  ],
  "/patches.html": [
    ["#pfilter", "Filter", "Everything in the notes, or only the heroes your squad plays."],
    ["#out", "Patches", "Every balance change matched to heroes and items. 'Hits the squad' names who is affected; 'Impact so far' shows the squad's record and everyone's win rate before and after the patch."],
    ["#news", "Other news", "Posts without balance changes: events, seasons, announcements."],
  ],
  "/setup.html": [
    ["#s1", "Steam", "Sign in through Steam once so the site knows which player you are. It remembers across devices."],
    ["#s2", "Uploader", "The Soul Scribe uploader sends your matches to deadlock-api.com as you play and publishes your builds into the game. This step tells you honestly whether it's working."],
    ["#s3", "Your profile", "Once matches flow in, this links to your page."],
  ],
  "/admin.html": [
    ["#players", "Tracked players", "Everyone whose matches are synced. 'Sync everyone now' pulls fresh data immediately instead of waiting for the 10-minute poll."],
    ["#usage", "Usage", "Where you stand against the free tiers. Nothing here costs money; hitting a cap just pauses that thing for the day."],
    ["#dcUrl", "Discord", "Paste a channel webhook and new matches and rank changes post there automatically."],
    ["#email", "Invites", "Add a friend's Gmail to put them on the list, then share the invite link; they sign in with Google and they're in."],
  ],
};

const visible = (el) => el && el.offsetParent !== null && el.getBoundingClientRect().height > 0;

export function tourAvailable() { return !!TOURS[pageKey()]; }

export function startTour() {
  const steps = (TOURS[pageKey()] || []).map(([sel, title, body]) => ({ el: document.querySelector(sel), title, body })).filter((s) => visible(s.el));
  if (!steps.length) return;
  let i = 0; const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const spot = h("div", { class: "tour-spot" }); const card = h("div", { class: "tour-card", role: "dialog", "aria-live": "polite" }); const dim = h("div", { class: "tour-dim" }, spot, card);
  document.body.append(dim); document.documentElement.classList.add("touring");
  const end = () => { dim.remove(); document.documentElement.classList.remove("touring"); document.removeEventListener("keydown", onKey); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  const onKey = (e) => { if (e.key === "Escape") end(); else if (e.key === "ArrowRight" || e.key === "Enter") go(1); else if (e.key === "ArrowLeft") go(-1); };
  document.addEventListener("keydown", onKey); window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
  dim.addEventListener("mousedown", (e) => { if (e.target === dim) end(); });
  function place() { const s = steps[i]; if (!s) return; const r = s.el.getBoundingClientRect(); const pad = 8;
    spot.style.left = (r.left - pad) + "px"; spot.style.top = (r.top - pad) + "px"; spot.style.width = (r.width + pad * 2) + "px"; spot.style.height = (r.height + pad * 2) + "px";
    const cw = Math.min(360, innerWidth - 24), ch = card.offsetHeight || 160; let x = r.left, y = r.bottom + pad + 12;
    if (y + ch > innerHeight - 12) y = r.top - pad - 12 - ch; if (y < 12) { y = Math.max(12, Math.min(innerHeight - ch - 12, r.top)); x = r.right + 16; if (x + cw > innerWidth - 12) x = r.left - cw - 16; }
    x = Math.max(12, Math.min(x, innerWidth - cw - 12)); card.style.left = x + "px"; card.style.top = y + "px"; card.style.width = cw + "px"; }
  function render() { const s = steps[i];
    card.replaceChildren(h("div", { class: "k" }, `${i + 1} / ${steps.length}`), h("h3", {}, s.title), h("p", {}, s.body),
      h("div", { class: "row" }, h("button", { onclick: end }, "Skip"), h("span", { style: "flex:1" }), i > 0 ? h("button", { onclick: () => go(-1) }, "← Back") : "", h("button", { class: "primary", onclick: () => go(1) }, i === steps.length - 1 ? "Done ✓" : "Next →")));
    s.el.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
    setTimeout(place, reduced ? 0 : 320); place(); }
  function go(d) { i += d; if (i < 0) i = 0; if (i >= steps.length) return end(); render(); }
  render();
}

/** The on-brand "Take a tour" button, for pages that have one. Returns null elsewhere. */
export function tourButton() {
  if (!tourAvailable()) return null;
  return h("button", { class: "tour-btn", type: "button", onclick: startTour, title: "A quick lay of the land for this page" }, h("span", { class: "ic" }, "✦"), "Take a tour");
}
