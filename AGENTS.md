# ClipMind — Agent Working Rules

**Read this before writing any code in this repo.** These rules apply to every AI agent (Codex, Claude, Cursor, whatever) working in ClipMind, across all three of our machines. They exist so George, Mos, and Felix's agents build the same way. Full design: [`docs/build-plan.md`](docs/build-plan.md).

This file is self-contained. It does not depend on any one person's local setup.

---

## 0. Prime architecture rule (never break this)

**The deterministic backend is the boss. The Minds agent is a headless cognitive service the backend calls.**

- Reliability-critical control flow (sequencing, dedup, rotation, retries, scheduling execution, push delivery, state) lives in **deterministic code**, never in the Mind.
- The Mind is called server-side only for: (1) holding a creator's voice + clip taste (Tenets), (2) writing post captions in that voice with SEO, (3) ranking candidate clip moments.
- The Mind never owns control flow and never faces the user directly.
- **One Mind per creator**, created at onboarding, never one shared brain. Product logic (captioning method, SEO rules, ranking approach) lives in backend prompts in this repo, not typed into a Mind. A Mind's Tenets hold only that creator's voice and taste.
- If you catch yourself asking the Mind to enforce a hard rule ("never post the same clip twice"), stop: that belongs in the database and the state machine.

## 1. Stack (do not introduce new languages or frameworks without team sign-off)

| Layer | Stack |
|---|---|
| App + backend + Minds glue | **TypeScript, Next.js (App Router), Node 22+** |
| Minds integration | `@animocabrands/minds-cli`, `@animocabrands/minds-client-lib` (TS/Node; **no Python SDK exists**) |
| Clip service | **Python 3.12, FastAPI**, ffmpeg, OpenAI Whisper API. Stateless, no DB. |
| Database | **Postgres on Railway, volume-backed.** Owned by the TS backend only (the boss). Prisma ORM. |
| Push | FCM web push + service worker |
| Deploy | **Railway**, one service per component |

- The clip service is **stateless**: it takes input, returns clips/candidates, holds no state. The backend owns the one database.
- Two languages only: TS (app/backend/Minds) and Python (clip service). Do not add a third.

## 2. Build order (bottom-up, verify each layer before the next)

1. Config + environment (validate env vars, crash early on missing).
2. Data layer (schema, migrations, verify the DB connection).
3. Core logic (real reads/writes against the data layer).
4. Interface (API routes, UI, handlers).
5. Integration (wire end-to-end, verify the full flow).

**Anti-patterns — stop if you catch yourself:**
- Building UI or handlers on mock/placeholder data. Use the real data layer.
- Writing a handler that calls a function that does not exist yet.
- Building five DB functions before any caller exists.
- Leaving `TODO: connect to real API` anywhere.
- Copying janky patterns from another repo. Build from current best practices.

Build thin vertical slices first (one complete flow) before expanding sideways. When adding to existing code, trace the full path from user input to database and back **before** writing.

## 3. Discipline

- **Verify before claiming.** Actually read the code and run it. Do not assert a thing works because it should.
- **Never trust a piped test's exit code.** Read the explicit PASS/FAIL line.
- Tests live with the code and must pass before you call something done.
- Read a file before you change it. Summarize your plan before a multi-file change. No scope creep beyond the ticket.

## 4. Git

- Remote: `git@github.com:VBros-Org/<repo>.git` (org `VBros-Org`, github.com SSH). ClipMind's repo: `git@github.com:VBros-Org/clipmind.git`.
- **Never commit to the default branch.** Branch first.
- Never commit secrets. Tokens go in env vars / Railway variables / a secret manager, never in the repo, never in Markdown or YAML.
- No backticks in a double-quoted `git commit -m` message (the shell runs them). Plain words or single quotes.
- Confirm `git remote -v` and identity before pushing.

## 5. Deploy (Railway)

- One service per component (app, clip service). Use Railway **project tokens**; do not run `railway login`.
- Postgres must be **volume-backed** (data loss is unrecoverable otherwise). Query for real data before any destructive infra change.
- `railway up` to deploy (not `railway deploy`). Always target an explicit `--service`. Read `--help` before a command you are unsure of.

## 6. Secrets

- Never ask a human to paste secrets into chat. Never print them. Never commit them.
- Reference secrets by env var name. Store them in Railway variables or a local `.env` that is gitignored.

## 7. Voice and copy (anything a user or judge reads)

- **No em dashes.** Use commas, periods, or colons.
- No AI-slop tells: no "not just X but Y" parallelisms, no rule-of-three padding, no vague AI-vocab clusters. Plain, direct.
- This applies to UI copy, captions, the demo writeup, and the store listing.

## 8. Jam invariant

The Minds agent must be **integral, not cosmetic**. Every feature decision should keep the Mind central to the product's value (voice memory, captions, ranking). If a change would make the Mind removable without breaking the product, rethink it.

## 9. Before you code, checklist

- [ ] Read `docs/build-plan.md` and the relevant spec section.
- [ ] Confirm which component you are in and its stack (section 1).
- [ ] Trace the full path input to DB and back.
- [ ] Is any reliability-critical logic about to land in the Mind? Move it to deterministic code.
- [ ] Branch off, not on the default branch.
