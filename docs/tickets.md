# ClipMind — First tickets (Week 1)

Bounded tickets toward the thin vertical slice: **one video in, one clip out with baked-in subtitles and a voice caption.** Read `AGENTS.md` before starting any of these. Each ticket: stay in scope, read before you change, branch off `main`.

Order: **T0 first (it gates the architecture).** T1 and T3 can run in parallel (different languages, different people). T2 depends on T1. T4 depends on T0 and T1.

---

## T0 — Validate Minds does what we assume (spike) [BLOCKER, do first]
**Owner hint:** whoever takes the Mind. **Depends on:** a free Mind on Hello Minds.

**Goal:** confirm the three assumptions the whole architecture rests on, before we build on them.

**Do:**
- Stand up a Mind via `@animocabrands/minds-cli`. Store a Tenet, read it back in a new session (persistence works).
- Get `HTTP_Execute` to call a dummy public endpoint (e.g. our clip-service `/health` exposed via a tunnel) and return the response.
- Note the exact ergonomics of pinning a base URL + token auth (Connections).

**Acceptance:** a short findings note at `docs/minds-validation.md` answering: does Tenet memory persist, can the Mind call our HTTP endpoint, how is the token stored. If any answer is no, flag it, that changes the plan.

**Out of scope:** building real Skills or captions yet.

---

## T1 — Clip service: transcribe + candidate detection
**Owner hint:** Python dev. **Depends on:** nothing (clip-service skeleton exists).

**Goal:** given a video, return candidate clip windows.

**Do:**
- `POST /candidates` (token-gated): accept a video file or URL.
- Transcribe with the Whisper API (word/segment timestamps).
- Generate candidate windows from (a) transcript hooks and (b) ffmpeg loudness/energy spikes (the one cheap audio signal).
- Return candidates as JSON: start/end ms, transcript span, why-flagged.

**Acceptance:** posting a sample video returns a list of candidate windows with timestamps and transcript text.

**Out of scope:** cutting, subtitle burn-in, GPU/vision/face signals, ranking (the Mind ranks).

---

## T2 — Clip service: cut + subtitle burn-in
**Owner hint:** Python dev. **Depends on:** T1.

**Goal:** render a finished clip from a chosen window.

**Do:**
- `POST /cut` (token-gated): accept video + window (+ optional trim offsets) + a caption-style preset.
- Cut to 9:16, burn in subtitles from the transcript using the preset (font, size, position, colour, one highlight style).
- Return the rendered mp4.

**Acceptance:** posting a window returns a 9:16 mp4 with baked-in subtitles matching the preset.

**Out of scope:** multiple animation styles, a full caption editor (curated presets only).

---

## T3 — App + DB: schema live, one creator
**Owner hint:** TS dev. **Depends on:** nothing (Prisma schema exists).

**Goal:** the data layer runs (build order: config then data before anything else).

**Do:**
- Stand up Postgres (local for dev; Railway volume-backed later).
- `prisma migrate` to create the schema. Verify the connection.
- Create and read one Creator through the backend (no UI yet).

**Acceptance:** `prisma migrate` applies cleanly; a Creator row can be created and read via a backend call.

**Out of scope:** UI, onboarding logic, scheduling.

---

## T4 — App: creator onboarding + first Tenets
**Owner hint:** TS dev + Mind owner. **Depends on:** T0, T1, T3.

**Goal:** onboard a creator into a Mind with an initial voice profile.

**Do:**
- Accept a channel URL (or a few uploads).
- Pull their content, transcribe (reuse T1's transcribe path), weight existing clips highest.
- Create the creator's Mind and distil an initial voice Tenet set.
- Store `mindId` on the Creator.

**Acceptance:** onboarding a creator produces a Mind whose Tenets reflect their voice, linked to the Creator row.

**Out of scope:** caption generation, clip ranking (later tickets once onboarding works).

---

## After this batch (not yet ticketed)
Mind writes captions (voice + SEO) · Mind ranks candidates · in-app review (accept/reject + trim) · scheduling + rotation enforcement · FCM push · TWA-wrap to Play internal testing.
