import { assertSafeTestDatabaseUrl } from "../tests/helpers/db-test-guard";

assertSafeTestDatabaseUrl();

let prisma!: typeof import("../lib/db").prisma;

const E2E_ACCESS_CODE = process.env.CLIPMIND_E2E_ACCESS_CODE ?? "cm-e2e-access";
const E2E_DISPLAY_NAME = "E2E Creator";

async function main(): Promise<void> {
  const db = await import("../lib/db.js");
  prisma = db.prisma;

  await cleanupExistingFixture();

  const creator = await prisma.creator.create({
    data: {
      accessCode: E2E_ACCESS_CODE,
      displayName: E2E_DISPLAY_NAME,
      channelUrl: "https://example.com/e2e-creator",
      mindId: "mind-e2e",
      mindStage: "ready",
      captionStyle: {
        preset: "clean-bold",
      },
      captionCorpus:
        "wait this actually worked\nthat opening is the whole clip",
      timezone: "UTC",
    },
  });

  const video = await prisma.video.create({
    data: {
      creatorId: creator.id,
      contentKey: `e2e-${creator.id}`,
      sourceUrl: "https://example.com/e2e-source.mp4",
      sourceKey: `videos/${creator.id}/source.mp4`,
      status: "clipped",
      pipelineStage: "done",
      createdAt: new Date("2026-08-14T08:00:00.000Z"),
    },
  });

  const scheduledFor = new Date(Date.now() + 60 * 60 * 1000);

  const reviewClip = await prisma.clip.create({
    data: {
      creatorId: creator.id,
      videoId: video.id,
      startMs: 1_000,
      endMs: 12_000,
      status: "candidate",
      renderedUrl: "https://cdn.example/e2e-review.mp4",
      postCopyVariants: readyPostCopy("review"),
      transcript: "Wait, this is the moment.",
      mindRank: 1,
      mindRankReason: "Strong opening and fast payoff.",
      createdAt: new Date("2026-08-14T08:01:00.000Z"),
    },
  });

  const readyClip = await prisma.clip.create({
    data: {
      creatorId: creator.id,
      videoId: video.id,
      startMs: 13_000,
      endMs: 24_000,
      status: "scheduled",
      scheduledFor,
      renderedUrl: "https://cdn.example/e2e-ready.mp4",
      postCopyVariants: readyPostCopy("ready"),
      transcript: "That opening is the whole clip.",
      mindRank: 2,
      mindRankReason: "Clear hook for a short.",
      createdAt: new Date("2026-08-14T08:02:00.000Z"),
    },
  });

  await prisma.schedule.create({
    data: {
      creatorId: creator.id,
      slots: ["09:00", "17:00"],
      slotTimes: ["09:00", "17:00"],
      rotation: {},
      slotsPerDay: 2,
      anchorHour: 9,
      reviewReminders: true,
      runwayWarnings: true,
      runwayThresholdDays: 2,
      postTimeNudges: false,
      pushNudges: false,
    },
  });

  console.log(
    [
      "PASSED e2e seed",
      `creatorId=${creator.id}`,
      `accessCode=${E2E_ACCESS_CODE}`,
      `videoId=${video.id}`,
      `reviewClipId=${reviewClip.id}`,
      `readyClipId=${readyClip.id}`,
    ].join(" "),
  );
}

async function cleanupExistingFixture(): Promise<void> {
  const creators = await prisma.creator.findMany({
    where: {
      accessCode: E2E_ACCESS_CODE,
    },
    select: {
      id: true,
    },
  });
  const creatorIds = creators.map((creator) => creator.id);
  if (creatorIds.length === 0) {
    return;
  }

  await prisma.nudgeLog.deleteMany({
    where: {
      creatorId: {
        in: creatorIds,
      },
    },
  });
  await prisma.pushSubscription.deleteMany({
    where: {
      creatorId: {
        in: creatorIds,
      },
    },
  });
  await prisma.schedule.deleteMany({
    where: {
      creatorId: {
        in: creatorIds,
      },
    },
  });
  await prisma.channelPullTranscript.deleteMany({
    where: {
      creatorId: {
        in: creatorIds,
      },
    },
  });
  await prisma.learningEvent.deleteMany({
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
  await prisma.uploadIntent.deleteMany({
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
  await prisma.inviteCode.deleteMany({
    where: {
      usedByCreatorId: {
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

function readyPostCopy(label: string) {
  return {
    youtube: `E2E ${label} title`,
    tiktok: `E2E ${label} caption #clipmind`,
    instagram: `E2E ${label} caption.\nExtra context for the smoke path.\n\n#clipmind`,
  };
}

main()
  .catch((error: unknown) => {
    console.log("FAILED e2e seed");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (prisma) {
      await prisma.$disconnect();
    }
  });
