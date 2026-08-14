import type { PrismaClient } from "@prisma/client";

import { prisma } from "./db";
import {
  loadCreatorSessionForAccessCode,
  normalizeAccessCode,
  type CreatorSession,
} from "./review-auth";
import { normalizeCreatorTimezone } from "./timezone";

type LoginOptions = {
  prismaClient?: PrismaClient;
};

export async function loginCreatorWithAccessCode(
  rawAccessCode: string,
  rawTimezone: string | null,
  options: LoginOptions = {},
): Promise<CreatorSession | null> {
  const accessCode = normalizeAccessCode(rawAccessCode);
  const session = await loadCreatorSessionForAccessCode(accessCode, options);
  if (!session) {
    return null;
  }

  await prefillCreatorTimezoneIfMissing(
    session.creatorId,
    rawTimezone,
    options,
  );

  return session;
}

export async function prefillCreatorTimezoneIfMissing(
  creatorId: string,
  rawTimezone: string | null,
  options: LoginOptions = {},
): Promise<void> {
  const timezone = normalizeCreatorTimezone(rawTimezone);
  if (!timezone) {
    return;
  }

  const db = options.prismaClient ?? prisma;
  await db.creator.updateMany({
    where: {
      id: creatorId,
      timezone: null,
    },
    data: {
      timezone,
    },
  });
}
