# Fire Growth Tracker

A live wildfire intelligence dashboard for tracking active incidents, perimeter
growth, satellite hotspots, evacuation information, road closures, and
shareable incident views.

## Features

- Current wildfire perimeters from CAL FIRE, FIRIS, and NIFC sources
- CAL FIRE reported acreage and containment for established California fires
- Historical perimeter, hotspot, and evacuation playback
- NOAA HMS satellite hotspot overlay
- CAL OES evacuation zones and Caltrans road closures
- Shareable fire links plus exportable 1280×720 growth graphics
- Automated hourly perimeter capture with a rolling 20-day archive

## California data workflow

CAL FIRE's public incident API is authoritative for reported acreage and
containment on established California fires. Its `UniqueId` joins to the live
CAL FIRE/FIRIS perimeter layer's `websiteId`; that layer's `incident_number`
then joins to the national NIFC IRWIN record. Every distinct source perimeter
is archived before the live map is reduced to the newest shape.

This workflow is intentionally California-specific. If national coverage is
added, CAL FIRE enrichment must remain limited to incidents with `POOState` of
`US-CA`; incidents in other states must use their own authoritative state or
federal sources.

## Local development

Requirements: Node.js 22.13 or newer.

```bash
npm ci
npm run db:migrate:local
npm run dev
```

The dashboard opens at `http://localhost:3000`. Cloudflare's local runtime
provides the D1, Assets, and Images bindings declared in `wrangler.jsonc`.

## Deploy to Cloudflare Workers

1. Authenticate with Cloudflare using `npx wrangler login`, or set
   `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in CI.
2. Create the production D1 database:

   ```bash
   npx wrangler d1 create fire-growth-tracker-db
   ```

3. Replace the placeholder `database_id` in `wrangler.jsonc` with the ID from
   the command output.
4. Apply the migrations and deploy:

   ```bash
   npm run db:migrate:remote
   npm run deploy
   ```

The Worker includes an hourly cron trigger. It captures every distinct active
perimeter and maintains a rolling 20-day archive. As an alternative, set a
`CAPTURE_TOKEN` secret of at least 16
characters and schedule authenticated `POST /api/capture` requests.

## GitHub Actions

CI runs linting, TypeScript checks, a production build, and tests on every push
and pull request. The manual **Deploy to Cloudflare** workflow requires these
repository secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

It also requires the real D1 database ID to be committed in `wrangler.jsonc`.

## Commands

- `npm run dev` — local Vinext development server
- `npm run build` — production Cloudflare build
- `npm run start` — serve the production build locally
- `npm run lint` — lint the source
- `npm test` — build and run integration checks
- `npm run db:generate` — generate Drizzle migrations
- `npm run db:migrate:local` — apply local D1 migrations
- `npm run db:migrate:remote` — apply production D1 migrations
- `npm run deploy` — build and deploy to Cloudflare Workers

Built with [Vinext](https://github.com/cloudflare/vinext), Cloudflare Workers,
D1, Drizzle ORM, React, MapLibre GL, and Recharts.
