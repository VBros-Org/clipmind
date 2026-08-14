# Sprint 3 — Audit Hardening (loop food)

Opened 2026-08-14. Loop driver: Claude (Fable 5). Bounded tickets may be delegated to Codex per the 3-stage workflow (Codex builds bounded tickets, Claude verifies blind, George judges). Read `AGENTS.md` before any ticket. Branch off `main`, PR per ticket, `gh pr ready` before merge (draft-merge silently fails).

**Source:** full 4-model audit 2026-08-14 (Codex + Claude + Grok + K3 + adversarial refute), verdict **RED, not release-ready for self-service**. Synthesized report: `/Users/tiddles/llm/audit-runs/2026-08-14-085024-clipmind/audit.md` (copy in `~/Downloads/ClipMind 4-Model Audit 14 Aug.md`). Raw legs beside it. Finding refs below: N-numbers = Claude leg, K3/Codex/Grok = other legs, all cross-verified by the refute pass.

**Deadline context:** BUIDL submission 2026-08-28. Ordering is demo-path-first: what a judge touches in the first two minutes gets fixed before deep backbone work.

**CUT LINE: T1–T9 are must-pass before the demo recording. T10–T15 slip past submission if time runs out.** Log anything deferred in the Deferred section; do not silently drop.

Out of scope for the whole sprint (do not creep): auto-posting, GPU/vision candidate signals, caption style editor, TWA/Play wrap, new product features not listed here.

---

## T1 — Push delivery reliability [P1]
**Evidence:** N1, N11, N12, N18; K3 tick-abort; `app/lib/push-tick-interval.ts:47`, `app/lib/push-tick.ts:49`, `app/lib/nudges.ts:340`, `app/lib/push.ts:121-131`.

- Fix the advisory lock: acquire → tick → release inside ONE interactive `prisma.$transaction` (pins a connection), or drop the lock entirely — the `NudgeLog` unique-constraint reservation is already race-safe. Correct the false claim in `app/README.md:10`.
- Route `/api/push/tick` (CRON_SECRET-gated) through the same guard; recommend an external cron as backstop and document it.
- Isolate per-creator/per-notification failures: one send exception must not abort the whole tick; reservation must not be consumed by a failed send (record delivery state).
- Dedupe keys: include slot timestamp / retry generation so a rescheduled clip or re-failed video re-nudges (currently once-ever per lifetime).
- Auto-disable subscriptions ONLY on `UNREGISTERED`/404. `INVALID_ARGUMENT` is a payload bug, not a dead token — never mass-disable on it.
- Add a `pipeline_done` nudge kind (keyed by videoId) and make the upload copy honest ("We will nudge you" only when push is actually on).
- **Gate:** concurrency test proving two overlapping ticks cannot double-send and a wedged lock cannot persist across ticks; test proving a throwing creator does not block others; test proving reschedule re-nudges; all push tests green against a scratch DB.

## T2 — Caption coverage + durable render state [P1]
**Evidence:** N2; K3 accept-schedules-before-render; `app/lib/pipeline.ts:436,211-218`, `app/lib/review-api.ts:79-126`, `app/lib/render.ts:58-66`.

- Caption on accept: any accepted clip with null `postCopyVariants` gets captioned before it is postable (keeps the top-2 pipeline optimization).
- Durable render failure state on Clip (e.g. `renderFailedAt` + error) with a retry path reachable from the UI; render polling terminates on failure instead of polling forever (N15 part).
- **Gate:** accept a rank-3 clip in a DB test → captions exist before `scheduled` is reachable; kill a render mid-flight → clip lands in a retryable failed state, retry succeeds; no clip can reach the post sheet caption-less.

## T3 — Server-enforced readiness boundary [P1]
**Evidence:** synthesis executive #1; Codex review-before-enrichment; `app/lib/review-api.ts:89`, `app/lib/scheduling-repository.ts:339`, `app/lib/pipeline.ts:411`.

- Introduce explicit `readyToReview` / `readyToPost` predicates enforced in database `where` clauses, not UI: Review verdicts blocked until ranking is complete for the video; scheduling, nudging, and mark-posted blocked until `renderedUrl` + complete captions exist.
- A verdict landing during ranking must not invalidate the ranking snapshot (Codex): guard the ranking write with a status check.
- **Gate:** DB tests: verdict during `ranking` stage is rejected; a clip without render+captions cannot be scheduled, nudged, or marked posted via any API path; existing happy-path suites still green.

## T4 — Review + post sheet demo polish [P1 UX]
**Evidence:** N6, N7, N13, N14, N15; Codex Next-up wrong route; `ReviewBoard.tsx:697-707,753-755,121-125`, `ReadyToPostRow.tsx:224-263,398-406`, `app/lib/review.ts:291-333,538-552`.

