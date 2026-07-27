import test from "node:test";
import assert from "node:assert/strict";

import { transcribeWithClipService } from "../lib/clip-service";

test("transcribeWithClipService calls /transcribe with token auth using mocked fetch", async () => {
  const calls: { input: string; init?: RequestInit }[] = [];

  const transcript = await transcribeWithClipService(
    {
      source: "https://example.com/source.mp4",
      sourceType: "source_video",
      weight: 1,
    },
    {
      url: "http://clip-service.test",
      token: "test-token",
    },
    async (input, init) => {
      calls.push({ input, init });
      return {
        ok: true,
        status: 200,
        async text() {
          return "";
        },
        async json() {
          return {
            text: "Wait, this is the moment.",
            segments: [],
            words: [],
          };
        },
      };
    },
  );

  assert.equal(transcript.text, "Wait, this is the moment.");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.input, "http://clip-service.test/transcribe");
  assert.equal(calls[0]?.init?.method, "POST");
  assert.deepEqual(calls[0]?.init?.headers, {
    Authorization: "Bearer test-token",
    "Content-Type": "application/json",
  });
  assert.equal(
    calls[0]?.init?.body,
    JSON.stringify({ source_url: "https://example.com/source.mp4" }),
  );
});
