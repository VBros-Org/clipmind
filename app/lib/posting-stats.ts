import type { PrismaClient } from "@prisma/client";

import { prisma } from "./db";
import { startOfCreatorLocalWeekUtc } from "./timezone";

type PostingStatsOptions = {
  prismaClient?: PrismaClient;
};

export async function countPostedThisWeek(
  creatorId: string,
  now: Date = new Date(),
  options: PostingStatsOptions = {},
): Promise<number> {
  assertValidDate(now, "now");

  const db = options.prismaClient ?? prisma;
  const creator = await db.creator.findUniqueOrThrow({
    where: {
      id: creatorId,
    },
    select: {
      timezone: true,
    },
  });

  return db.clip.count({
    where: {
      creatorId,
      status: "posted",
      postedAt: {
        gte: startOfCreatorLocalWeekUtc(now, creator.timezone),
        lte: now,
      },
    },
  });
}

function assertValidDate(value: Date, label: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`${label} must be a valid Date.`);
  }
}
