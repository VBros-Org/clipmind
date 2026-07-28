import test from "node:test";
import assert from "node:assert/strict";

import { formatVideoLabel } from "../lib/video-label";

test("formatVideoLabel uses a short human upload date", () => {
  assert.equal(
    formatVideoLabel(new Date("2026-07-27T10:30:00.000Z")),
    "Video, 27 Jul",
  );
});

test("formatVideoLabel never falls back to storage keys or ids", () => {
  assert.equal(formatVideoLabel("not-a-date"), "Video");
});