- Preview pause/resume: seek to `startMs` only on first load or when playhead leaves the window; a paused clip resumes where it stopped.
- Constrain preview to the clip window (`#t=start,end` media fragment or minimal custom scrub), killing the 24-minute scrubber.
- Post sheet: lazy/priced media prep with visible progress, one fetch shared between player and blob (not two full MP4 downloads), Save disabled state explained, Mark-as-posted stays gated on T3.
- Reject undo: pause the undo/reason timers while the tab is hidden; re-show on return.
- Review page self-refreshes (visibility refresh like Home); show `scheduledFor` after accept (return it through `reviewClipSelect`).
- Fix Home "Next up" to open the working `/home?post=` flow.
- Clipboard copy: catch + fallback UI (non-secure-context demo must not dead-end the post flow).
- **Gate:** blind phone-viewport walkthrough (Playwright screenshots eyeballed): pause/resume works, post sheet shows progress and completes, reject undo survives an app-switch, accept shows the scheduled slot. Component tests where cheap.

## T5 — Signup + session recovery [P1]
**Evidence:** N5, N24; Codex double-submit race; `app/lib/signup.ts:146-195,245`, `SignupFlow.tsx:49,311-332`, `app/lib/review-auth.ts:6`.

- Resume signup from the still-valid `clipmind_signup_creator` cookie on load: refresh mid-flow returns to the correct step, never re-asks for the burned invite, never skips the corpus step.
- Access code: compare-and-set creation (`accessCode: null` in the update where-clause) so double-submit cannot show an overwritten code; redisplay the code in Rhythm behind a tap; roll the 30-day session cookie on activity.
- **Gate:** DB tests for double-claim and double-submit; scripted flow test: claim invite → refresh → complete signup → code shown → code visible again in Rhythm → cookie maxAge refreshed on a later request.

## T6 — Upload path rebuild [P1]
**Evidence:** N3 (Unverified live cap), N16, N17, N29, N4 download side; `infra/cloudflare/clipmind-proxy.js`, `UploadPicker.tsx:596-646`, `app/lib/video-api.ts:516-608`, `app/lib/app-overview.ts:373-398`.

- Replace the single 2 GB XHR through the Worker with presigned multipart upload direct to R2: resumable, cancel button, per-part retry. Bytes are reconciled server-side on completion (mismatch = delete + 400); no client-declared ContentLength trusted.
- Orphan handling: upload intents recorded so abandoned parts/objects are reconciled (pairs with T13 deletion ordering).
- `/upload` lists all non-done videos, not newest-3, so every failed video is reachable for retry/delete.
- **LIVE PROBE RESULT (run 2026-08-14, unauthenticated 150 MB POST so zero pipeline cost): CAP CONFIRMED.** Worker path `clipmind.gitm.gg` → HTTP 413 in 2.6 s after ~1.2 MB sent (Cloudflare edge rejects on declared Content-Length). Railway origin → HTTP 401 (app answered; body size fine without the Worker). The presigned-multipart rebuild is mandatory: today's live domain cannot accept uploads over ~100 MB at all.
- **Gate:** real >100 MB file uploads successfully from a phone-class browser through the live domain path; cancel and resume both proven; byte-mismatch test rejects; failed 4th-newest video visible and retryable.

## T7 — Clip service: long-source handling + output validation [P1]
**Evidence:** N4, N26, N27; `clip-service/src/main.py:42,604-611`, `src/render.py:162-173`, `src/youtube.py:202-204`.

- Stop full-source downloads per operation: feed the presigned URL to ffmpeg directly with `-ss`/range requests for `/cut` and `/thumbnail`; raise or segment the 1 GB cap deliberately for `/candidates`.
- Validate render output with ffprobe (video stream present, sane duration, nonzero size) before returning; empty-output ffmpeg exit-0 must fail loudly.
- Reject live/duration-less YouTube URLs (`live_status != "not_live"` or missing duration) so a live stream cannot wedge the single worker.
- Cap `/cut` window length; cap multipart upload body size.
- **Gate:** pytest additions for each guard; cutting a 30 s window from a large source transfers range-bytes not the whole file (assert via mocked transport); an hour-long window request 4xxs.

## T8 — Candidate + subtitle quality [P1]
**Evidence:** N8, N9, N10; `clip-service/src/candidates.py:100-106,149,382,508-554`, `src/subtitles.py:24-27,165-169`, `app/lib/render.ts:72`.

