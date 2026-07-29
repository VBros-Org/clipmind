import test from "node:test";
import assert from "node:assert/strict";

import {
  uploadTransferFailed,
  uploadTransferStarted,
  uploadTransferSucceeded,
} from "../lib/upload-transfer-state";

test("upload transfer retry keeps the picked File reference", () => {
  const pickedFile = { name: "source.mp4", size: 1024 };

  const failedState = uploadTransferFailed(pickedFile);

  assert.strictEqual(failedState.retryFile, pickedFile);
  assert.equal(failedState.notice, null);
});

test("upload transfer start and success clear retry file state", () => {
  assert.deepEqual(uploadTransferStarted(), {
    notice: "uploading",
    retryFile: null,
  });
  assert.deepEqual(uploadTransferSucceeded(), {
    notice: "safe",
    retryFile: null,
  });
});
