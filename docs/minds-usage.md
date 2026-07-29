# Minds usage log

Running record of every place ClipMind uses Minds: in the product, and in building the
product. Kept for the Creative Minds Jam "Minds Integration Depth" criterion and for
ourselves. Add new entries at the bottom of the relevant section, with a date and, where
possible, the conversation alias or Mind id so it is verifiable on the platform.

Team habit: when you use a Mind for anything (product path, a build question in the chat
window on hellominds.ai, testing), log it here in the same PR or a follow-up docs PR.

## 1. Where the Mind is integral to the product

Every creator gets their own Mind, created programmatically at onboarding. The Mind is
the product's memory and judgment; the deterministic backend owns all control flow.

| Surface | What the Mind does | Code | Evidence |
|---|---|---|---|
| Onboarding | Creator's corpus is distilled into a voice + clip-taste profile and seeded into the Mind as persistent Tenets (covenant clipmind.creatorVoiceAndClipTaste.v1); verified by asking the Mind to recite from a second conversation | lib/onboarding.ts, lib/minds.ts, prompts/tenet-seed | PR #12, #42; conversation aliases clipmind-onboarding-*, clipmind-verify-* |
| Ranking | The Mind ranks candidate clips by that creator's remembered taste and explains each pick in its own words | lib/ranking.ts, prompts/rank-clips | PR #20 (live output: rank reasons citing seeded signature beats); aliases clipmind-rank-* |
| Captions | The Mind writes per-platform post-copy in the creator's remembered voice; backend applies platform norms deterministically | lib/captioning.ts, prompts/caption-clip | PR #22 (live variants echoing Tenet phrasing habits); aliases clipmind-caption-* |
| Persistence proof | Same Mind, different conversations, days apart: Tenets recalled and applied without re-teaching. This is the jam's memory/continuity requirement demonstrated in production paths | docs/minds-validation.md | T0 findings 2026-07-26; T4 live proof 07-27; T8/T9 live proofs 07-28 |

Autonomous follow-up (third jam requirement): the scheduler computes posting slots and
the nudge system (Home cards now, push next) acts on the creator without prompting.
The Mind's judgments (ranks, captions) are what those nudges deliver.

## 2. Where Minds shaped the build

| Date | What | Verifiable trace |
|---|---|---|
| 2026-07-26 | T0 platform validation on the gitmgg dev Mind: proved cross-thread Tenet persistence and HTTP_Execute GET/JSON POST before we committed to the architecture. The green light for the whole design | docs/minds-validation.md; gitmgg Mind be35503e |
| 2026-07-26 | Observed live memory taxonomy (Covenants/invariants/lessons/apiKeys) differs from docs; architecture notes updated accordingly | docs/minds-validation.md finding 1 |
| 2026-07-27 | Builder API creation contract established empirically (one-click endpoint, no REST tenets endpoint, conversational seeding); this defined lib/minds.ts | PR #12 comments; probe Mind b926513e (disabled) |
| 2026-07-27 | Cognition economics discovered: API-created Minds receive no free grant; drove the invite-gated signup design (T17) and the jam boost request | Mind 4729513e balance -7.7; Telegram boost request 07-28 |
| 2026-07-28 | Live taste test: seeded profile vs four candidate transcripts; Mind ranked the flat inventory clip last, citing the profile's signature beats. Validated that per-creator taste genuinely drives ranking | PR #20 body; alias clipmind-rank-* on gitmgg |
| 2026-07-28 | Caption platform-differentiation iteration: Mind output showed TikTok/IG collapse, fixed in product prompt caption-clip-v2 with deterministic guards. The Mind's real outputs drove the prompt design | PR #22 body + commits |

## 3. Conversations on the platform

API-driven conversations live on each Mind under these alias patterns and are
inspectable via the messaging history endpoint (and by the Minds team platform-side):
clipmind-onboarding-<mind>, clipmind-verify-<mind>, clipmind-rank-<video>,
clipmind-caption-<clip>.

Direct chat-window sessions with the gitmgg Mind (hellominds.ai) also count as build
usage; log them here with date + topic when they happen.

## 4. Log new entries below

- 2026-07-29: this log created and backfilled from PR history.
- 2026-07-29: jam cognition boost received on the gitmgg Mind (+~630 staged credits, swarm 96 -> 725) following the 07-28 Telegram request. Unblocks liberal Mind usage for the taste-feedback build and demo recording.
