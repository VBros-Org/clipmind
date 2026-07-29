import type { PrismaClient } from "@prisma/client";

import { prisma } from "./db";
import { startOfUtcWeek } from "./posted-win";

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
  return db.clip.count({
    where: {
      creatorId,
      status: "posted",
      postedAt: {
        gte: startOfUtcWeek(now),
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
