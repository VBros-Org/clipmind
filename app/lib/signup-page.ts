import type { PrismaClient } from "@prisma/client";

import { prisma } from "./db";
import {
  CREATOR_ACCESS_COOKIE,
  normalizeAccessCode,
  readCookieValue,
} from "./review-auth";

export type SignedInSignupAffordance = {
  displayName: string;
  message: string;
};

type SignupPageOptions = {
  prismaClient?: PrismaClient;
};

export async function loadSignedInSignupAffordance(
  cookieHeader: string | null,
  options: SignupPageOptions = {},
): Promise<SignedInSignupAffordance | null> {
  const accessCode = normalizeAccessCode(
    readCookieValue(cookieHeader, CREATOR_ACCESS_COOKIE) ?? "",
  );
  if (!accessCode) {
    return null;
  }

  const db = options.prismaClient ?? prisma;
  const creator = await db.creator.findUnique({
    where: {
      accessCode,
    },
    select: {
      displayName: true,
    },
  });

  if (!creator) {
    return null;
  }

  const displayName = creator.displayName?.trim() || "your profile";
  return {
    displayName,
    message: signedInSignupMessage(displayName),
  };
}

export function signedInSignupMessage(displayName: string): string {
  return `Signed in as ${displayName}. Log out to create a new profile.`;
}
