import type { Env } from "./types";

/**
 * Thin client for api.deadlock-api.com with:
 *  - KV caching (so 10 friends refreshing pages never hits the upstream twice for the same query)
 *  - Retry-After handling: the API load-sheds with 503 when busy; we honour it instead of hammering
 *  - optional API key (free; doubles the per-key limit to 400 req/min and gives queue priority)
 *
 * Rate limits (from the OpenAPI description): 200/min per IP, 400/min per key, 2000/min global.
 * Our Worker is a single caller, so the only real risk is uncached parallel bursts — hence cache first.
 */
/**
 * Response cache on Cloudflare's Cache API instead of KV: KV's free tier allows only 1,000 writes/day account-wide
 * and every cache miss cost two. The Cache API has no operation limits (it is per data centre, which is fine for a
 * friend group in one region). Keys are synthetic URLs on an internal host.
 */
const CACHE_HOST = "https://cache.soulscribe.internal/";
async function cacheGet<T>(key: string): Promise<T | null> {
  try { const res = await caches.default.match(new Request(CACHE_HOST + encodeURIComponent(key))); return res ? ((await res.json()) as T) : null; } catch { return null; }
}
async function cachePut(key: string, body: string, ttl: number): Promise<void> {
  try { await caches.default.put(new Request(CACHE_HOST + encodeURIComponent(key)), new Response(body, { headers: { "content-type": "application/json", "cache-control": `public, max-age=${Math.max(60, ttl)}` } })); } catch { /* cache is best-effort */ }
}

export class DeadlockApi {
  constructor(private env: Env) {}

  private headers(): HeadersInit {
    const h: Record<string, string> = { accept: "application/json", "user-agent": "deadlock-squad/0.1 (cloudflare worker)" };
    if (this.env.DEADLOCK_API_KEY) h["X-API-Key"] = this.env.DEADLOCK_API_KEY;
    return h;
  }

