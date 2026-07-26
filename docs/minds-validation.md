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

## Finding 2: HTTP_Execute works, GET and JSON POST (Test 2 PASS)
- **GET** `https://api.github.com/zen` returned a real quote ("Approachable is better than simple"). Outbound GET confirmed. No manual Bazaar equip was needed, the Mind ran it directly.
- **POST** `https://httpbin.org/post` with body `{"video":"test","creator":"gitmgg"}` came back echoed under `"json": {"creator":"gitmgg","video":"test"}` with `Content-Type: application/json`. This proves the Mind sends real structured JSON POST bodies, exactly the shape our clip service expects (`POST /candidates`, `POST /cut`). Confirmed.
- **Not yet tested:** token/auth header storage (both test endpoints were public). Confirm when we first point `HTTP_Execute` at our token-gated clip service, using the `apiKeys` / Connections mechanism.

## T0 verdict: PASS — green light to build
All load-bearing assumptions held:
1. Persistent, structured, cross-thread memory works (Tenets / Covenants).
2. The Mind can call external HTTP endpoints (GET and JSON POST).

The architecture stands: a deterministic backend drives a headless Mind, the Mind holds voice as Tenets and reaches our services via `HTTP_Execute`. One minor item remains for later, token-auth storage, validated when the real clip service is wired. Proceed to T1 (clip service) and T3 (app/DB).
