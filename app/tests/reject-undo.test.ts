import test from "node:test";
import assert from "node:assert/strict";

import {
  RejectUndoTimer,
  type RejectUndoCommitCause,
} from "../lib/reject-undo";

test("reject undo timer exposes the countdown and undo prevents commit", () => {
  const timers = fakeTimers();
  const commits: { clipId: string; cause: RejectUndoCommitCause }[] = [];
  const undo = new RejectUndoTimer({
    windowMs: 6_000,
    now: timers.now,
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    commit(clipId, cause) {
      commits.push({ clipId, cause });
    },
  });

  const snapshot = undo.start("clip-1");
  assert.equal(snapshot.remainingMs, 6_000);

  timers.advance(2_500);
  assert.equal(undo.snapshot("clip-1")?.remainingMs, 3_500);
  assert.equal(undo.undo("clip-1"), true);
  timers.runNext();

  assert.deepEqual(commits, []);
  assert.equal(undo.snapshot("clip-1"), null);
});

test("reject undo timer commits when the window lapses", () => {
  const timers = fakeTimers();
  const commits: { clipId: string; cause: RejectUndoCommitCause }[] = [];
  const undo = new RejectUndoTimer({
    windowMs: 6_000,
    now: timers.now,
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    commit(clipId, cause) {
      commits.push({ clipId, cause });
    },
  });

  undo.start("clip-2");
  timers.advance(6_000);
  timers.runNext();

  assert.deepEqual(commits, [{ clipId: "clip-2", cause: "timer" }]);
  assert.equal(undo.snapshot("clip-2"), null);
});

test("reject undo timer commits pending rejects on background or navigation", () => {
  const timers = fakeTimers();
  const commits: { clipId: string; cause: RejectUndoCommitCause }[] = [];
  const undo = new RejectUndoTimer({
    windowMs: 6_000,
    now: timers.now,
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    commit(clipId, cause) {
      commits.push({ clipId, cause });
    },
  });

  undo.start("clip-3");
  undo.start("clip-4");

  assert.deepEqual(undo.commitAll("background"), ["clip-3", "clip-4"]);
  timers.runAll();

  assert.deepEqual(commits, [
    { clipId: "clip-3", cause: "background" },
    { clipId: "clip-4", cause: "background" },
  ]);
});

function fakeTimers() {
  let nowMs = 0;
  let nextId = 1;
  const timers: {
    id: number;
    handler: () => void;
    cleared: boolean;
  }[] = [];

  return {
    now() {
      return nowMs;
    },
    advance(ms: number) {
      nowMs += ms;
    },
    setTimeout(handler: () => void) {
      const id = nextId;
      nextId += 1;
      timers.push({
        id,
        handler,
        cleared: false,
      });
      return id;
    },
    clearTimeout(id: unknown) {
      const timer = timers.find((item) => item.id === Number(id));
      if (timer) {
        timer.cleared = true;
      }
    },
    runNext() {
      const timer = timers.find((item) => !item.cleared);
      if (timer) {
        timer.cleared = true;
        timer.handler();
      }
    },
    runAll() {
      for (const timer of timers.filter((item) => !item.cleared)) {
        timer.cleared = true;
        timer.handler();
      }
    },
  };
}
