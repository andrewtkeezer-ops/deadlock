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
export class DeadlockApi {
  constructor(private env: Env) {}

  private headers(): HeadersInit {
    const h: Record<string, string> = { accept: "application/json", "user-agent": "deadlock-squad/0.1 (cloudflare worker)" };
    if (this.env.DEADLOCK_API_KEY) h["X-API-Key"] = this.env.DEADLOCK_API_KEY;
    return h;
  }

  /** GET with KV cache. ttl in seconds. */
  async get<T>(path: string, query: Record<string, string | number | undefined> = {}, ttl = 300): Promise<T> {
    const url = new URL(path, this.env.DEADLOCK_API);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    const key = `api:${url.pathname}${url.search}`;

    if (ttl > 0) {
      const hit = await this.env.CACHE.get(key, "json");
      if (hit !== null) return hit as T;
    }

    const data = await this.fetchWithRetry<T>(url.toString());
    if (ttl > 0) await this.env.CACHE.put(key, JSON.stringify(data), { expirationTtl: Math.max(60, ttl) });
    return data;
  }

  /** Static assets (heroes, items, maps). Cached for a day; bust by bumping the key if needed. */
  async asset<T>(path: string, ttl = 86400): Promise<T> {
    const url = new URL(path, this.env.DEADLOCK_ASSETS).toString();
    const key = `asset:${url}`;
    const hit = await this.env.CACHE.get(key, "json");
    if (hit !== null) return hit as T;
    const data = await this.fetchWithRetry<T>(url);
    await this.env.CACHE.put(key, JSON.stringify(data), { expirationTtl: ttl });
    return data;
  }

  private async fetchWithRetry<T>(url: string, attempt = 0): Promise<T> {
    const res = await fetch(url, { headers: this.headers() });
    if (res.status === 503 || res.status === 429) {
      const wait = Number(res.headers.get("retry-after") ?? "2");
      if (attempt >= 2 || wait > 20) throw new ApiError(res.status, `upstream busy (retry-after ${wait}s): ${url}`);
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
    return this.get<HeroPairStat[]>(`/v1/analytics/hero-counter-stats`, q, 12 * 3600);
  }
  heroSynergyStats(q: Record<string, string | number | undefined> = {}) {
    return this.get<HeroPairStat[]>(`/v1/analytics/hero-synergy-stats`, q, 12 * 3600);
  }
  itemStats(q: Record<string, string | number | undefined> = {}) {
    return this.get<ItemStat[]>(`/v1/analytics/item-stats`, q, 6 * 3600);
  }
  killDeathStats(q: Record<string, string | number | undefined> = {}) {
    return this.get<KillDeathStat[]>(`/v1/analytics/kill-death-stats`, q, 12 * 3600);
  }
  heroes() {
    return this.asset<HeroAsset[]>(`/v2/heroes`);
  }
  items() {
    return this.asset<ItemAsset[]>(`/v2/items`);
  }
}

export class ApiError extends Error {
  constructor(public status: number, msg: string) {
    super(msg);
  }
}

// Loose upstream shapes — only the fields we rely on. Everything else is passed through.
export type HeroStat = { hero_id: number; wins: number; losses: number; matches: number; players?: number; [k: string]: unknown };
export type HeroPairStat = { hero_id: number; enemy_id?: number; hero_id2?: number; wins: number; matches_played: number; [k: string]: unknown };
export type ItemStat = { item_id: number; wins: number; losses: number; matches: number; players?: number; [k: string]: unknown };
export type KillDeathStat = { x: number; y: number; kills: number; deaths: number; [k: string]: unknown };
export type HeroAsset = { id: number; name: string; class_name: string; images?: Record<string, string>; player_selectable?: boolean; disabled?: boolean; [k: string]: unknown };
export type ItemAsset = {
  id: number; name: string; class_name: string; type: string; // "upgrade" | "ability" | "weapon"
  item_slot_type?: "weapon" | "vitality" | "spirit"; item_tier?: number; cost?: number;
  shopable?: boolean; disabled?: boolean; properties?: Record<string, { value?: number | string; [k: string]: unknown }>;
  image?: string; [k: string]: unknown;
};
