import test from "node:test";
import assert from "node:assert/strict";

import {
  canSharePreparedVideoFile,
  sharePreparedVideoFile,
  type PreparedVideoShareData,
  type PreparedVideoShareNavigator,
} from "../lib/share-prepared-video";

test("sharePreparedVideoFile calls navigator.share synchronously with the prepared file", async () => {
  const file = { name: "clipmind-test.mp4" };
  let phase: "tap" | "after-handler" = "tap";
  const calls: Array<{ data: PreparedVideoShareData; phase: string }> = [];
  const navigatorLike: PreparedVideoShareNavigator = {
    canShare(data) {
      assert.strictEqual(data.files[0], file);
      return true;
    },
    share(data) {
      calls.push({ data, phase });
      return Promise.resolve();
    },
  };

  const resultPromise = sharePreparedVideoFile(navigatorLike, file);
  phase = "after-handler";
  const result = await resultPromise;

  assert.deepEqual(result, { status: "shared" });
  assert.equal(calls.length, 1);
  assert.strictEqual(calls[0]?.data.files[0], file);
  assert.equal(calls[0]?.phase, "tap");
});

test("sharePreparedVideoFile swallows AbortError cancellation", async () => {
  const result = await sharePreparedVideoFile(
    {
      canShare: () => true,
      share: () => Promise.reject({ name: "AbortError" }),
    },
    { name: "cancelled.mp4" },
  );

  assert.deepEqual(result, { status: "cancelled" });
});

test("sharePreparedVideoFile gates fallback on canShare", async () => {
  const file = { name: "unsupported.mp4" };
  let shareCalled = false;
  const navigatorLike: PreparedVideoShareNavigator = {
    canShare(data) {
      assert.strictEqual(data.files[0], file);
      return false;
    },
    share() {
      shareCalled = true;
    },
  };

  assert.equal(canSharePreparedVideoFile(navigatorLike, file), false);
  assert.deepEqual(await sharePreparedVideoFile(navigatorLike, file), {
    status: "unsupported",
  });
  assert.equal(shareCalled, false);
});
