# ClipMind app plus backend

TypeScript, Next.js (App Router), Node 22+. This is the boss: it owns the database, the clip state machine, scheduling, push, and it calls the Minds agent server-side.

## Responsibilities
- Owns Postgres (the only database owner in the system).
- Deterministic control flow: clip state machine, rotation (least-recently-served), dedup, scheduling execution, retries.
- Calls the clip service over HTTP (token-gated) and the Minds agent via the Builder API / client-lib.
- FCM web push for the "time to post" nudge.

Do not put reliability-critical control flow in the Mind. See [`../AGENTS.md`](../AGENTS.md) section 0.

## Setup (once package.json lands)
1. `cp .env.example .env` and fill it in.
2. `npm install`
3. `npx prisma migrate dev` to create the schema.
4. `npm run dev`