- Return Whisper `segments`/`words` from `/candidates`; store timed transcript per clip; thread real timings to `/cut` so burned-in subtitles are word-accurate (karaoke actually syncs). String transcripts become hint-only fallback triggering window re-transcription.
- Score candidate windows (spike delta, hook density) and keep top-N spread across the timeline instead of the earliest 8.
- Spike-anchored windows: an energy spike with no transcript segment still yields a candidate; a spike between segments anchors to the spike time, not the following segment.
- Bundle a real font in the clip-service image so the three presets stay distinct on Linux (Arial is absent on Railway).
- **Gate:** pytest: timed-subtitle path exact against a fixture; scored selection picks a strong late-video window over weak early ones; spike-only fixture produces a candidate. One rendered fixture eyeballed for word-sync before merge.

## T9 — Scheduling truth [P1]
**Evidence:** synthesis #9; N25; K3 UTC-only + UTC week; `app/src/app/rhythm/page.tsx:45-96`, `app/lib/scheduling.ts:155`, `app/src/app/login/page.tsx:63-73`.

- Persist Rhythm defaults on first view (or on accept) so displayed cadence is always the real Schedule; kill the silent `no_schedule` path.
- Timezone: DECIDE semantics (slots are creator-local; scheduling math converts via `Creator.timezone`). Show the timezone in Rhythm, editable with confirmation; stop silently overwriting it on every login. "Posted this week" uses creator-local weeks.
- **Gate:** DB test: fresh creator accepts a clip → it schedules from the displayed defaults; timezone change shifts future slots only; login from a different-TZ device does not move slots without confirmation.

## T10 — Durable workflow ownership [P1 backbone]
**Evidence:** synthesis #2; `app/lib/pipeline.ts:287`, `app/lib/channelPull.ts:187`, `app/lib/video-api.ts:388`.

- Persist run ownership for pipeline, channel pull, and onboarding: run id, lease/heartbeat timestamps, attempt count per stage.
- Stale-run recovery: a stage with an expired lease becomes retryable; retry accepts stuck-active stages, not only `failed`; the alternate-Mind repair path no longer strands the original upload as permanent `uploaded` (Codex).
- Fix the pre-`try` tenet parse that wedges `mindStage: learning_voice` un-retryably.
- **Gate:** kill the process mid-stage in a test harness → restart → work is recoverable and retried exactly once; no state requires manual SQL to unstick.

## T11 — Mind provisioning atomicity + corpus paths [P1/P2]
**Evidence:** N21, N22, N23; `app/lib/channelPull.ts:157-205`, `app/lib/video-onboarding.ts:111-180`, `app/lib/voice-corpus.ts:139-153`.

- Atomic Mind claim: conditional `updateMany({ where: { mindId: null } })` + creator-scoped in-flight guard across channel pull, first-video onboarding, and duplicate tabs. Exactly one Mind per creator ever; losers use the winner.
- Corpus-only creators can wake a Mind ("Teach your Mind" creates it when corpus exists and mindId is null) — the yt_blocked fallback copy currently points at a dead end.
- Persist channel-pull transcripts per video (partial failure keeps finished transcriptions; later re-distills include them).
- **Gate:** concurrency test: parallel pull + upload onboarding yields one Mind; corpus-only signup reaches `ready`; a 2-of-3 pull failure retains two transcripts and resumes.

## T12 — PWA privacy + offline honesty [P1]
**Evidence:** synthesis #5; N19; second-tier SW items; `app/public/sw.js:41,105-118,158-178`, `app/lib/session.ts:3`.

- Cache only public assets; never cache authenticated HTML/API/RSC payloads. Logout purges caches and unsubscribes push for the device (next user on a shared device sees nothing).
- Offline navigation fallback: nudge deep-links (`/home?post=...`) resolve via `ignoreSearch` to cached `/home` or a friendly offline page; no white screen inside the installed app.
- `notificationclick`: catch navigate failures with an `openWindow` fallback; do not hijack a mid-upload window; add a foreground `onMessage` display.
- **Gate:** pwa test suite additions; scripted check: logout → caches contain zero authed responses + subscription gone; offline nudge-tap renders the fallback.

## T13 — Storage + media policy [P2 + decision]
**Evidence:** N28, N29 (T6 overlap), K3 delete-order; Codex gstatic import; `app/lib/storage.ts:96-105`, `app/lib/video-api.ts:280`.

