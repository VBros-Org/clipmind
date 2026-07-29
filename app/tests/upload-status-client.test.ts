import test from "node:test";
import assert from "node:assert/strict";

import {
  fetchRecentUploads,
  fetchVideoStatus,
  retryUploadAndRefreshStatus,
  type FetchOptions,
} from "../lib/upload-status-client";

type FetchCall = {
  input: string;
  init: FetchOptions;
};

test("status and recent upload fetches are no-store", async () => {
  const calls: FetchCall[] = [];
  const fetchImpl = async (input: string, init: FetchOptions) => {
    calls.push({ input, init });
    return jsonResponse(
      input === "/api/videos/recent"
        ? { uploads: [] }
        : {
            stage: "done",
            error: null,
            failedStage: null,
            clipCount: 2,
          },
    );
  };

  await fetchVideoStatus("video-1", fetchImpl);
  await fetchRecentUploads(fetchImpl);

  assert.deepEqual(calls, [
    {
      input: "/api/videos/video-1/status",
      init: {
        cache: "no-store",
      },
    },
    {
      input: "/api/videos/recent",
      init: {
        cache: "no-store",
      },
    },
  ]);
});

test("retry rejection because the video is no longer failed refetches current status", async () => {
  const calls: FetchCall[] = [];
  const fetchImpl = async (input: string, init: FetchOptions) => {
    calls.push({ input, init });
    if (input.endsWith("/retry")) {
      return jsonResponse(
        {
          error: "Only failed uploads can be retried.",
        },
        {
          ok: false,
          status: 409,
        },
      );
    }

    return jsonResponse({
      stage: "done",
      error: null,
      failedStage: null,
      clipCount: 3,
    });
  };

  const result = await retryUploadAndRefreshStatus("video-2", fetchImpl);

  assert.deepEqual(result, {
    outcome: "refetched",
    status: {
      stage: "done",
      error: null,
      failedStage: null,
      clipCount: 3,
    },
  });
  assert.deepEqual(calls, [
    {
      input: "/api/videos/video-2/retry",
      init: {
        method: "POST",
        cache: "no-store",
      },
    },
    {
      input: "/api/videos/video-2/status",
      init: {
        cache: "no-store",
      },
    },
  ]);
});

function jsonResponse(
  body: unknown,
  options: {
    ok?: boolean;
    status?: number;
  } = {},
) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    async json() {
      return body;
    },
  };
}
