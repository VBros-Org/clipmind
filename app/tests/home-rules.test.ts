import test from "node:test";
import assert from "node:assert/strict";

import {
  computeDueNudges,
  computeRunway,
  selectHomeNudges,
  toHomeNudges,
} from "../lib/nudges";
import {
  consumePostedWin,
  postedWinMessage,
  storePostedWin,
  type PostedWinStorage,
} from "../lib/posted-win";
import { startOfCreatorLocalWeekUtc } from "../lib/timezone";
import { selectHomeUploadCards } from "../lib/home-upload-cards";

test("computeRunway divides queued clips by slots per day", () => {
  assert.deepEqual(computeRunway(10, { slotsPerDay: 2 }), {
    kind: "ready",
    clipCount: 10,
    slotsPerDay: 2,
    days: 5,
    tone: "calm",
  });

  assert.deepEqual(computeRunway(5, { slotsPerDay: 2 }), {
    kind: "ready",
    clipCount: 5,
    slotsPerDay: 2,
    days: 2.5,
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

test("computeRunway uses explicit slotTimes length when present", () => {
  assert.deepEqual(
    computeRunway(6, {
      slotsPerDay: 1,
      slotTimes: ["09:15", "13:30", "19:45"],
    }),
    {
      kind: "ready",
      clipCount: 6,
      slotsPerDay: 3,
      days: 2,
      tone: "red",
    },
  );
});

test("computeRunway treats zero runway as refill and keeps 1 to 2 days red", () => {
  assert.deepEqual(computeRunway(0, { slotsPerDay: 2 }), {
    kind: "ready",
    clipCount: 0,
    slotsPerDay: 2,
    days: 0,
    tone: "refill",
  });

  assert.equal(readyTone(computeRunway(1, { slotsPerDay: 1 })), "red");
  assert.equal(readyTone(computeRunway(2, { slotsPerDay: 1 })), "red");
  assert.equal(readyTone(computeRunway(5, { slotsPerDay: 1 })), "calm");
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

test("computeDueNudges projects to the same Home nudge cards", () => {
  const now = new Date(2026, 6, 29, 10, 5, 0);
  const scheduledFor = new Date(2026, 6, 29, 10, 0, 0);
  const due = computeDueNudges(
    {
      id: "creator-1",
      timezone: "Asia/Bangkok",
      reviewCount: 4,
      queuedClipCount: 1,
      schedule: {
        slotsPerDay: 2,
        reviewReminders: true,
        runwayWarnings: true,
        runwayThresholdDays: 2,
        postTimeNudges: true,
        pushNudges: true,
      },
      scheduledClips: [
        {
          id: "clip-1",
          scheduledFor,
          status: "scheduled",
        },
      ],
      failedVideos: [],
    },
    now,
  );

  assert.deepEqual(toHomeNudges(due), [
    {
      id: "review:4",
      kind: "review",
      title: "4 clips waiting for review",
      href: "/review",
      dismissal: "persistent",
    },
    {
      id: "runway:5:2",
      kind: "runway",
      title: "Runway under 2 days. Upload something long.",
      href: "/upload",
      dismissal: "persistent",
    },
    {
      id: "post:clip-1",
      kind: "post",
      title: "Clip scheduled for 10:00 is ready. Post it now.",
      href: "/home?post=clip-1",
      dismissal: "persistent",
    },
  ]);
  assert.deepEqual(
    due.map((nudge) => [nudge.kind, nudge.dedupeKey]),
    [
      ["review", "2026-07-29"],
      ["runway", "2026-07-29"],
      ["post", `clip-1:${scheduledFor.toISOString()}`],
    ],
  );
});

test("computeDueNudges uses creator-local date keys", () => {
  const due = computeDueNudges(
    {
      id: "creator-1",
      timezone: "America/Los_Angeles",
      reviewCount: 1,
      queuedClipCount: 0,
      schedule: {
        slotsPerDay: 1,
        reviewReminders: true,
        runwayWarnings: false,
        runwayThresholdDays: 2,
        postTimeNudges: false,
        pushNudges: true,
      },
      scheduledClips: [],
      failedVideos: [],
    },
    new Date("2026-07-27T06:30:00.000Z"),
  );

  assert.deepEqual(
    due.map((nudge) => [nudge.kind, nudge.dedupeKey]),
    [["review", "2026-07-26"]],
  );
});

test("post nudge copy uses creator timezone and omits missing time", () => {
  const due = computeDueNudges(
    {
      id: "creator-1",
      timezone: "Asia/Bangkok",
      reviewCount: 0,
      queuedClipCount: 1,
      schedule: {
        slotsPerDay: 1,
        reviewReminders: false,
        runwayWarnings: false,
        runwayThresholdDays: 2,
        postTimeNudges: true,
        pushNudges: true,
      },
      scheduledClips: [
        {
          id: "clip-bangkok",
          scheduledFor: new Date("2026-07-29T21:00:00.000Z"),
          status: "scheduled",
        },
      ],
      failedVideos: [],
    },
    new Date("2026-07-29T21:05:00.000Z"),
  );
  assert.equal(due[0]?.kind, "post");
  assert.equal(
    due[0]?.title,
    "Clip scheduled for 04:00 is ready. Post it now.",
  );
  assert.equal(due[0]?.notificationTitle, "Your 04:00 clip is ready to post");

  const fallback = computeDueNudges(
    {
      id: "creator-1",
      timezone: null,
      reviewCount: 0,
      queuedClipCount: 1,
      schedule: {
        slotsPerDay: 1,
        reviewReminders: false,
        runwayWarnings: false,
        runwayThresholdDays: 2,
        postTimeNudges: true,
        pushNudges: true,
      },
      scheduledClips: [
        {
          id: "clip-no-zone",
          scheduledFor: new Date("2026-07-29T21:00:00.000Z"),
          status: "scheduled",
        },
      ],
      failedVideos: [],
    },
    new Date("2026-07-29T21:05:00.000Z"),
  );

  assert.equal(fallback[0]?.title, "Clip is ready. Post it now.");
  assert.equal(fallback[0]?.notificationTitle, "Your clip is ready to post");
});

test("computeDueNudges emits failed upload nudges with video dedupe", () => {
  const due = computeDueNudges(
    {
      id: "creator-1",
      reviewCount: 0,
      queuedClipCount: 0,
      schedule: {
        slotsPerDay: 2,
        reviewReminders: false,
        runwayWarnings: false,
        runwayThresholdDays: 2,
        postTimeNudges: false,
        pushNudges: false,
      },
      scheduledClips: [],
      failedVideos: [
        {
          id: "video-1",
          pipelineStage: "failed",
          pipelineError: "captions: LLM call failed.",
          pipelineRetryGeneration: 3,
        },
        {
          id: "video-1",
          pipelineStage: "failed",
          pipelineError: "captions: LLM call failed.",
          pipelineRetryGeneration: 3,
        },
        {
          id: "video-2",
          pipelineStage: "ranking",
          pipelineError: null,
        },
      ],
    },
    new Date("2026-07-29T10:05:00.000Z"),
  );

  assert.equal(due.length, 1);
  assert.equal(due[0]?.kind, "failed");
  assert.equal(due[0]?.dedupeKey, "video-1:3");
  assert.equal(due[0]?.title, "Upload failed at captions. Tap to retry.");
  assert.equal(due[0]?.notificationTitle, "Upload failed at captions.");
  assert.equal(due[0]?.body, "Tap to retry.");
  assert.deepEqual(toHomeNudges(due), [
    {
      id: "failed:video-1",
      kind: "failed",
      title: "Upload failed at captions. Tap to retry.",
      href: "/upload",
      dismissal: "session",
    },
  ]);
});

test("computeDueNudges emits pipeline done nudges keyed by video", () => {
  const due = computeDueNudges(
    {
      id: "creator-1",
      reviewCount: 0,
      queuedClipCount: 0,
      schedule: {
        slotsPerDay: 2,
        reviewReminders: false,
        runwayWarnings: false,
        runwayThresholdDays: 2,
        postTimeNudges: false,
        pushNudges: true,
      },
      scheduledClips: [],
      doneVideos: [
        {
          id: "video-ready",
          pipelineStage: "done",
        },
      ],
    },
    new Date("2026-07-29T10:05:00.000Z"),
  );

  assert.equal(due.length, 1);
  assert.equal(due[0]?.kind, "pipeline_done");
  assert.equal(due[0]?.dedupeKey, "video-ready");
  assert.equal(due[0]?.href, "/review/video-ready");
});

test("selectHomeUploadCards keeps active videos and marks failures as danger", () => {
  assert.deepEqual(
    selectHomeUploadCards([
      {
        id: "video-processing",
        label: "Today",
        pipelineStage: "ranking",
        pipelineError: null,
      },
      {
        id: "video-failed",
        label: "Yesterday",
        pipelineStage: "failed",
        pipelineError: "transcribing: Whisper timed out.",
      },
      {
        id: "video-done",
        label: "Done",
        pipelineStage: "done",
        pipelineError: null,
      },
      {
        id: "video-legacy",
        label: "Legacy",
        pipelineStage: null,
        pipelineError: null,
      },
    ]),
    [
      {
        id: "video-processing",
        label: "Today",
        variant: "processing",
        title: "Ranking by your Mind",
        body: "usually a few minutes",
        href: "/upload",
      },
      {
        id: "video-failed",
        label: "Yesterday",
        variant: "failed",
        title: "Upload failed at transcribing.",
        body: "Tap to retry.",
        href: "/upload",
      },
    ],
  );
});

test("posted win storage is consumed once for navigation dismissal", () => {
  const storage = new MemoryStorage();
  storePostedWin(storage, 1);

  assert.deepEqual(consumePostedWin(storage), {
    postedThisWeek: 1,
  });
  assert.equal(consumePostedWin(storage), null);
  assert.equal(postedWinMessage(1), "Posted. 1 this week.");
});

test("startOfCreatorLocalWeekUtc returns Monday start in creator timezone", () => {
  assert.equal(
    startOfCreatorLocalWeekUtc(
      new Date("2026-07-27T08:00:00.000Z"),
      "America/Los_Angeles",
    ).toISOString(),
    "2026-07-27T07:00:00.000Z",
  );
});

class MemoryStorage implements PostedWinStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function readyTone(runway: ReturnType<typeof computeRunway>) {
  assert.equal(runway.kind, "ready");
  return runway.tone;
}
