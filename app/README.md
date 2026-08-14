# ClipMind app plus backend

TypeScript, Next.js (App Router), Node 22+. This is the boss: it owns the database, the clip state machine, scheduling, push, and it calls the Minds agent server-side.

## Responsibilities
- Owns Postgres (the only database owner in the system).
- Deterministic control flow: clip state machine, rotation (least-recently-served), dedup, scheduling execution, retries.
- Calls the clip service over HTTP (token-gated) and the Minds agent via the Builder API / client-lib.
- FCM web push for the "time to post" nudge.
- Push nudges run in the long-lived Next server process every 5 minutes. The tick uses a transaction-scoped Postgres advisory lock plus the `NudgeLog` reservation key, so overlapping app instances do not duplicate notifications. Configure an external cron to `POST /api/push/tick` with `CRON_SECRET` as the backstop; `npm run push:tick` calls that same guarded endpoint for manual proof or debugging.

Do not put reliability-critical control flow in the Mind. See [`../AGENTS.md`](../AGENTS.md) section 0.

## Setup (once package.json lands)
1. `cp .env.example .env` and fill it in.
2. `npm install`
3. `npx prisma migrate dev` to create the schema.
4. `npm run dev`

## PWA icons
The source icon lives at `public/icons/clipmind-icon.svg`. The checked-in PNG icons are generated with `npm run icons:pwa`, which uses the `sharp` package already installed with the app toolchain.

## E2E smoke
Run `npm run test:e2e` from `app/` against a migrated test database. The Playwright config runs `next build`, seeds one creator with an access code, starts `next start`, logs in through `/login`, then verifies Home, Review, and Rhythm render from Postgres data.

This deliberately does not run the upload pipeline, clip-service calls, Minds calls, OpenAI calls, accept scheduling, or the post sheet. Those need external APIs or heavier media fixtures and stay out of CI for this sprint gate.
