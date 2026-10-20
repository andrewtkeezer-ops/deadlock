# Soul Scribe

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

## Invite-only Google login (handled by the Worker)

Signed-out visitors to `/` see the Soul Scribe welcome page (`public/welcome.html`) with **Continue with Google**.
The Worker runs the Google OAuth code flow itself and sets a signed `squad_session` cookie; every page and `/api/*`
then requires that the email is `SUPER_ADMIN_EMAIL` or on the `members` table (Admin → invite). No Cloudflare Access needed.

1. Google Cloud console → APIs & Services → Credentials → **Create credentials → OAuth client ID → Web application**.
   Authorized redirect URI: `https://deadlock.andrewtkeezer.workers.dev/api/auth/google/callback` (add your custom
   domain's too, later). If the consent screen is "External", add the squad's emails as test users or publish it.
2. `wrangler.jsonc` → `GOOGLE_CLIENT_ID` = the client ID. Then secrets (Workers → Settings → Variables, or CLI):
   `npx wrangler secret put GOOGLE_CLIENT_SECRET` and `npx wrangler secret put SESSION_SECRET` (any long random string).
3. Push / deploy. Visit the site signed out → welcome page → Google → back in. Sign out is in the menu footer.
4. **Remove the Cloudflare Access application** for the hostname (Zero Trust → Access → Applications), otherwise Access
   still intercepts every visit before the Worker and sends people straight to Google.

With `GOOGLE_CLIENT_ID` empty (local dev) there is no auth: everything is open and everyone is admin.
Legacy: if `GOOGLE_CLIENT_ID` is empty but `ACCESS_TEAM_DOMAIN` + `ACCESS_AUD` are set, the old Access JWT check is used instead.

## Adding friends

Easiest: each friend opens **Setup** and clicks **Sign in through Steam** (OpenID: no API key, no password seen by us).
That adds them as a tracked player, imports their history, and links their Google member row if Access is on.
Admins can also search Steam names / paste profile URLs on **/admin.html**.


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
| KV | 100k reads, 1k writes/day | only Access certs + uploader-notify throttle (a few dozen writes/day). API/asset caching uses the Cache API (no op limits). |
| Cron | free | 24 runs/day × ~12 upstream calls |
| Upstream (deadlock-api) | 200 req/min/IP | nowhere close |

## Known TODOs / things to verify against the live API

- Field names and asset paths were verified against live responses on 2026-10-19. If a page errors after a game patch,
  compare `/api/builds/property-keys` and https://api.deadlock-api.com/openapi.json.
- There is no "bullet falloff" item property in the data; the closest is `LongRangeBonusWeaponPower` /
  `BonusAttackRangePercent`, mapped to the wizard's "Range" slider.
- `public/match.html` dumps raw match metadata; render a proper scoreboard.
- Drop a minimap at `public/img/map.png` for the heatmap; set `FLIP_Y` if it's upside down.
- Live match tracking is a **paid** feature upstream (per-match billing), so it's intentionally not here.
