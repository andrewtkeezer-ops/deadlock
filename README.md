# Deadlock Squad

Private stats + build site for a friend group, running on Cloudflare's free tier.
Data comes from the community [deadlock-api](https://deadlock-api.com) (free, MIT).

```
public/        static pages (no build step): leaderboard, player, match, heroes, counters, heatmap, build wizard, setup
src/index.ts   Hono router + hourly cron
src/deadlock.ts  upstream client (KV cache, Retry-After backoff, optional API key)
src/sync.ts    pulls each friend's match history + MMR into D1
src/routes/    players · heroes · analytics · builds · admin
migrations/    D1 schema
```

## First-time setup

```sh
npm install
npx wrangler login
npm run db:create                 # paste the database_id into wrangler.jsonc
npx wrangler kv namespace create CACHE   # paste the id into wrangler.jsonc
npm run db:migrate:local && npm run db:migrate
npx wrangler secret put ADMIN_TOKEN       # replaces the "change-me" default in prod
npm run dev                        # http://localhost:8787
npm run deploy                     # → https://deadlock-squad.<you>.workers.dev
```

Optional: a free API key from deadlock-api doubles the rate limit and gets queue priority —
`npx wrangler secret put DEADLOCK_API_KEY`.

## Deploying from GitHub (Workers Builds)

Repo: https://github.com/andrewtkeezer-ops/deadlock. In the Cloudflare dashboard → Workers & Pages → Create →
**Import a repository** → pick `deadlock`, then:

- Build command: `npx wrangler d1 migrations apply deadlock-squad --remote` (runs schema migrations on every deploy)
- Deploy command: `npx wrangler deploy`
- Root directory: `/`

Before the first build, the D1 database and KV namespace must exist and their IDs must be in `wrangler.jsonc`
(create them in the dashboard under Storage & Databases, or with `wrangler d1 create` / `wrangler kv namespace create`).
Set `ADMIN_TOKEN` and (optionally) `DEADLOCK_API_KEY` under the Worker's Settings → Variables and Secrets.
Every push to `main` then redeploys.

## Adding friends

1. Each friend installs the ingest tool (the **Setup** page has the one-line PowerShell command).
   Without it, their matches are mostly invisible to every tracker, not just this one.
2. Setup page → paste Steam profile URL → it converts to `account_id` → "Add & import" (needs the admin token).
   Or: `curl -X POST https://<site>/api/admin/players -H "x-admin-token: …" -d '{"account_id":123,"name":"Matt"}'`
3. The cron (`17 * * * *`) re-syncs everyone hourly. Force one: `POST /api/admin/sync`.

## Free-tier budget (10 players)

| Resource | Free limit | Expected use |
|---|---|---|
| Worker requests | 100k/day | a few hundred |
| D1 | 5 GB, 5M reads/day | ~1 MB per 1k matches |
| KV | 100k reads, 1k writes/day | writes ≈ cache misses; TTLs are 10 min–12 h |
| Cron | free | 24 runs/day × ~12 upstream calls |
| Upstream (deadlock-api) | 200 req/min/IP | nowhere close |

## Known TODOs / things to verify against the live API

- **Field names.** `src/types.ts` (`MatchHistoryRow`), `HeroPairStat` (`hero_id2` / `enemy_id`) and the item
  `properties` keys in `src/routes/builds.ts::STAT_MAP` were written from the public clients/docs, not from a live
  response — the API host wasn't reachable from the machine this was scaffolded on. Run `npm run dev`, open
  `/api/builds/property-keys`, and compare `curl https://api.deadlock-api.com/openapi.json` if a page errors.
- `public/match.html` dumps raw match metadata; render a proper scoreboard.
- Drop a minimap at `public/img/map.png` for the heatmap; set `FLIP_Y` if it's upside down.
- Live match tracking is a **paid** feature upstream (per-match billing), so it's intentionally not here.
- No login. The admin token is the only gate; the site itself is readable by anyone with the URL.
  Add Cloudflare Access (free for ≤50 users) in front of the Worker if you want it private.
