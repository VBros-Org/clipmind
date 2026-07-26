# ClipMind

Long-form video into ready-to-post clips plus captions in the creator's voice, powered by a persistent Minds agent. Entry for Creative Minds Jam #1.

Team: VBros (George, Mos, Felix).

## Read first
- Working rules for every agent: [`AGENTS.md`](AGENTS.md)
- Full design and build plan: [`docs/build-plan.md`](docs/build-plan.md)

## Architecture in one line
The deterministic backend is the boss. The Minds agent is a headless cognitive service the backend calls for voice, captions, and clip ranking. It never owns control flow.

## Layout
- `app/` — TypeScript / Next.js app plus backend (the boss). Owns Postgres, the state machine, scheduling, push, and the Minds integration.
- `clip-service/` — Python / FastAPI stateless clip service (ffmpeg plus Whisper). No database.
- `docs/` — design docs.

## Stack
See `AGENTS.md` section 1. Two languages only: TypeScript (app, backend, Minds glue) and Python (clip service).

## Quickstart
Each service has its own README and `.env.example`. Copy `.env.example` to `.env` and fill it in. Never commit `.env`.
