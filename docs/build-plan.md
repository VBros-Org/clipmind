# ClipMind Build Plan

**Team:** George, Mos, Felix
**Event:** Creative Minds Jam #1 (Minds by Animoca Brands, organised by SANDchain)
**Created:** 2026-07-26
**Key dates:** DoraHacks registration opens 07-28 · HK kickoff 07-30 · submission deadline 08-28 · winners September
**Prize:** US$10k pool + Minds Investment Programme consideration

---

## 1. What we're building

A single app (a web-based PWA, TWA-wrapped onto Google Play internal testing for the jam so judges install it as a real app) that turns a creator's long-form video into ready-to-post short clips, each with subtitles burned in and a platform-optimised caption written in the creator's own voice. A persistent Minds agent holds the creator's voice and clip taste and gets better the more they use it. Posting stays a human tap (deliberate). The app replaces a fragmented multi-tool workflow with one loop.

## 2. Core principle (read this first)

**The deterministic backend is the boss. The Mind is a headless cognitive service the backend calls.**

We do not hand the Mind any reliability-critical control flow. Sequencing, dedup, rotation fairness, retries, scheduling execution, and push delivery stay as deterministic code, the same architecture George already trusts on the tower. The Mind is called, server-side, only for the things an LLM with persistent memory is genuinely better at:

1. Holding the creator's voice and clip taste as persistent memory (Tenets).
2. Writing post captions in that voice with per-platform SEO.
3. Ranking candidate clip moments against what this creator actually clips.

The Mind never owns the control flow and never faces the user. It is still integral: the persistent voice memory and caption judgment is the product's whole reason to exist, and it is what lets the system self-onboard any creator instead of being hand-tuned for one person.

## 2b. Shared conventions, stack, and agent rules

