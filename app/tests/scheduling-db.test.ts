import assert from "node:assert/strict";

import { prisma } from "../lib/db";
import {
  markPosted,
  runSchedulePass,
  scheduleTick,
  type ScheduleTickResult,
} from "../lib/scheduling-repository";

type ScheduledTickResult = Extract<
  ScheduleTickResult,
  {
    status: "scheduled";
  }
>;

async function main() {
  const marker = `scheduling-db-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  let creatorId: string | null = null;

  try {
    const creator = await prisma.creator.create({
      data: {
        channelUrl: `https://example.com/${marker}`,
        mindId: `mind-${marker}`,
        captionStyle: {
          preset: "clean-bold",
        },
      },
    });
    creatorId = creator.id;

    const videoA = await prisma.video.create({
      data: {
        creatorId: creator.id,
        contentKey: `${marker}-video-a`,
        sourceUrl: "https://example.com/video-a.mp4",
        status: "clipped",
      },
    });
    const videoB = await prisma.video.create({
      data: {
        creatorId: creator.id,
        contentKey: `${marker}-video-b`,
        sourceUrl: "https://example.com/video-b.mp4",
        status: "clipped",
      },
    });

    await prisma.schedule.create({
      data: {
        creatorId: creator.id,
        slots: [],
        rotation: {},
        slotsPerDay: 4,
      },
    });

    await prisma.clip.create({
      data: {
        creatorId: creator.id,
        videoId: videoA.id,
        startMs: 1_000,
        endMs: 11_000,
        status: "accepted",
        createdAt: date("2026-07-27T00:00:00.000Z"),
      },
    });
    await prisma.clip.create({
      data: {
        creatorId: creator.id,
        videoId: videoA.id,
        startMs: 12_000,
        endMs: 22_000,
        status: "accepted",
        createdAt: date("2026-07-27T00:01:00.000Z"),
      },
    });
    await prisma.clip.create({
      data: {
        creatorId: creator.id,
        videoId: videoB.id,
        startMs: 2_000,
        endMs: 12_000,
        status: "accepted",
        createdAt: date("2026-07-27T00:00:30.000Z"),
      },
    });
    await prisma.clip.create({
      data: {
        creatorId: creator.id,
        videoId: videoB.id,
        startMs: 13_000,
        endMs: 23_000,
        status: "accepted",
        createdAt: date("2026-07-27T00:01:30.000Z"),
      },
    });

    const scheduled: ScheduledTickResult[] = [];
    for (const now of [
      "2026-07-27T08:00:00.000Z",
      "2026-07-27T08:01:00.000Z",
      "2026-07-27T08:02:00.000Z",
      "2026-07-27T08:03:00.000Z",
    ]) {
      const result = await scheduleTick(creator.id, date(now));
      assert.equal(result.status, "scheduled");
      scheduled.push(result);
    }

    assert.deepEqual(
      scheduled.map((result) => result.videoId),
      [videoA.id, videoB.id, videoA.id, videoB.id],
    );
    assert.deepEqual(
      scheduled.map((result) => result.scheduledFor.toISOString()),
      [
        "2026-07-27T09:00:00.000Z",
        "2026-07-27T15:00:00.000Z",
        "2026-07-27T21:00:00.000Z",
        "2026-07-28T03:00:00.000Z",
      ],
    );

    const emptyResult = await scheduleTick(
      creator.id,
      date("2026-07-27T08:04:00.000Z"),
    );
    assert.equal(emptyResult.status, "empty");
    assert.equal(emptyResult.reason, "no_accepted_clips");

    const posted = await markPosted(
      scheduled[0].clipId,
      date("2026-07-27T09:30:00.000Z"),
    );
    assert.equal(posted.status, "posted");

    const postedClip = await prisma.clip.findUniqueOrThrow({
      where: {
        id: scheduled[0].clipId,
      },
      select: {
        status: true,
        postedAt: true,
      },
    });

    assert.equal(postedClip.status, "posted");
    assert.equal(
      postedClip.postedAt?.toISOString(),
      "2026-07-27T09:30:00.000Z",
    );

    const passClipA = await prisma.clip.create({
      data: {
        creatorId: creator.id,
        videoId: videoA.id,
        startMs: 30_000,
        endMs: 40_000,
        status: "accepted",
        createdAt: date("2026-07-27T00:05:00.000Z"),
      },
    });
    const passClipB = await prisma.clip.create({
      data: {
        creatorId: creator.id,
        videoId: videoB.id,
        startMs: 31_000,
        endMs: 41_000,
        status: "accepted",
        createdAt: date("2026-07-27T00:06:00.000Z"),
      },
    });

    const passResult = await runSchedulePass(
      creator.id,
      date("2026-07-28T04:00:00.000Z"),
    );
    assert.equal(passResult.status, "done");
    assert.equal(passResult.scheduled.length, 2);

    const rerunResult = await runSchedulePass(
      creator.id,
      date("2026-07-28T04:01:00.000Z"),
    );
    assert.equal(rerunResult.status, "done");
    assert.equal(rerunResult.scheduled.length, 0);

    const passClips = await prisma.clip.findMany({
      where: {
        id: {
          in: [passClipA.id, passClipB.id],
        },
      },
      orderBy: {
        scheduledFor: "asc",
      },
      select: {
        status: true,
        scheduledFor: true,
      },
    });
    assert.deepEqual(
      passClips.map((clip) => clip.status),
      ["scheduled", "scheduled"],
    );
    assert.deepEqual(
      passClips.map((clip) => clip.scheduledFor?.toISOString()),
      ["2026-07-28T09:00:00.000Z", "2026-07-28T15:00:00.000Z"],
    );

    console.log(
      [
        "PASSED scheduling DB tests",
        `creatorId=${creator.id}`,
        `order=${scheduled
          .map((result) => (result.videoId === videoA.id ? "A" : "B"))
          .join("/")}`,
        `scheduledFor=${scheduled
          .map((result) => result.scheduledFor.toISOString())
          .join(",")}`,
        `postedClip=${posted.clipId}`,
        `postedAt=${posted.postedAt.toISOString()}`,
        `passScheduled=${passResult.scheduled.length}`,
      ].join(" "),
    );
  } catch (error) {
    console.log("FAILED scheduling DB tests");
    throw error;
  } finally {
    if (creatorId) {
      await prisma.schedule.deleteMany({
        where: {
          creatorId,
        },
      });
      await prisma.clip.deleteMany({
        where: {
          creatorId,
        },
      });
      await prisma.video.deleteMany({
        where: {
          creatorId,
        },
      });
      await prisma.creator.delete({
        where: {
          id: creatorId,
        },
      });
    }

    await prisma.$disconnect();
  }
}

function date(value: string): Date {
  return new Date(value);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
