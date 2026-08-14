import test from "node:test";
import assert from "node:assert/strict";

import {
  missingMultipartUploadParts,
  planMultipartUploadParts,
  uploadFileMultipart,
  uploadedBytesForPlannedParts,
  type FetchOptions,
  type StorageLike,
  type UploadBlobLike,
  type UploadFileLike,
} from "../lib/upload-multipart-client";

test("multipart upload planning resumes from server-listed uploaded parts", () => {
  const planned = planMultipartUploadParts(40, 16);
  const uploaded = [
    {
      partNumber: 1,
      size: 16,
    },
  ];

  assert.deepEqual(planned, [
    {
      partNumber: 1,
      start: 0,
      end: 16,
      size: 16,
    },
    {
      partNumber: 2,
      start: 16,
      end: 32,
      size: 16,
    },
    {
      partNumber: 3,
      start: 32,
      end: 40,
      size: 8,
    },
  ]);
  assert.equal(uploadedBytesForPlannedParts(planned, uploaded), 16);
  assert.deepEqual(missingMultipartUploadParts(planned, uploaded), [
    {
      partNumber: 2,
      start: 16,
      end: 32,
      size: 16,
    },
    {
      partNumber: 3,
      start: 32,
      end: 40,
      size: 8,
    },
  ]);
});

test("multipart upload resumes a stored intent and uploads only missing listed parts", async () => {
  const storage = new MemoryStorage();
  const file = fakeFile({
    name: "source.mp4",
    size: 40,
    lastModified: 123,
    type: "video/mp4",
  });
  storage.setItem(
    "clipmind.multipartUploads.v1",
    JSON.stringify({
      "source.mp4:40:123:video/mp4": {
        intentId: "intent-1",
        fileName: "source.mp4",
        size: 40,
        lastModified: 123,
        type: "video/mp4",
        updatedAt: "2026-08-14T00:00:00.000Z",
      },
    }),
  );
  const fetchCalls: Array<{ input: string; init: FetchOptions }> = [];
  const putUrls: string[] = [];
  const putSizes: number[] = [];
  const originalXhr = (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
  (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = class {
    upload = {
      onprogress: null as ((event: { lengthComputable: boolean; loaded: number }) => void) | null,
    };
    status = 200;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    private url = "";

    open(_method: string, url: string) {
      this.url = url;
    }

    abort() {
      this.onabort?.();
    }

    send(body: UploadBlobLike) {
      putUrls.push(this.url);
      putSizes.push(body.size);
      this.upload.onprogress?.({
        lengthComputable: true,
        loaded: body.size,
      });
      this.onload?.();
    }
  };

  try {
    const result = await uploadFileMultipart(
      file,
      () => undefined,
      {
        storage,
        fetchImpl: async (input, init) => {
          fetchCalls.push({ input, init });
          if (input === "/api/videos/uploads/multipart/intent-1") {
            return jsonResponse({
              intentId: "intent-1",
              status: "uploading",
              fileName: "source.mp4",
              size: 40,
              partSizeBytes: 16,
              uploadedParts: [
                {
                  partNumber: 1,
                  size: 16,
                },
              ],
              videoId: null,
            });
          }

          if (input === "/api/videos/uploads/multipart/intent-1/sign") {
            const body = JSON.parse(init.body ?? "{}") as {
              partNumbers: number[];
            };
            return jsonResponse({
              intentId: "intent-1",
              urls: body.partNumbers.map((partNumber) => ({
                partNumber,
                url: `https://r2.example/part-${partNumber}`,
              })),
            });
          }

          if (input === "/api/videos/uploads/multipart/intent-1/complete") {
            return jsonResponse({
              videoId: "video-1",
              stage: "uploaded",
              bytes: 40,
            });
          }

          throw new Error(`Unexpected fetch ${input}`);
        },
      },
    );

    assert.deepEqual(result, {
      videoId: "video-1",
      stage: "uploaded",
      bytes: 40,
    });
    assert.deepEqual(putUrls, [
      "https://r2.example/part-2",
      "https://r2.example/part-3",
    ]);
    assert.deepEqual(putSizes, [16, 8]);
    assert.deepEqual(
      fetchCalls.map((call) => call.input),
      [
        "/api/videos/uploads/multipart/intent-1",
        "/api/videos/uploads/multipart/intent-1/sign",
        "/api/videos/uploads/multipart/intent-1/sign",
        "/api/videos/uploads/multipart/intent-1/complete",
      ],
    );
    assert.equal(storage.getItem("clipmind.multipartUploads.v1"), "{}");
  } finally {
    (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = originalXhr;
  }
});

function fakeFile(input: {
  name: string;
  size: number;
  lastModified: number;
  type: string;
}): UploadFileLike {
  return {
    ...input,
    slice(start = 0, end = input.size): UploadBlobLike {
      return {
        size: end - start,
      };
    },
  };
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    async json() {
      return body;
    },
  };
}

class MemoryStorage implements StorageLike {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}