The enforceable version of this lives in [`AGENTS.md`](../AGENTS.md) at the repo root, plus a thin [`CLAUDE.md`](../CLAUDE.md). **Every AI agent working the project (George's, Mos's, Felix's) reads these when the repo is cloned, so all three teams build the same way.** Keep them in every ClipMind repo.

Summary of what they enforce:

- **Stack (locked):** app + backend + Minds glue = TypeScript / Next.js / Node 22+. Minds integration = `minds-cli` + `minds-client-lib` (no Python SDK exists). Clip service = Python 3.12 / FastAPI / ffmpeg / Whisper API, stateless. DB = Postgres on Railway, volume-backed, owned by the TS backend only. Push = FCM. Deploy = Railway, one service per component. Two languages only (TS + Python), do not add a third.
- **Build order:** config → data → core → interface → integration. Verify each layer before the next. No mock data in UI/handlers, no orphan code, no copying janky patterns. Thin vertical slices first.
- **Discipline:** verify before claiming, read before changing, never trust a piped test's exit code, tests pass before "done".
- **Git:** org `VBros-Org` (repo `git@github.com:VBros-Org/clipmind.git`), github.com SSH, branch not default, no secrets committed, no backticks in `-m` messages.
- **Deploy:** Railway project tokens (no `railway login`), volume-backed Postgres, explicit `--service`.
- **Copy:** no em dashes, no AI-slop tells, in any user- or judge-facing text.
- **Jam invariant:** the Mind stays integral, not cosmetic.

## 3. The corpus is the engine

Nothing good happens without the corpus. It drives both clip selection and captions.

- **Why:** you cannot pick the right moments or write in the creator's voice without knowing how they talk and what they clip.
- **Best source, in priority order:** (1) the creator's existing posted clips (gold: self-labelled proof of both voice and what they deem clippable), (2) full streams/VODs for context and voice, (3) long-form transcripts as fallback.
- **Where it lives:** distilled into the Mind's Tenets (persistent per-creator memory). It grows as the creator accepts/rejects and posts more.
- **Cold start:** a new creator with few clips falls back to long-form transcripts for voice and generic clippable heuristics for moment-picking, and sharpens as they use the app. This is the persistence story the judges reward.

## 4. End-to-end flow

Tagged by who does the work: **[H]** human, **[M]** Mind, **[S]** deterministic service/backend.

0. **Onboard / tone builder** [S ingest + M]: creator connects their own channel. We pull their content (existing clips weighted highest), transcribe, and the Mind distils voice + clip taste into Tenets.
1. **Upload long-form** [H]: creator uploads a video to clip.
2. **Clip + caption** [S + M]: the clip service transcribes (Whisper) and finds candidate windows from speech + cheap audio spikes (loudness, shouts, laughter). The Mind ranks candidates by the creator's taste. The service cuts each pick, burns in styled subtitles, and the Mind writes the SEO post-caption in voice. Output: finished clips, subtitles baked in, post-copy attached.
3. **Review + score in-app** [H]: a doomscroll review (like the Ken clips viewer, but in-app). Per clip: **Accept** (mark for posting) or **Reject**. Optional **light trim** (top and tail only, because the clipper is not tight yet). No external editing, no download. Accept/reject feeds the Mind's learning.
4. **Schedule** [H sets, S enforces]: creator picks post times and rotation order. The backend enforces it deterministically (George's proven rotation/sequencing/dedup). The Mind may suggest an order, but the human sets it and the code owns it.
5. **Notify + serve + post** [S push, H posts]: at the scheduled time the app pushes a notification, serves the finished clip + post-copy, the creator taps to upload to the platform, then confirms posted. Posting stays human (the durability win).

This removes the old external-edit detour (old Parts 3 and 4) because subtitles are baked in.

## 5. Components + suggested ownership

Allocation is a suggestion, adjust to Mos's and Felix's strengths.

| # | Component | Stack | Suggested owner |
|---|---|---|---|
| A | Clip service (transcribe, candidate detection, cut, subtitle burn-in) | Python, ffmpeg, Whisper API | strongest Python dev |
| B | Minds integration (Tenets, caption gen + SEO, clip ranking, corpus distil) | TS, minds-cli / minds-client-lib | whoever takes the Mind |
| C | App + backend (review UI, trim, scheduling, push, state machine = the boss) | PWA front-end + backend | front-end + backend dev |
| D | Corpus ingest / tone builder | Python or TS | shared with A or B |

- **Claude (design pane):** specs, bounded tickets, review. Produces this doc and the API contracts.
- **Codex (build pane):** accelerates coding under bounded tickets.
- **George:** direction, judgment, the manual GitHub-org step, final scope calls.

## 6. Clip service spec (component A)

Stateless HTTP service, token-gated, called by the Mind via `HTTP_Execute` and by the backend directly.

- **In:** a video (or URL), creator id.
- **Steps:** transcribe with Whisper (timestamps) → generate candidate windows from (a) transcript hooks and (b) cheap audio signals: loudness spikes, shout spikes, laughter. No GPU, no face tracking, no game vision (that stays on the tower). → return candidates with timestamps + transcript spans.
- **Cut step:** given approved picks, cut each to 9:16, burn in subtitles from the transcript **using the creator's caption-style preset** (see below), return the rendered clip.
- **Out:** candidate list (for the Mind to rank) and, on request, rendered clips.
- **No learned-weight fusion.** Ranking is the Mind's job (corpus taste). The service just surfaces candidates and cuts.

### Caption styling (burned-in subtitles)

Because we auto-burn the subtitles, we own how they look, so the creator must be able to choose. This is deterministic config (a preset), not Mind judgment.

- **Options:** font, size, colour, outline/shadow, position (safe-zone aware), max words per line, and highlight style (static, or word-by-word karaoke pop). Start with 3 to 4 curated presets plus a few adjustable knobs, not an infinite editor.
- **Where it is set:** in-app during onboarding and editable any time, with a live preview on a sample clip before applying.
- **Where it lives:** stored per creator in their profile (`creators.caption_style`), passed to the clip service on every cut. Not in the Mind (it is config, not voice).
- **Scope guard:** curated presets for the jam. A full type/animation editor is fast-follow.

## 7. Mind spec (component B)

Headless, called server-side via the Builder API.

**Rule: one Mind per creator, product logic stays in the backend.** Each creator gets their own Mind (their voice and taste), created programmatically at onboarding (T4), never one shared brain. The product logic (how to write a caption, the SEO rules, the ranking method, the ClipMind workflow) lives in the backend prompts, versioned in this repo, not typed into any Mind as Tenets. Tenets hold only the creator's voice and taste. This keeps the product logic identical across every creator's Mind and under backend control.

- **Tenets (persistent memory):** voice profile (sentence structure, phrasing, hooks) + clip-taste profile (what this creator clips) + guardrails. Built from the corpus, updated by accept/reject.
- **Caption generation:** writes the post-copy in the creator's voice, then applies a per-platform SEO layer (YouTube, TikTok, Instagram: keyword and hook conventions, length norms, hashtags). Reuse the anti-slop and platform-safety rules from streamer-pipeline.
- **Clip ranking:** reads candidate transcript spans, ranks by corpus taste, returns the picks. Judgment, human-reviewed in step 3, so variance is safe.
- **Two different "captions", keep them distinct:** burned-in subtitles (on-screen, from transcript, styled by the service) vs post-copy (the platform caption/title/hashtags, written by the Mind).

## 8. Corpus ingest / tone builder (component D)

- Creator connects their own channel (their content, with permission, no scraping of others).
- Pull existing clips first, then streams, then long-form.
- Transcribe, distil into the Mind's Tenets.
- Re-runs and grows as the creator accepts/rejects and posts.

## 9. Review, scoring, trim (part of component C)

- In-app doomscroll of finished clips (baked-in subtitles).
- Per clip: **Accept** = mark "will be posted" (enters the posting queue) / **Reject** = won't.
- **Light trim only:** adjust start/end (top and tail). Not a full editor. No external download.
- Accept/reject is also the learning signal into the Mind's taste (reuses George's proven Ken-grade-to-weights pattern).

## 10. Scheduling + posting (part of component C)

- Human sets post times and rotation order.
- Backend enforces deterministically: rotation fairness (least-recently-served), strict no-dup, retries, dead-letter. Port the proven logic from streamer-pipeline.
- Web push (FCM + service worker) fires the "time to post" nudge in-app.
- Human uploads to the platform and confirms posted. No auto-posting.

## 11. Data model sketch

- `creators` (id, connected channel, Tenets/Mind id)
- `videos` (uploaded long-form, per creator)
- `clips` (source video, timestamps, rendered file, subtitle status, post-copy, **status: candidate | accepted | rejected | scheduled | posted**, trim offsets)
- `schedule` (creator, slot times, rotation state)
- `learning_events` (accept/reject, feeds the Mind)

State machine on `clips.status`, deterministic, in the backend.

## 12. Scope: in for the jam vs fast-follow

**In (the winnable loop):** onboarding/corpus → upload → clip (speech + audio spikes) → subtitle burn-in → Mind caption → in-app review (accept/reject + trim) → human-set schedule → push → human post. Mind visibly central (voice memory + captions + ranking).

**Also in, cheap because George's pipeline exists:** TWA-wrap the finished PWA and push **one** build to the Google Play **internal testing track**, then add the judges as internal testers so they install it as a real app. Internal testing is near-instant (no review delay, up to 100 testers). This rides George's existing apps-reps Play account and keystore, so it is a thin final step George owns, not a parallel build. The web PWA is still the real deliverable; the wrap adds nothing to the dev work.

**Fast-follow (not on the jam critical path):**
- A full public Play listing and a dedicated ClipMind Play account (the jam build rides George's personal account; a proper business account is a separate later track).
- GPU signal suite (vision/face/pitch) from the tower.
- Full editing suite and full caption-style editor.
- Mind-proposed scheduling as default.

## 13. Timeline (4 weeks)

- **Now to 07-28:** finalise specs and tickets; GitHub org `VBros-Org` created (done 07-26), George adds Mos + Felix as members; each of us stands up a free Mind on Hello Minds to learn the platform.
- **07-28 to 07-30:** register the team on DoraHacks; confirm exact submission artifacts from the event page (demo video, repo, writeup); week-1 validations (section 14).
- **Week 1 (to ~08-03):** clip service candidate + cut + subtitle burn-in; Mind caption in voice; backend skeleton + data model. Thin vertical slice: one video → one clip with subtitles + caption.
- **Week 2 (to ~08-10):** corpus ingest → Tenets; Mind clip ranking; in-app review + trim; accept/reject learning loop.
- **Week 3 (to ~08-17):** scheduling + rotation enforcement; web push; end-to-end on a real creator (George first).
- **Week 4 (to 08-28):** polish, demo video, writeup, submit. **George wraps the PWA as a TWA and pushes one build to Play internal testing, adds the judges as testers.** Buffer for BETA-platform surprises.

## 14. Risks + week-1 validations

- **Minds BETA memory reliability:** validate Tenets as a durable per-creator store early. If flaky, keep our own store and use the Mind purely for generation. Cheap hedge.
- **`HTTP_Execute` ergonomics:** confirm how a Mind pins a self-hosted base URL + token auth (Connections). Established via the conversational Skill-builder, not a documented REST config. Validate day one.
- **Subtitle burn-in quality:** auto-captions can look janky. Test the render early since it is the edit-elimination feature.
- **FCM web push in a PWA:** real setup, budget it.
- **Timeline:** 4 weeks on a new platform is aggressive. The cut line in section 12 protects the win.

## 15. Immediate next actions

1. **George:** GitHub org `VBros-Org` created (done). Add Mos + Felix as members.
2. **All three:** set up a free Mind on Hello Minds this week to learn the platform.
3. **Claude:** turn sections 6 to 10 into bounded build tickets once the org exists.
4. **07-28:** register the team on DoraHacks the moment it opens; confirm submission artifacts.
5. **Week 1:** run the three validations in section 14 before committing hard to the architecture.