  /**
   * GET with KV cache. ttl in seconds.
   * - `*_unix_timestamp` filters are rounded down to the hour so "last 14 days" is the same cache key for an hour.
   * - A stale copy is kept for 7 days and served when upstream is busy (503/429), instead of waiting on Retry-After.
   */
  async get<T>(path: string, query: Record<string, string | number | undefined> = {}, ttl = 300): Promise<T> {
    const url = new URL(path, this.env.DEADLOCK_API);
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === "") continue;
      url.searchParams.set(k, k.endsWith("unix_timestamp") ? String(Math.floor(Number(v) / 3600) * 3600) : String(v));
    }
    const key = `api:${url.pathname}${url.search}`;
    const staleKey = `stale:${key}`;

    if (ttl > 0) {
      const hit = await cacheGet<T>(key);
      if (hit !== null) return hit;
    }

    try {
      const data = await this.fetchWithRetry<T>(url.toString());
      if (ttl > 0) {
        const body = JSON.stringify(data);
        await Promise.all([cachePut(key, body, ttl), cachePut(staleKey, body, 7 * 86400)]);
      }
      return data;
    } catch (e) {
      if (ttl > 0 && e instanceof ApiError && (e.status === 503 || e.status === 429)) {
        const stale = await cacheGet<T>(staleKey);
        if (stale !== null) { console.warn("serving stale for", key); return stale; }
      }
      throw e;
    }
  }

  /**
   * Static assets (heroes, items). Same host as the API (`/v1/assets/...`), cached for a day.
   * `trim` lets us drop tooltip/description bulk before caching — the full item list is several MB.
   */
  async asset<T>(path: string, trim?: (raw: unknown) => T, ttl = 86400): Promise<T> {
    const key = `asset:v5:${path}`;
    const hit = await cacheGet<T>(key);
    if (hit !== null) return hit;
    const raw = await this.fetchWithRetry<unknown>(new URL(path, this.env.DEADLOCK_API).toString());
    const data = trim ? trim(raw) : (raw as T);
    await cachePut(key, JSON.stringify(data), ttl);
    return data;
  }

  private async fetchWithRetry<T>(url: string, attempt = 0): Promise<T> {
    const res = await fetch(url, { headers: this.headers() });
    if (res.status === 503 || res.status === 429) {
      const wait = Number(res.headers.get("retry-after") ?? "2");
      if (attempt >= 1 || wait > 4) throw new ApiError(res.status, `upstream busy (retry-after ${wait}s): ${url}`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      return this.fetchWithRetry<T>(url, attempt + 1);
    }
    if (!res.ok) throw new ApiError(res.status, `${res.status} ${res.statusText} for ${url}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as T;
  }

  // ---- convenience wrappers (paths from the public OpenAPI spec) ----
  matchHistory(accountId: number) {
    return this.get<import("./types").MatchHistoryRow[]>(`/v1/players/${accountId}/match-history`, {}, 600);
  }
  mmr(accountIds: number[]) {
    return this.get<import("./types").MmrRow[]>(`/v1/players/mmr`, { account_ids: accountIds.join(",") }, 1800);
  }
  mmrHistory(accountId: number) {
    return this.get<import("./types").MmrRow[]>(`/v1/players/${accountId}/mmr-history`, {}, 3600);
  }
  matchMetadata(matchId: number) {
    return this.get<unknown>(`/v1/matches/${matchId}/metadata`, {}, 0); // stored in D1 instead
  }
  leaderboard(region: "Europe" | "Asia" | "NAmerica" | "SAmerica" | "Oceania" = "NAmerica") {
    return this.get<unknown>(`/v1/leaderboard/${region}`, {}, 3600);
  }
  heroStats(q: Record<string, string | number | undefined> = {}) {
    return this.get<HeroStat[]>(`/v1/analytics/hero-stats`, q, 6 * 3600);
  }
  heroCounterStats(q: Record<string, string | number | undefined> = {}) {
    return this.get<HeroCounterStat[]>(`/v1/analytics/hero-counter-stats`, q, 12 * 3600);
  }
  heroSynergyStats(q: Record<string, string | number | undefined> = {}) {
    return this.get<HeroSynergyStat[]>(`/v1/analytics/hero-synergy-stats`, q, 12 * 3600);
  }
  itemStats(q: Record<string, string | number | undefined> = {}) {
    return this.get<ItemStat[]>(`/v1/analytics/item-stats`, q, 6 * 3600);
  }
  killDeathStats(q: Record<string, string | number | undefined> = {}) {
    return this.get<KillDeathStat[]>(`/v1/analytics/kill-death-stats`, q, 12 * 3600);
  }
  /** Whether the player's match uploader has been seen recently. */
  ingestStatus(accountId: number) {
    return this.get<{ account_id: number; active: boolean; last_upload_at: string | null; window_days: number }>(`/v1/players/${accountId}/ingest-status`, {}, 300);
  }
  steamSearch(q: string, limit = 10) {
    return this.get<SteamProfile[]>(`/v1/players/steam-search`, { search_query: q, limit }, 300);
  }
  steamProfiles(accountIds: number[]) {
    return this.get<SteamProfile[]>(`/v1/players/steam`, { account_ids: accountIds.join(",") }, 3600);
  }
  heroes() {
    return this.asset<HeroAsset[]>(`/v1/assets/heroes`, (raw) =>
      (raw as RawHero[]).map((h) => ({ id: h.id, name: h.name, class_name: h.class_name, player_selectable: h.player_selectable, disabled: h.disabled,
        in_development: h.in_development, tags: h.tags ?? [], complexity: h.complexity, hero_type: h.hero_type, gun_tag: h.gun_tag, color: h.colors?.style_hex,
        description: { role: h.description?.role, playstyle: h.description?.playstyle, lore: h.description?.lore },
        images: { icon: h.images?.icon_image_small, card: h.images?.icon_hero_card, minimap: h.images?.minimap_image_webp,
          gloat: h.images?.hero_card_gloat, critical: h.images?.hero_card_critical, vertical: h.images?.top_bar_vertical_image_webp,
          background: h.images?.background_image_webp ?? h.images?.background_image, name: h.images?.name_image } })));
  }
  /** A hero's four signature abilities with icon, description, upgrade tiers and key numbers. */
  async heroAbilities(heroId: number) {
    const raw = await this.asset<RawHero & { items?: Record<string, string> }>(`/v1/assets/heroes/${heroId}`, undefined, 86400);
    const slots = ["signature1", "signature2", "signature3", "signature4"] as const;
    const out = await Promise.all(slots.map(async (slot, i) => {
      const cls = raw.items?.[slot]; if (!cls) return null;
      const a = await this.asset<RawAbility>(`/v1/assets/items/${cls}`, undefined, 86400).catch(() => null); if (!a) return null;
      const num = (k: string) => { const v = a.properties?.[k]?.value; const n = typeof v === "string" ? parseFloat(v) : Number(v); return Number.isFinite(n) && n !== 0 ? n : undefined; };
      return { slot: i + 1, key: i === 3 ? "ultimate" : `${i + 1}`, name: a.name, type: a.ability_type, image: a.image_webp ?? a.image,
        description: a.description?.desc, quip: a.description?.quip, tiers: [a.description?.t1_desc, a.description?.t2_desc, a.description?.t3_desc].filter(Boolean),
        cooldown: num("AbilityCooldown"), duration: num("AbilityDuration"), range: num("AbilityCastRange"), charges: num("AbilityCharges"), radius: num("Radius"),
        upgrades: (a.upgrades ?? []).map((u) => u.property_upgrades?.map((pu) => `${pu.name} ${typeof pu.bonus === "number" && pu.bonus > 0 ? "+" : ""}${pu.bonus}`) ?? []) };
    }));
    return out.filter(Boolean);
  }
  /** Ranks, game colours, fonts and the official map, trimmed for the front end. */
  uiAssets() {
    return this.asset<UiAssets>(`/v1/assets/map`, undefined, 86400).then(async (map) => {
      const [ranks, colors, fonts] = await Promise.all([this.asset<RawRank[]>(`/v1/assets/ranks`), this.asset<Record<string, { red: number; green: number; blue: number }>>(`/v1/assets/colors`), this.asset<Record<string, string>>(`/v1/assets/fonts`)]);
      return {
        ranks: ranks.map((r) => ({ tier: r.tier, name: r.name, color: r.color, large: r.images?.large_webp ?? r.images?.large, small: Array.from({ length: 6 }, (_, i) => r.images?.[`small_subrank${i + 1}_webp`] ?? r.images?.[`small_subrank${i + 1}`]), badge: Array.from({ length: 6 }, (_, i) => r.images?.[`subrank${i + 1}_webp`] ?? r.images?.[`subrank${i + 1}`]) })),
        colors: Object.fromEntries(Object.entries(colors).map(([k, v]) => [k, `rgb(${v.red},${v.green},${v.blue})`])),
        fonts: Object.fromEntries(Object.entries(fonts).filter(([k]) => k.startsWith("radiance") || k.startsWith("reaver"))),
        map: { radius: map.radius, images: map.images, objectives: map.objective_positions, camps: (map.neutral_camps ?? []).map((c) => ({ name: c.name, kind: c.kind, left: c.left_relative, top: c.top_relative, icon: c.icon })) },
      };
    });
  }
  /** Shop items only, with `properties` flattened to {key: number}. */
  items() {
    return this.asset<ItemAsset[]>(`/v1/assets/items`, (raw) =>
      (raw as RawItem[])
        .filter((i) => i.type === "upgrade" && i.shopable && !i.disabled)
        .map((i) => ({ id: i.id, name: i.name, class_name: i.class_name, type: i.type, item_slot_type: i.item_slot_type, item_tier: i.item_tier, cost: i.cost,
          shopable: i.shopable, disabled: i.disabled, image: i.shop_image_webp ?? i.image_webp ?? i.image, is_active_item: i.is_active_item,
          heroes: i.heroes ?? [], activation: i.activation, component_items: i.component_items ?? [],
          description: i.description?.desc ?? i.description?.active ?? i.description?.passive ?? undefined,
          // Labelled stats the in-game tooltip shows, e.g. { label: "Weapon Damage", value: "+14%" }
          stats: Object.entries(i.properties ?? {}).filter(([, v]) => v?.label && parseFloat(String(v?.value ?? "0")))
            .map(([k, v]) => ({ key: k, label: String(v!.label), value: `${parseFloat(String(v!.value)) > 0 && !String(v!.value).startsWith("-") ? "+" : ""}${v!.value}${v!.postfix ?? ""}`, elevated: (i.tooltip_sections ?? []).some((t) => t.section_attributes?.some((a) => a.elevated_properties?.includes(k))) })),
          properties: Object.fromEntries(Object.entries(i.properties ?? {}).map(([k, v]) => [k, parseFloat(String(v?.value ?? "0")) || 0]).filter(([, n]) => n !== 0)) })));
  }
}

export class ApiError extends Error {
  constructor(public status: number, msg: string) {
    super(msg);
  }
}

export type SteamProfile = { account_id: number; personaname: string; profileurl: string; avatar: string; avatarmedium?: string; avatarfull?: string;
  realname?: string | null; countrycode?: string | null; matches_played_last_30d?: number | null; friends?: { account_id: number; friend_since: string }[] };

// Loose upstream shapes — only the fields we rely on. Everything else is passed through.
export type HeroStat = { hero_id: number; wins: number; losses: number; matches: number; players?: number; [k: string]: unknown };
// /v1/analytics/hero-counter-stats rows
export type HeroCounterStat = { hero_id: number; enemy_hero_id: number; wins: number; matches_played: number; [k: string]: unknown };
// /v1/analytics/hero-synergy-stats rows
export type HeroSynergyStat = { hero_id1: number; hero_id2: number; wins: number; matches_played: number; [k: string]: unknown };
export type ItemStat = { item_id: number; wins: number; losses: number; matches: number; players?: number; [k: string]: unknown };
// World coordinates on a 128-unit grid (roughly -10k..+11k), not a 0..127 raster.
export type KillDeathStat = { position_x: number; position_y: number; kills: number; deaths: number; killer_team: number };
type RawHero = { id: number; name: string; class_name: string; player_selectable?: boolean; disabled?: boolean; in_development?: boolean; tags?: string[]; complexity?: number;
  hero_type?: string; gun_tag?: string; colors?: { style_hex?: string }; description?: { role?: string; playstyle?: string; lore?: string }; images?: Record<string, string | undefined> };
export type HeroAsset = { id: number; name: string; class_name: string; player_selectable?: boolean; disabled?: boolean; in_development?: boolean; tags: string[]; complexity?: number;
  hero_type?: string; gun_tag?: string; color?: string; description: { role?: string; playstyle?: string; lore?: string }; images: Record<string, string | undefined> };
type RawAbility = { id: number; name: string; ability_type?: string; image?: string; image_webp?: string; properties?: Record<string, { value?: number | string } | undefined>;
  description?: { desc?: string; quip?: string; t1_desc?: string; t2_desc?: string; t3_desc?: string }; upgrades?: { property_upgrades?: { name: string; bonus: number | string }[] }[] };
type RawRank = { tier: number; name: string; color: string; images?: Record<string, string | undefined> };
export type UiAssets = {
  radius: number; images: Record<string, string>; objective_positions: Record<string, { left_relative: number; top_relative: number }>;
  neutral_camps?: { name: string; kind: string; left_relative: number; top_relative: number; icon?: string }[];
  ranks?: unknown; colors?: unknown; fonts?: unknown; map?: unknown;
};
type RawItem = { id: number; name: string; class_name: string; type: string; item_slot_type?: "weapon" | "vitality" | "spirit"; item_tier?: number; cost?: number;
  shopable?: boolean; disabled?: boolean; is_active_item?: boolean; heroes?: number[]; image?: string; image_webp?: string; shop_image_webp?: string;
  activation?: string; component_items?: string[]; description?: { desc?: string; active?: string; passive?: string };
  tooltip_sections?: { section_type?: string; section_attributes?: { properties?: string[]; elevated_properties?: string[] }[] }[];
  properties?: Record<string, { value?: number | string; label?: string; postfix?: string } | undefined> };
export type ItemAsset = Omit<RawItem, "properties" | "description" | "tooltip_sections"> & { properties: Record<string, number>; description?: string;
  stats: { key: string; label: string; value: string; elevated: boolean }[] };
