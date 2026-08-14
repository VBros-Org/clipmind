import test from "node:test";
import assert from "node:assert/strict";

import {
  clipWindowDurationSeconds,
  clipWindowOffsetSeconds,
  clipWindowTimeFromOffsetSeconds,
  shouldSeekPreviewToStart,
} from "../lib/clip-preview-window";
import {
  formatMediaPreparationProgress,
  saveDisabledReason,
} from "../lib/post-media-prep";
import { formatScheduledForLabel } from "../lib/schedule-label";

test("preview window seeking keeps paused clips inside the clip window", () => {
  const window = {
    startMs: 12_000,
    endMs: 24_500,
  };

  assert.equal(shouldSeekPreviewToStart(12.01, window), false);
  assert.equal(shouldSeekPreviewToStart(18, window), false);
  assert.equal(shouldSeekPreviewToStart(18, window, { firstLoad: true }), true);
  assert.equal(shouldSeekPreviewToStart(9, window), true);
  assert.equal(shouldSeekPreviewToStart(24.5, window), true);
});

test("preview window scrub values clamp to the clip range", () => {
  const window = {
    startMs: 5_000,
    endMs: 17_000,
  };

  assert.equal(clipWindowDurationSeconds(window), 12);
  assert.equal(clipWindowOffsetSeconds(7.5, window), 2.5);
  assert.equal(clipWindowOffsetSeconds(3, window), 0);
  assert.equal(clipWindowOffsetSeconds(22, window), 12);
  assert.equal(clipWindowTimeFromOffsetSeconds(4, window), 9);
  assert.equal(clipWindowTimeFromOffsetSeconds(40, window), 17);
});

test("scheduled label formats the returned slot for the review accept notice", () => {
  assert.equal(
    formatScheduledForLabel("2026-07-30T11:00:00.000Z", {
      timeZone: "Asia/Bangkok",
    }),
    "Scheduled for Thu 18:00",
  );
  assert.equal(formatScheduledForLabel("not a date"), null);
  assert.equal(formatScheduledForLabel(null), null);
});

test("post media preparation text explains Save disabled states", () => {
  assert.equal(
    formatMediaPreparationProgress({
      loadedBytes: 25,
      totalBytes: 100,
    }),
    "Preparing video: 25%",
  );
  assert.equal(
    saveDisabledReason({
      canPost: false,
      canShareVideo: false,
      hasPreparedFile: false,
      isPreparingVideo: false,
      progress: {
        loadedBytes: 0,
        totalBytes: null,
      },
    }),
    "Rendered MP4 is not ready yet.",
  );
  assert.equal(
    saveDisabledReason({
      canPost: true,
      canShareVideo: false,
      hasPreparedFile: true,
      isPreparingVideo: false,
      progress: {
        loadedBytes: 100,
        totalBytes: 100,
      },
    }),
    "This browser cannot save directly. Use Download.",
  );
});
