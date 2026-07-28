# Team onboarding: Mos and Felix

Welcome. This doc gets you from clone to running app, then points you at the review
we want from you. Read AGENTS.md first (working rules), then docs/build-plan.md
(the design), then docs/design/app-ux.md (the UI spec). George's walkthrough video
in the group chat is the product intent in 70 seconds.

## What exists (as of 2026-07-28)

The full loop works on a phone: install the PWA from clipmind.gitm.gg, log in with a
creator code, upload a long video, the backend runs transcribe -> candidate detection ->
Mind ranking -> captions, you review ranked clips, accept, get a rendered 9:16 with
burned subtitles on a CDN URL, copy per-platform captions. Deployed on Railway
(app + clip-service + Postgres), media on Cloudflare R2, one Mind per creator on
Minds holding voice/taste Tenets.

Tickets T0-T15 are done or in flight; see closed issues + PRs for the history. Coming
next: T16 post flow (ready-to-post boxes, post sheet with save/share, thumbnails),
FCM push, Mind taste-feedback from accept/reject.

## Local setup

1. Clone git@github.com:VBros-Org/clipmind.git
2. Postgres 14+ locally, create a database, e.g. createdb clipmind_dev
3. app/: npm install, copy .env.example to .env and fill (see Secrets below),
   npx prisma migrate dev, npm run dev
4. clip-service/: python3.12+ venv, pip install -r requirements.txt, copy .env.example
   to .env, needs ffmpeg on PATH, run: uvicorn src.main:app --port 8000
5. Create yourself a creator: npm run onboard:creator (needs a Minds key; without one
   it runs in DEFERRED mode and skips Mind creation, which is fine for UI work), then
   scripts/set-access-code.ts to log into the app.

## Secrets

Nothing secret is in the repo, ever. You need from George (ask in the group chat,
he shares via a secure channel, never in the repo):
- OPENAI_API_KEY (Whisper + distillation)
- CLIP_SERVICE_TOKEN (any shared random string works locally if you set it in both .envs)
- R2 credentials only if you work on storage paths (most UI work does not need them)
- MINDS_BUILDER_API_KEY only if you work on Mind calls (ranking/captions/onboarding);
  UI and pipeline work runs against fakes in tests without it

## The review we want first (before writing features)

Pull everything, get it running, then spend your first session trying to break our
reasoning, not the code. Big decisions to challenge, and where they live:

1. One Mind per creator; product logic in repo prompts, Tenets hold only voice/taste
   (AGENTS.md section 0, docs/build-plan.md section 7). Is the boundary right?
2. Stateless clip service consuming presigned R2 URLs; the app is the only credential
   holder (lib/storage.ts, clip-service/). Would you have split it differently?
3. In-process async pipeline with DB-backed stages, no queue (lib/pipeline.ts).
   Where does this break first at 10 creators? 100?
4. Deterministic scheduling state machine + Mind-as-metadata-only ranking
   (lib/scheduling.ts, lib/ranking.ts). Any control flow leaking toward the Mind?
5. PWA-first distribution, TWA demoted to optional (docs/design/app-ux.md). Agree?
6. Cloudflare Worker proxy for clipmind.gitm.gg because Railway cert issuance stuck
   (infra/cloudflare/clipmind-proxy.js). Better fix?
7. Cognition economics: Builder-API Minds get no free grant; one jam boost per team.
   How should a real product fund per-creator Minds?

File findings as GitHub issues labeled review, one issue per finding, with the path
you would take instead. Disagreements welcome; "it is fine" is also a finding.

## Working rules recap

Branch -> PR -> review -> merge, never commit to main. Bounded scope per PR. No
secrets in diffs. No em dashes in user-facing copy. Read AGENTS.md for the rest.
