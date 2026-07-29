# ClipMind app plus backend

TypeScript, Next.js (App Router), Node 22+. This is the boss: it owns the database, the clip state machine, scheduling, push, and it calls the Minds agent server-side.

## Responsibilities
- Owns Postgres (the only database owner in the system).
- Deterministic control flow: clip state machine, rotation (least-recently-served), dedup, scheduling execution, retries.
- Calls the clip service over HTTP (token-gated) and the Minds agent via the Builder API / client-lib.
- FCM web push for the "time to post" nudge.
- Push nudges run in the long-lived Next server process every 5 minutes. The tick takes a Postgres advisory lock before it sends, so multiple app instances do not duplicate notifications. `npm run push:tick` calls the same protected endpoint for manual proof or debugging.

Do not put reliability-critical control flow in the Mind. See [`../AGENTS.md`](../AGENTS.md) section 0.

## Setup (once package.json lands)
1. `cp .env.example .env` and fill it in.
2. `npm install`
3. `npx prisma migrate dev` to create the schema.
4. `npm run dev`

## PWA icons
The source icon lives at `public/icons/clipmind-icon.svg`. The checked-in PNG icons are generated with `npm run icons:pwa`, which uses the `sharp` package already installed with the app toolchain.
