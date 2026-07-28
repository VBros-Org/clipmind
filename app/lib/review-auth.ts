import type { PrismaClient } from "@prisma/client";

import { prisma } from "./db";

export const CREATOR_ACCESS_COOKIE = "clipmind_creator_access";
export const CREATOR_ACCESS_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export type CreatorSession = {
  creatorId: string;
  accessCode: string;
};

type CreatorAuthOptions = {
  prismaClient?: PrismaClient;
};

export function normalizeAccessCode(value: string): string {
  return value.trim().toLowerCase();
}

export async function loadCreatorSessionForAccessCode(
  accessCode: string | null | undefined,
  options: CreatorAuthOptions = {},
): Promise<CreatorSession | null> {
  const normalizedCode = accessCode ? normalizeAccessCode(accessCode) : "";
  if (!normalizedCode) {
    return null;
  }

  const db = options.prismaClient ?? prisma;
  const creator = await db.creator.findUnique({
    where: {
      accessCode: normalizedCode,
    },
    select: {
      id: true,
      accessCode: true,
    },
  });

  if (!creator?.accessCode) {
    return null;
  }

  return {
    creatorId: creator.id,
    accessCode: creator.accessCode,
  };
}

export async function loadCreatorSessionFromCookieHeader(
  cookieHeader: string | null,
  options: CreatorAuthOptions = {},
): Promise<CreatorSession | null> {
  return loadCreatorSessionForAccessCode(
    readCookieValue(cookieHeader, CREATOR_ACCESS_COOKIE),
    options,
  );
}

export function readCookieValue(
  cookieHeader: string | null,
  name: string,
): string | null {
  if (!cookieHeader) {
    return null;
  }

  for (const cookie of cookieHeader.split(";")) {
    const [rawName, ...rawValueParts] = cookie.trim().split("=");
    if (rawName === name) {
      return decodeURIComponent(rawValueParts.join("="));
    }
  }

  return null;
}

export function cookieHeaderForAccessCode(accessCode: string): string {
  return `${CREATOR_ACCESS_COOKIE}=${encodeURIComponent(accessCode)}`;
}