- **DECIDED 2026-08-14 (George, on Claude's advice): rendered media stays public-by-link for the jam.** Rationale: cuid keys are unguessable and unenumerable (no bucket listing), the user pool is invite-gated and tiny, and presigning media reads would break or complicate the share sheet, push payload URLs, and long-hold-save flows for zero jam benefit. Sources stay presigned-private as today. Revisit before any public launch: presign media reads or move renders behind an authed proxy route. No presign build work in this sprint.
- Deletion is DB-first: re-check guards inside the transaction before R2 object removal; add an orphan-reconciliation script for R2 objects with no DB row.
- Bundle Firebase SW code locally (no origin-privileged `gstatic.com` import); add baseline security headers (CSP, nosniff, frame-ancestors, Permissions-Policy); stop returning raw `pipelineError` internals to the browser; trim stable-identifier logging in taste sync.
- **Gate:** deletion race test (posted-guard holds); orphan script proven on a seeded orphan; headers visible on live responses after deploy.

## T14 — Release gate: CI + tests [P1 gap]
**Evidence:** synthesis #10; N20; `.github/workflows/ci.yml`, `app/package.json:46-58`, `app/tests/push.test.ts:331-425`.

- Production-DB refusal guard in the DB-backed test bootstrap (refuse known prod hosts); scope push-test mutations to fixture creators only.
- CI runs: full typecheck, all pure Node suites, clip-service pytest, and the DB suites against a CI Postgres service. Failing tests fail the workflow.
- One Playwright happy path (signup → upload → accept → post sheet) runnable locally; declare it as `audit.e2e` in the registry so future audits get host evidence.
- Pin yt-dlp; validate `OPENAI_API_KEY` + `MINDS_*` at boot (crash early, not mid-pipeline as a creator-visible failure); move the hardcoded steward Gmail to env.
- **Gate:** CI red on an intentionally broken test then green on revert; `AUDIT_E2E` declaration proven by a fresh dry-run audit picking it up.

## T15 — Housekeeping + registry truth [P2/P3]
**Evidence:** Grok leg; K3 access-code items.

- Update registry entry `clipmind`: purpose (no Telegram, PWA in-app), `status: active`, note the Cloudflare Worker in the architecture line.
- **DECIDED 2026-08-14 (George): no Railway project token for now** — CLI personal login (`sinksanksunk23`) carries deploys. Registry stays `personal_login`, `token_ref` stays pending-by-choice. Revisit only if deploys need to run where the CLI session is absent.
- `.gitignore` the `t13/`–`t29/` evidence dirs (or relocate to the audit vault); chmod `app/.env` to 0600; mixed cache dirs ignored.
- Access-code hardening within jam scope: route-level rate limiting on login; document that codes are plaintext-by-design for the jam (or hash if trivial).
- Verify GitHub auth/branch protection/committer identity (audit left these Unverified).
- **Gate:** `git status` clean of evidence dirs; ruby psych parse green after the registry edit; login endpoint rate-limit test.

---

## Deferred items (log here during the loop, do not do them)

- Access-code hashing + server session ids (plaintext documented as jam decision, revisit pre-public-launch)
- Media presigning (public-by-link recorded as jam decision)
- Branch protection (plan-gated: private repo on Free org needs GitHub Pro or public)
- Full-pipeline E2E in CI (upload/clip-service/Minds/OpenAI deliberately excluded from the Playwright smoke)

## Scorecard (closed 2026-08-14)

- Planned tickets: 15 (T1–T15)
- Shipped: 15 (100%), PRs #72–#86, every ticket deployed to Railway same-day
- Loop iterations: 15 productive turns (one Codex leg per ticket T1–T14, T15 built by the loop driver; plus live proofs: T4 prod pause/resume, T6 120MB direct-R2 upload, T8 karaoke frame check, T13 CSP browser pass)
- Reworked/reopened: 0 tickets reopened; 5 defects caught and fixed during blind verification before merge (T1 P2002-inside-transaction poisoning the tick, T3 guard-message regex, T5 cookie roll unreachable by normal activity, T13 CSP missing the presigned-sources origin which would have killed preview playback AND multipart uploads, T14 strict-mode locator + 10 ruff findings)
- Human unblocks needed: 0 (one environmental stall: a 1h+ network outage wedged a background railway CLI verifier that had no timeout; Codex leg survived on retries)
- Post-sprint defects: none known yet; George phone pass still owed
- Wall clock: opened ~10:45, closed ~17:45 (+07), ~7h including the outage
- Lessons → loop-food system note: (1) pre-create the branch for Codex legs — the sandbox cannot write .git and a branch-first instruction stalls the whole leg; (2) Codex sandbox also cannot reach localhost TCP — DB suites are ALWAYS the operator's verification half; (3) never run railway CLI in a background verifier without a hard timeout; (4) blind verification earns its cost — 5 pre-merge catches this sprint, two of them prod-breaking.

## Loop lessons carried in (from Agefall sprint-0)

1. `codex exec` MUST be backgrounded with `< /dev/null`.
2. Do not pace active build work with ScheduleWakeup; work inline, wakeups only for genuine external waits.
3. Check report SIZE and diffs, never exit codes.
4. `gh pr ready` before merge; draft-merge silently fails.
5. DB suites need a scratch database; never point them at prod (this sprint fixes the guard in T14, but honour it manually from T1).
