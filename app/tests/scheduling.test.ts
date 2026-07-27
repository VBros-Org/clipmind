import test from "node:test";
import assert from "node:assert/strict";

import {
  assertClipStatusTransition,
  computeNextSlot,
  pickNextClip,
  type ClipSchedulingStatus,
  type SchedulingClip,
  type SchedulingHistoryClip,
} from "../lib/scheduling";

const statuses: ClipSchedulingStatus[] = [
  "candidate",
  "accepted",
  "rejected",
  "scheduled",
  "posted",
];

test("pickNextClip rotates fairly across source videos", () => {
  const candidates = [
    clip("clip-a-1", "video-a", 1_000, 11_000, "2026-07-27T00:00:00.000Z"),
    clip("clip-a-2", "video-a", 12_000, 22_000, "2026-07-27T00:01:00.000Z"),
    clip("clip-b-1", "video-b", 2_000, 12_000, "2026-07-27T00:00:30.000Z"),
    clip("clip-b-2", "video-b", 13_000, 23_000, "2026-07-27T00:01:30.000Z"),
  ];
  const history: SchedulingHistoryClip[] = [];
  const picks: SchedulingClip[] = [];
  const servedTimes = [
    "2026-07-27T09:00:00.000Z",
    "2026-07-27T15:00:00.000Z",
    "2026-07-27T21:00:00.000Z",
    "2026-07-28T03:00:00.000Z",
  ];

  for (const servedTime of servedTimes) {
    const pick = pickNextClip(candidates, history);
    assert.ok(pick);
    picks.push(pick);
    history.push(historyFromPick(pick, servedTime));
  }

  assert.deepEqual(
    picks.map((pick) => pick.videoId),
    ["video-a", "video-b", "video-a", "video-b"],
  );
  assert.deepEqual(
    picks.map((pick) => pick.id),
    ["clip-a-1", "clip-b-1", "clip-a-2", "clip-b-2"],
  );
  assert.equal(pickNextClip(candidates, history), null);
});

test("pickNextClip dedups by clip id and source window", () => {
  const candidates = [
    clip("already-scheduled", "video-a", 1_000, 11_000, "2026-07-27T00:00:00.000Z"),
    clip("same-window", "video-b", 2_000, 12_000, "2026-07-27T00:01:00.000Z"),
    clip("unique", "video-b", 13_000, 23_000, "2026-07-27T00:02:00.000Z"),
  ];
  const history = [
    historyClip(
      "already-scheduled",
      "video-a",
      1_000,
      11_000,
      "scheduled",
      "2026-07-27T09:00:00.000Z",
    ),
    historyClip(
      "posted-duplicate-source-window",
      "video-b",
      2_000,
      12_000,
      "posted",
      "2026-07-27T10:00:00.000Z",
    ),
  ];

  assert.equal(pickNextClip(candidates, history)?.id, "unique");
});

test("pickNextClip never schedules candidate rejected scheduled or posted clips", () => {
  const candidates = [
    clip(
      "candidate-clip",
      "video-a",
      1_000,
      11_000,
      "2026-07-27T00:00:00.000Z",
      "candidate",
    ),
    clip(
      "rejected-clip",
      "video-a",
      12_000,
      22_000,
      "2026-07-27T00:01:00.000Z",
      "rejected",
    ),
    clip(
      "scheduled-clip",
      "video-b",
      2_000,
      12_000,
      "2026-07-27T00:02:00.000Z",
      "scheduled",
    ),
    clip(
      "posted-clip",
      "video-b",
      13_000,
      23_000,
      "2026-07-27T00:03:00.000Z",
      "posted",
    ),
    clip(
      "accepted-clip",
      "video-c",
      3_000,
      13_000,
      "2026-07-27T00:04:00.000Z",
    ),
  ];

  assert.equal(pickNextClip(candidates, [])?.id, "accepted-clip");
});

test("clip status transition guard accepts only the scheduling state machine path", () => {
  const allowed = new Set(["accepted->scheduled", "scheduled->posted"]);

  for (const from of statuses) {
    for (const to of statuses) {
      const key = `${from}->${to}`;
      if (allowed.has(key)) {
        assert.doesNotThrow(() => assertClipStatusTransition(from, to));
      } else {
        assert.throws(
          () => assertClipStatusTransition(from, to),
          /Invalid clip status transition/,
        );
      }
    }
  }
});

test("computeNextSlot uses even UTC spacing from the fixed anchor", () => {
  assert.equal(
    computeNextSlot(
      { slotsPerDay: 4, lastScheduledAt: null },
      date("2026-07-27T08:00:00.000Z"),
    ).toISOString(),
    "2026-07-27T09:00:00.000Z",
  );
  assert.equal(
    computeNextSlot(
      {
        slotsPerDay: 4,
        lastScheduledAt: date("2026-07-27T09:00:00.000Z"),
      },
      date("2026-07-27T08:01:00.000Z"),
    ).toISOString(),
    "2026-07-27T15:00:00.000Z",
  );
  assert.equal(
    computeNextSlot(
      {
        slotsPerDay: 4,
        lastScheduledAt: date("2026-07-27T21:00:00.000Z"),
      },
      date("2026-07-27T21:00:00.000Z"),
    ).toISOString(),
    "2026-07-28T03:00:00.000Z",
  );
  assert.equal(
    computeNextSlot(
      { slotsPerDay: 2, lastScheduledAt: null },
      date("2026-07-27T20:59:59.999Z"),
    ).toISOString(),
    "2026-07-27T21:00:00.000Z",
  );
  assert.throws(
    () =>
      computeNextSlot(
        { slotsPerDay: 0, lastScheduledAt: null },
        date("2026-07-27T08:00:00.000Z"),
      ),
    /slotsPerDay/,
  );
});

function clip(
  id: string,
  videoId: string,
  startMs: number,
  endMs: number,
  createdAt: string,
  status: ClipSchedulingStatus = "accepted",
): SchedulingClip {
  return {
    id,
    videoId,
    startMs,
    endMs,
    createdAt: date(createdAt),
    status,
  };
}

function historyFromPick(
  pick: SchedulingClip,
  scheduledFor: string,
): SchedulingHistoryClip {
  return historyClip(
    pick.id,
    pick.videoId,
    pick.startMs,
    pick.endMs,
    "scheduled",
    scheduledFor,
  );
}

function historyClip(
  id: string,
  videoId: string,
  startMs: number,
  endMs: number,
  status: "scheduled" | "posted",
  servedAt: string,
): SchedulingHistoryClip {
  return {
    id,
    videoId,
    startMs,
    endMs,
    createdAt: date("2026-07-27T00:00:00.000Z"),
    status,
    scheduledFor: status === "scheduled" ? date(servedAt) : null,
    postedAt: status === "posted" ? date(servedAt) : null,
  };
}

function date(value: string): Date {
  return new Date(value);
}
