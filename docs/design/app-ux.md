# ClipMind app UX spec v1 (2026-07-28)

Owner: George set the page split; this spec makes it concrete. The previous layout was a
generic auto-generated dashboard; this replaces it. Mobile-first PWA, thumb-first, dark.
Every visible string follows AGENTS.md section 7 (plain, direct, no em dashes, no slop).

## The product feeling

This is a tool a streamer opens between matches, half-distracted, one thumb. It is not a
SaaS admin panel. Content is the interface: video frames, big numbers, chunky buttons.
If a screen would look fine in a B2B analytics product, it is wrong.

## Navigation: 4 tabs, bottom bar

Fixed bottom tab bar (safe-area aware, 56px + inset), icons + 11px labels:

1. **Home** (house) - runway + nudges
2. **Upload** (plus-in-circle) - feed the machine
3. **Review** (stack) - judge clips; badge shows clips awaiting review
4. **Rhythm** (clock) - posting cadence + nudge timing

No hamburger, no sidebar, no top nav. Login stays a standalone page. The landing page
(logged out) is unchanged.

## Page 1: Home

Top to bottom:

- **Runway hero.** One huge number with unit: days of posts left, computed as
  (accepted + scheduled unposted clips) / slots per day from the creator's Schedule.
  72px numeral, label under it: "days of posts left". Color states: >=5 days calm
  (accent), 2-4 days amber, <2 days red. If no schedule set: show clip count instead
  with a line "set your rhythm to see runway" linking to Rhythm.
- **Next up.** The next scheduled clip: thumbnail (frame from renderedUrl if present),
  scheduled time in the creator's local time, platform captions ready indicator.
- **Nudge cards.** Vertical stack, max 3, dismissible, each one action:
  - "N clips waiting for review" -> Review tab
  - "Runway under N days. Upload something long." -> Upload tab
  - "Clip scheduled for HH:MM is ready. Post it now." -> opens the clip with captions
  These are the same nudges FCM push will send later; Home is their in-app surface.
- **Quiet footer stat row.** Total posted, total clips made. Small, one line, muted.

## Page 2: Upload

- One dominant action: a full-width drop-zone card, "Add a long video". Tap = file
  picker (accept video/*). Under it, a one-line explainer: "ClipMind finds the moments,
  ranks them by your taste, and writes your captions."
- On pick: upload with a REAL progress bar (big files on phone networks; show percent
  and MB). Then processing states as a vertical checklist that ticks live:
  uploaded -> transcribing -> finding moments -> ranking (your Mind) -> captions.
  Poll a status endpoint; each state has a plain one-liner. The user can leave; state
  survives (it is DB-backed).
- Recent uploads list below: last 3 videos with their status chip.
- Failure state: named step failed + one retry button. Never a bare error code.

## Page 3: Review

Keep the working flow, restyle to cards that lead with video:

- Video groups collapse to a horizontal strip of clip cards. Each card: 9:16 thumbnail
  (or first-frame canvas of the preview window), rank badge top-left ("1"), duration
  chip, one-line reason from the Mind (truncate 2 lines).
- Tap card -> full-screen review sheet: video player fills width (16:9 source preview
  seeked to the window, or the rendered 9:16 when it exists), transcript line, the
  Mind's reason in its own voice-y quote block, then two thumb-reach buttons:
  Accept (accent, left... actually right for right thumbs) / Pass (ghost). Under them
  the caption panel: three platform rows, each one-tap copy with a copied tick.
- Accepted clips show a rendering spinner chip until renderedUrl lands, then swap to
  the final. Rejected cards grey and collapse.
- Empty state: "No clips waiting. Upload something long." -> Upload tab.

## Page 4: Rhythm

- **Cadence.** Slots per day stepper (1-4) + anchor hour wheel. Live sentence preview:
  "2 posts a day, first at 10:00." Writes the Schedule row (T6 fields).
- **Nudges.** Toggle rows: review reminders, runway warnings (with threshold stepper),
  post-time nudges. These configure both Home cards and future FCM push.
- **Account.** Caption preset picker (the 3 presets, tiny preview strip), channel URL,
  log out. Small, bottom, one card.

## Sizing system (the "sizing is shit" fix)

All pages use these tokens; no ad-hoc values:

- Base font 17px. Scale: 12 (labels) / 14 (secondary) / 17 (body) / 22 (section) /
  28 (page title) / 72 (runway numeral). Line-height 1.4 body, 1.1 numerals.
- Touch targets minimum 48x48. Primary action buttons 56px tall, full-width minus
  16px gutters, 12px radius.
- Spacing scale 4/8/12/16/24/32. Page gutter 16px. Card padding 16px. Stack gap 12px.
- Cards: 16px radius, 1px border at 12% white, no shadows (dark theme).
- Bottom bar 56px + env(safe-area-inset-bottom); content bottom padding matches so
  nothing hides behind it. Top safe area: padding-top calc(12px + env(safe-area-inset-top)).
- Video thumbs: 9:16 at 104x184 in strips; hero next-up thumb 148x260.
- One accent color only (existing brand accent), used for: runway-healthy, primary
  buttons, active tab. Everything else is neutral. No gradients, no emoji in UI.

## What this is NOT

No charts, no KPI grids, no table views, no settings labyrinth, no onboarding carousel.
Four screens, one job each.
