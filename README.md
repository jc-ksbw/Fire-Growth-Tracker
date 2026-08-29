# Fire Growth Tracker

A live wildfire intelligence dashboard for tracking active incidents, perimeter
growth, satellite hotspots, evacuation information, weather conditions, and
shareable incident views.

## Features

- Current wildfire perimeters from CAL FIRE, FIRIS, and NIFC sources
- Historical perimeter playback and growth comparison
- NASA FIRMS satellite hotspot overlay
- Evacuation-zone and public-warning links
- Incident weather, wind, humidity, and Red Flag Warning context
- Shareable fire links plus exportable 1280×720 growth graphics
- Automated daily perimeter capture with 48-hour post-incident retention

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

The Worker includes a daily cron trigger at `13:00 UTC`. It captures active
perimeters and removes history 48 hours after an incident disappears from the
active feed. As an alternative, set a `CAPTURE_TOKEN` secret of at least 16
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
