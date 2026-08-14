import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

import { prisma } from "../lib/db";
import { renderClip } from "../lib/render";
import type { R2Storage, StorageUploadBody } from "../lib/storage";

test("renderClip uploads clip-service output and persists renderedUrl", async () => {
  const marker = `render-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const creator = await prisma.creator.create({
    data: {
      channelUrl: `https://example.com/${marker}`,
      captionStyle: {
        preset: "clean-bold",
      },
    },
  });
  const video = await prisma.video.create({
    data: {
      creatorId: creator.id,
      contentKey: `sha256:${marker}`,
      sourceKey: `videos/video_${marker}/source.mp4`,
      status: "clipped",
    },
  });
  const clip = await prisma.clip.create({
    data: {
      creatorId: creator.id,
      videoId: video.id,
      startMs: 1_000,
      endMs: 12_000,
      trimStartMs: 250,
      trimEndMs: 500,
      status: "accepted",
      transcript: "This is the moment.",
    },
  });

  const fetchCalls: { input: string; init?: RequestInit }[] = [];
  let uploadedClipId: string | null = null;
  let uploadedBytes: Buffer | null = null;
  const storage = {
    async presignSourceUrl(key) {
      assert.equal(key, video.sourceKey);
      return "https://signed.example/source.mp4";
    },
    async uploadRender(clipId, stream) {
      uploadedClipId = clipId;
      uploadedBytes = await readUploadBody(stream);
      return `https://cdn.example/clips/${clipId}.mp4`;
    },
  } satisfies Pick<R2Storage, "presignSourceUrl" | "uploadRender">;

  try {
    const result = await renderClip(clip.id, "clean-bold", {
      storage,
      fetchImpl: async (input, init) => {
        fetchCalls.push({ input, init });
        return new Response(Buffer.from("fake-mp4"), {
          status: 200,
          headers: {
            "Content-Type": "video/mp4",
          },
        });
      },
    });

    assert.equal(result.clipId, clip.id);
    assert.equal(result.videoId, video.id);
    assert.equal(result.renderedUrl, `https://cdn.example/clips/${clip.id}.mp4`);
    assert.equal(uploadedClipId, clip.id);
    assert.deepEqual(uploadedBytes, Buffer.from("fake-mp4"));
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0]?.input.endsWith("/cut"), true);
    assert.equal(fetchCalls[0]?.init?.method, "POST");
    assert.equal(
      (fetchCalls[0]?.init?.headers as Record<string, string>).Authorization.startsWith(
        "Bearer ",
      ),
      true,
    );
    assert.equal(
      (fetchCalls[0]?.init?.headers as Record<string, string>)["Content-Type"],
      "application/json",
    );
    assert.deepEqual(JSON.parse(fetchCalls[0]?.init?.body as string), {
      source_url: "https://signed.example/source.mp4",
      start_ms: 1_000,
      end_ms: 12_000,
      trim_start_ms: 250,
      trim_end_ms: 500,
      preset_id: "clean-bold",
      transcript: "This is the moment.",
    });

    const updatedClip = await prisma.clip.findUniqueOrThrow({
      where: {
        id: clip.id,
      },
      select: {
        renderedUrl: true,
        renderFailedAt: true,
        renderError: true,
      },
    });
    assert.equal(updatedClip.renderedUrl, result.renderedUrl);
    assert.equal(updatedClip.renderFailedAt, null);
    assert.equal(updatedClip.renderError, null);
  } finally {
    await prisma.clip.deleteMany({
      where: {
        creatorId: creator.id,
      },
    });
    await prisma.video.deleteMany({
      where: {
        creatorId: creator.id,
      },
    });
    await prisma.creator.delete({
      where: {
        id: creator.id,
      },
    });
    await prisma.$disconnect();
  }
});

test("renderClip persists capped failure state and clears it on retry success", async () => {
  const marker = `render-failure-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
  const creator = await prisma.creator.create({
    data: {
      channelUrl: `https://example.com/${marker}`,
      captionStyle: {
        preset: "clean-bold",
      },
    },
  });
  const video = await prisma.video.create({
    data: {
      creatorId: creator.id,
      contentKey: `sha256:${marker}`,
      sourceKey: `videos/video_${marker}/source.mp4`,
      status: "clipped",
    },
  });
  const clip = await prisma.clip.create({
    data: {
      creatorId: creator.id,
      videoId: video.id,
      startMs: 1_000,
      endMs: 12_000,
      status: "accepted",
      transcript: "This is the failed render moment.",
    },
  });

  const storage = {
    async presignSourceUrl(key) {
      assert.equal(key, video.sourceKey);
      return "https://signed.example/source.mp4";
    },
    async uploadRender(clipId, stream) {
      assert.equal(clipId, clip.id);
      assert.deepEqual(await readUploadBody(stream), Buffer.from("retry-mp4"));
      return `https://cdn.example/clips/${clipId}.mp4`;
    },
  } satisfies Pick<R2Storage, "presignSourceUrl" | "uploadRender">;

  try {
    await assert.rejects(
      () =>
        renderClip(clip.id, "clean-bold", {
          storage,
          fetchImpl: async () =>
            new Response(`service died ${"x".repeat(900)}`, {
              status: 503,
            }),
        }),
      /Clip service \/cut failed with 503/,
    );

    const failedClip = await prisma.clip.findUniqueOrThrow({
      where: {
        id: clip.id,
      },
      select: {
        renderedUrl: true,
        renderFailedAt: true,
        renderError: true,
      },
    });
    assert.equal(failedClip.renderedUrl, null);
    assert.ok(failedClip.renderFailedAt);
    assert.match(failedClip.renderError ?? "", /^Clip service \/cut failed/);
    assert.equal((failedClip.renderError ?? "").length, 500);

    const result = await renderClip(clip.id, "clean-bold", {
      storage,
      fetchImpl: async () =>
        new Response(Buffer.from("retry-mp4"), {
          status: 200,
          headers: {
            "Content-Type": "video/mp4",
          },
        }),
    });
    assert.equal(result.renderedUrl, `https://cdn.example/clips/${clip.id}.mp4`);

    const retriedClip = await prisma.clip.findUniqueOrThrow({
      where: {
        id: clip.id,
      },
      select: {
        renderedUrl: true,
        renderFailedAt: true,
        renderError: true,
      },
    });
    assert.equal(retriedClip.renderedUrl, result.renderedUrl);
    assert.equal(retriedClip.renderFailedAt, null);
    assert.equal(retriedClip.renderError, null);
  } finally {
    await prisma.clip.deleteMany({
      where: {
        creatorId: creator.id,
      },
    });
    await prisma.video.deleteMany({
      where: {
        creatorId: creator.id,
      },
    });
    await prisma.creator.delete({
      where: {
        id: creator.id,
      },
    });
    await prisma.$disconnect();
  }
});

async function readUploadBody(body: StorageUploadBody): Promise<Buffer> {
  if (body instanceof Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  if (typeof body === "string") {
    return Buffer.from(body);
  }
  throw new Error("Unexpected upload body type.");
}
