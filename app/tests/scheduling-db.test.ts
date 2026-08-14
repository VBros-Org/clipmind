import "./helpers/db-test-guard";

import assert from "node:assert/strict";

import { prisma } from "../lib/db";
import {
  DEFAULT_SCHEDULE_SETTINGS,
  buildSlotLabels,
} from "../lib/schedule-settings";
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

  const creatorIds: string[] = [];

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
    creatorIds.push(creator.id);

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
        slots: ["03:00", "09:15", "15:30", "21:45"],
        slotTimes: ["03:00", "09:15", "15:30", "21:45"],
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
        ...readyPostFields("video-a-1"),
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
        ...readyPostFields("video-a-2"),
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
        ...readyPostFields("video-b-1"),
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
        ...readyPostFields("video-b-2"),
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
        "2026-07-27T09:15:00.000Z",
        "2026-07-27T15:30:00.000Z",
        "2026-07-27T21:45:00.000Z",
        "2026-07-28T03:00:00.000Z",
      ],
    );

    const emptyResult = await scheduleTick(
      creator.id,
      date("2026-07-27T08:04:00.000Z"),
    );
    assert.equal(emptyResult.status, "empty");
    assert.equal(emptyResult.reason, "no_accepted_clips");

    const unrenderedAccepted = await prisma.clip.create({
      data: {
        creatorId: creator.id,
        videoId: videoA.id,
        startMs: 24_000,
        endMs: 34_000,
        status: "accepted",
        postCopyVariants: readyPostCopy("captioned-not-rendered"),
        createdAt: date("2026-07-27T00:02:00.000Z"),
      },
    });
    const captionlessAccepted = await prisma.clip.create({
      data: {
        creatorId: creator.id,
        videoId: videoA.id,
        startMs: 35_000,
        endMs: 45_000,
        status: "accepted",
        renderedUrl: "https://cdn.example/rendered-captionless.mp4",
        createdAt: date("2026-07-27T00:03:00.000Z"),
      },
    });
    const incompleteCaptionAccepted = await prisma.clip.create({
      data: {
        creatorId: creator.id,
        videoId: videoB.id,
        startMs: 46_000,
        endMs: 56_000,
        status: "accepted",
        renderedUrl: "https://cdn.example/rendered-incomplete.mp4",
        postCopyVariants: {
          youtube: "Incomplete post copy",
          tiktok: "Incomplete post copy #clips",
        },
        createdAt: date("2026-07-27T00:04:00.000Z"),
      },
    });

    const unreadyPass = await runSchedulePass(
      creator.id,
      date("2026-07-27T08:05:00.000Z"),
    );
    assert.equal(unreadyPass.status, "done");
    assert.equal(unreadyPass.scheduled.length, 0);

    const unreadyStatuses = await prisma.clip.findMany({
      where: {
        id: {
          in: [
            unrenderedAccepted.id,
            captionlessAccepted.id,
            incompleteCaptionAccepted.id,
          ],
        },
      },
      orderBy: {
        createdAt: "asc",
      },
      select: {
        status: true,
        scheduledFor: true,
      },
    });
    assert.deepEqual(
      unreadyStatuses.map((clip) => [clip.status, clip.scheduledFor]),
      [
        ["accepted", null],
        ["accepted", null],
        ["accepted", null],
      ],
    );

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
        ...readyPostFields("pass-a"),
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
        ...readyPostFields("pass-b"),
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
      ["2026-07-28T09:15:00.000Z", "2026-07-28T15:30:00.000Z"],
    );

    const captionlessScheduled = await prisma.clip.create({
      data: {
        creatorId: creator.id,
        videoId: videoA.id,
        startMs: 50_000,
        endMs: 60_000,
        status: "scheduled",
        renderedUrl: "https://cdn.example/rendered-no-caption.mp4",
        scheduledFor: date("2026-07-28T16:00:00.000Z"),
      },
    });
    await assert.rejects(
      markPosted(captionlessScheduled.id, date("2026-07-28T16:30:00.000Z")),
      /not ready to post/,
    );

    const freshCreator = await prisma.creator.create({
      data: {
        channelUrl: `https://example.com/${marker}/fresh`,
        timezone: "Asia/Bangkok",
        captionStyle: {
          preset: "clean-bold",
        },
      },
    });
    creatorIds.push(freshCreator.id);
    const freshVideo = await prisma.video.create({
      data: {
        creatorId: freshCreator.id,
        contentKey: `${marker}-fresh-video`,
        sourceUrl: "https://example.com/fresh.mp4",
        status: "clipped",
      },
    });
    await prisma.clip.create({
      data: {
        creatorId: freshCreator.id,
        videoId: freshVideo.id,
        startMs: 1_000,
        endMs: 11_000,
        status: "accepted",
        ...readyPostFields("fresh-default"),
      },
    });
    const freshPass = await runSchedulePass(
      freshCreator.id,
      date("2026-07-27T01:00:00.000Z"),
    );
    assert.equal(freshPass.status, "done");
    assert.equal(freshPass.scheduled.length, 1);
    assert.equal(
      freshPass.scheduled[0]?.scheduledFor.toISOString(),
      "2026-07-27T02:00:00.000Z",
    );
    const freshSchedule = await prisma.schedule.findUniqueOrThrow({
      where: {
        creatorId: freshCreator.id,
      },
      select: {
        slots: true,
        slotTimes: true,
        slotsPerDay: true,
      },
    });
    assert.deepEqual(
      freshSchedule.slots,
      buildSlotLabels(DEFAULT_SCHEDULE_SETTINGS),
    );
    assert.deepEqual(
      freshSchedule.slotTimes,
      DEFAULT_SCHEDULE_SETTINGS.slotTimes,
    );
    assert.equal(
      freshSchedule.slotsPerDay,
      DEFAULT_SCHEDULE_SETTINGS.slotsPerDay,
    );

    const timezoneCreator = await prisma.creator.create({
      data: {
        channelUrl: `https://example.com/${marker}/timezone`,
        timezone: "UTC",
        captionStyle: {
          preset: "clean-bold",
        },
      },
    });
    creatorIds.push(timezoneCreator.id);
    const timezoneVideo = await prisma.video.create({
      data: {
        creatorId: timezoneCreator.id,
        contentKey: `${marker}-timezone-video`,
        sourceUrl: "https://example.com/timezone.mp4",
        status: "clipped",
      },
    });
    const postedBeforeTimezoneChange = await prisma.clip.create({
      data: {
        creatorId: timezoneCreator.id,
        videoId: timezoneVideo.id,
        startMs: 1_000,
        endMs: 11_000,
        status: "posted",
        scheduledFor: date("2026-07-27T09:00:00.000Z"),
        postedAt: date("2026-07-27T09:30:00.000Z"),
        ...readyPostFields("posted-before-timezone"),
      },
    });
    await prisma.schedule.create({
      data: {
        creatorId: timezoneCreator.id,
        slots: ["09:00"],
        slotTimes: ["09:00"],
        rotation: {},
        slotsPerDay: 1,
      },
    });
    await prisma.clip.create({
      data: {
        creatorId: timezoneCreator.id,
        videoId: timezoneVideo.id,
        startMs: 12_000,
        endMs: 22_000,
        status: "accepted",
        ...readyPostFields("after-timezone-change"),
      },
    });
    await prisma.creator.update({
      where: {
        id: timezoneCreator.id,
      },
      data: {
        timezone: "Asia/Bangkok",
      },
    });
    const timezonePass = await runSchedulePass(
      timezoneCreator.id,
      date("2026-07-28T01:00:00.000Z"),
    );
    assert.equal(timezonePass.status, "done");
    assert.equal(timezonePass.scheduled.length, 1);
    assert.equal(
      timezonePass.scheduled[0]?.scheduledFor.toISOString(),
      "2026-07-28T02:00:00.000Z",
    );
    const unchangedPosted = await prisma.clip.findUniqueOrThrow({
      where: {
        id: postedBeforeTimezoneChange.id,
      },
      select: {
        status: true,
        scheduledFor: true,
        postedAt: true,
      },
    });
    assert.equal(unchangedPosted.status, "posted");
    assert.equal(
      unchangedPosted.scheduledFor?.toISOString(),
      "2026-07-27T09:00:00.000Z",
    );
    assert.equal(
      unchangedPosted.postedAt?.toISOString(),
      "2026-07-27T09:30:00.000Z",
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
        `freshDefault=${freshPass.scheduled[0]?.scheduledFor.toISOString()}`,
        `timezoneFuture=${timezonePass.scheduled[0]?.scheduledFor.toISOString()}`,
      ].join(" "),
    );
  } catch (error) {
    console.log("FAILED scheduling DB tests");
    throw error;
  } finally {
    if (creatorIds.length > 0) {
      await prisma.schedule.deleteMany({
        where: {
          creatorId: {
            in: creatorIds,
          },
        },
      });
      await prisma.clip.deleteMany({
        where: {
          creatorId: {
            in: creatorIds,
          },
        },
      });
      await prisma.video.deleteMany({
        where: {
          creatorId: {
            in: creatorIds,
          },
        },
      });
      await prisma.creator.deleteMany({
        where: {
          id: {
            in: creatorIds,
          },
        },
      });
    }

    await prisma.$disconnect();
  }
}

function date(value: string): Date {
  return new Date(value);
}

function readyPostFields(label: string) {
  return {
    renderedUrl: `https://cdn.example/${label}.mp4`,
    postCopyVariants: readyPostCopy(label),
  };
}

function readyPostCopy(label: string) {
  return {
    youtube: `${label} title`,
    tiktok: `${label} for TikTok #clipmind`,
    instagram: `${label} on Instagram.\nExtra context here\n\n#clipmind`,
  };
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
