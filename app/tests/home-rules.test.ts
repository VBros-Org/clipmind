import test from "node:test";
import assert from "node:assert/strict";

import { computeRunway, selectHomeNudges } from "../lib/home-rules";

test("computeRunway divides queued clips by slots per day", () => {
  assert.deepEqual(computeRunway(10, { slotsPerDay: 2 }), {
    kind: "ready",
    clipCount: 10,
    slotsPerDay: 2,
    days: 5,
    tone: "calm",
  });

  assert.deepEqual(computeRunway(7, { slotsPerDay: 2 }), {
    kind: "ready",
    clipCount: 7,
    slotsPerDay: 2,
    days: 3.5,
    tone: "amber",
  });

  assert.deepEqual(computeRunway(1, { slotsPerDay: 2 }), {
    kind: "ready",
    clipCount: 1,
    slotsPerDay: 2,
    days: 0.5,
    tone: "red",
  });
});

test("computeRunway falls back when schedule is missing or slots are zero", () => {
  assert.deepEqual(computeRunway(3, null), {
    kind: "needs_schedule",
    clipCount: 3,
    reason: "no_schedule",
  });

  assert.deepEqual(computeRunway(3, { slotsPerDay: 0 }), {
    kind: "needs_schedule",
    clipCount: 3,
    reason: "zero_slots",
  });
});

test("selectHomeNudges returns review runway and due-post cards", () => {
  const nudges = selectHomeNudges({
    reviewCount: 4,
    runway: computeRunway(1, { slotsPerDay: 2 }),
    dueClip: {
      clipId: "clip-1",
      timeLabel: "10:00",
      isDue: true,
    },
  });

  assert.deepEqual(
    nudges.map((nudge) => nudge.kind),
    ["review", "runway", "post"],
  );
  assert.equal(nudges[0].title, "4 clips waiting for review");
  assert.equal(nudges[1].title, "Runway under 2 days. Upload something long.");
  assert.equal(
    nudges[2].title,
    "Clip scheduled for 10:00 is ready. Post it now.",
  );
  assert.equal(nudges[2].href, "/home?post=clip-1");
});

test("selectHomeNudges skips inactive rules", () => {
  const nudges = selectHomeNudges({
    reviewCount: 0,
    runway: computeRunway(8, { slotsPerDay: 1 }),
    dueClip: {
      clipId: "clip-1",
      timeLabel: "10:00",
      isDue: false,
    },
  });

  assert.deepEqual(nudges, []);
});

test("selectHomeNudges respects nudge toggles and runway threshold", () => {
  assert.deepEqual(
    selectHomeNudges({
      reviewCount: 4,
      runway: computeRunway(1, { slotsPerDay: 2 }),
      dueClip: {
        clipId: "clip-1",
        timeLabel: "10:00",
        isDue: true,
      },
      reviewReminders: false,
      runwayWarnings: false,
      postTimeNudges: false,
    }),
    [],
  );

  const nudges = selectHomeNudges({
    reviewCount: 0,
    runway: computeRunway(7, { slotsPerDay: 2 }),
    dueClip: null,
    runwayWarningThresholdDays: 4,
  });

  assert.equal(nudges.length, 1);
  assert.equal(nudges[0]?.kind, "runway");
  assert.equal(nudges[0]?.title, "Runway under 4 days. Upload something long.");
});
