# Working notes

Running team notes. Not polished, kept honest. Roughly newest first.

## Platform notes (Minds)

- Mind replies take minutes, not seconds. This forced the async design early:
  DB-backed pipeline stages, polling UIs, push-when-ready. Honestly a better
  product for it. The agent is slow; the app never feels stuck.
- Minds created through the Builder API are born with zero cognition. Only
  UI-created Minds get the free grant. We never found an API to fund a newborn
  Mind (probed for transfer endpoints, all 404; Mind-to-Mind MENTE transfers
  were reported broken in the builders chat when we looked at that route).
  This is the single biggest blocker to open signup: every new creator Mind
  needs someone to fund it. Our stopgap is invite gating, so Mind births are
  deliberate and we fund what we create.
- The jam cognition boost lands as a staged pool that releases daily (~700/day
  observed). Works for one funded Mind, does not scale to many creators yet.
- No REST endpoint for tenets. Seeding memory happens through conversation
  messages, then we verify by asking again from a second, fresh conversation.
  Feels odd at first. Actually fits the "memory, not config" model.
- New platform behavior: Minds now email their steward on creation. Found out
  when a test Mind woke up and emailed George.

## Voice and taste notes

- Voice distillation weights real posted clips above everything else, because
  the creator already chose those moments. We learned this the hard way: our
  seeded test clips outvoted George's real captions until we purged the test
  videos and re-taught. Evidence quality beats evidence volume.
- The caption conventions in ClipMind are ported from the pipeline George runs
  daily for real streamer clipping, so they are proven on live posting, not
  invented for the jam. That production pipeline still does more per clip than
  ClipMind does today (heavier packaging and editing steps we have not ported
  yet). Porting the rest is the roadmap, below.

## Once the Mind has learned enough (roadmap sketch)

- Analytics loop: pull per-platform post performance and feed wins and losses
  back as taste verdicts, so the Mind learns from the audience, not only from
  the creator's accept/reject.
- Port the remaining production packaging steps: stronger hook editing, richer
  burn-in styles, pack-based batching.
- Creator-funded cognition wallets. Mind-to-Mind seeding from a treasury Mind
  if transfers land platform-side.
- Light trim and caption preset editing in Review. Was on the build plan, cut
  to hold the jam deadline.

## Ops notes

- Whisper whole-file transcription caps out around 30-35 minutes of audio.
  Keep sources under that for now; chunking is on the list.
- yt-dlp from the server is intermittently blocked by YouTube. The channel
  pull degrades to "paste captions" on purpose rather than pretending.
