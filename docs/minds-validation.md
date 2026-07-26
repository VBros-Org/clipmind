# T0 — Minds platform validation

Running findings from the T0 spike on the `gitmgg` dev Mind. Purpose: confirm the assumptions the ClipMind architecture rests on before we build. See `docs/tickets.md` T0.

## Finding 0: free credits work, but with a display bug
- A fresh Mind first showed **0 Cognition** and pushed a paid top-up screen; the advertised +200 free grant did not appear.
- After a refresh it corrected to **~201 credits**. So the free grant works but can lag and needs a reload. Do not assume credits are present the instant a Mind is created, relevant for real-creator onboarding.
- No payment required to run T0.

## Finding 1: persistent memory works (Test 1 PASS)
- Added a Tenet in one thread: "ClipMind captions are punchy, lowercase, and never use hashtags."
- In a **new thread**, "show me your current tenets" returned it, correctly attributed to the earlier thread. **Cross-thread persistence confirmed.**
- The Mind **auto-structured** the Tenet into a keyed entry: `clipmind_caption_style`.
- Live memory taxonomy observed: **Covenants** (the Tenets/rules), **invariants**, **lessons**, **apiKeys**. This differs from the docs' "Tenets = Invariants + Priors" wording. Note the dedicated **`apiKeys`** bucket, likely where our clip-service token would be stored.
- Cost: a few credits per exchange; 201 covers many T0 messages.

## Finding 2: HTTP_Execute + token storage (Test 2) — PENDING

## Implication so far
Persistent, structured memory (the product's core) is real. Proceed. Still to validate: outbound `HTTP_Execute` and how it stores a token.
