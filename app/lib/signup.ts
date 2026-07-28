import { randomInt } from "node:crypto";

import type { Prisma, PrismaClient } from "@prisma/client";

import { prisma } from "./db";
import { normalizeInviteCode } from "./invite-codes";
import {
  CREATOR_ACCESS_COOKIE,
  CREATOR_ACCESS_COOKIE_MAX_AGE_SECONDS,
  normalizeAccessCode,
  readCookieValue,
} from "./review-auth";

export const SIGNUP_CREATOR_COOKIE = "clipmind_signup_creator";
const SIGNUP_CREATOR_COOKIE_MAX_AGE_SECONDS = 60 * 30;
const ACCESS_CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const CAPTION_PRESETS = ["clean-bold", "outline-pop", "karaoke"] as const;
const MAX_DISPLAY_NAME_LENGTH = 60;
const MAX_CHANNEL_URL_LENGTH = 300;

export type CaptionPresetId = (typeof CAPTION_PRESETS)[number];

export type SignupApiOptions = {
  prismaClient?: PrismaClient;
  now?: Date;
  generateAccessCode?: () => string;
};

export type ClaimedInvite = {
  creatorId: string;
  inviteId: string;
  code: string;
};

export type SignupProfileInput = {
  displayName: string;
  channelUrl: string | null;
  captionPreset: CaptionPresetId;
};

class SignupApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function handleClaimInvite(
  request: Request,
  options: SignupApiOptions = {},
): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Invite code is required." }, 400);
  }

  const code = readStringField(payload, "code");
  try {
    const claim = await claimInviteCode(code, options);
    const response = json(
      {
        creatorId: claim.creatorId,
      },
      200,
    );
    response.headers.append(
      "Set-Cookie",
      cookieHeader(SIGNUP_CREATOR_COOKIE, claim.creatorId, {
        maxAge: SIGNUP_CREATOR_COOKIE_MAX_AGE_SECONDS,
        httpOnly: true,
      }),
    );
    return response;
  } catch (error) {
    if (error instanceof SignupApiError) {
      return json({ error: error.message }, error.status);
    }

    throw error;
  }
}

export async function handleCreateSignupAccount(
  request: Request,
  options: SignupApiOptions = {},
): Promise<Response> {
  const creatorId = readCookieValue(
    request.headers.get("cookie"),
    SIGNUP_CREATOR_COOKIE,
  );
  if (!creatorId) {
    return json({ error: "Invite session expired. Start again." }, 401);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Profile details are required." }, 400);
  }

  try {
    const profile = parseSignupProfile(payload);
    const db = options.prismaClient ?? prisma;
    const accessCode = await completeSignupProfile(db, creatorId, profile, {
      generateAccessCode: options.generateAccessCode ?? generateCreatorAccessCode,
    });

    const response = json(
      {
        creatorId,
        accessCode,
      },
      200,
    );
    response.headers.append(
      "Set-Cookie",
      cookieHeader(CREATOR_ACCESS_COOKIE, accessCode, {
        maxAge: CREATOR_ACCESS_COOKIE_MAX_AGE_SECONDS,
        httpOnly: true,
      }),
    );
    response.headers.append(
      "Set-Cookie",
      cookieHeader(SIGNUP_CREATOR_COOKIE, "", {
        maxAge: 0,
        httpOnly: true,
      }),
    );
    return response;
  } catch (error) {
    if (error instanceof SignupApiError) {
      return json({ error: error.message }, error.status);
    }

    throw error;
  }
}

export async function claimInviteCode(
  rawCode: string | null,
  options: SignupApiOptions = {},
): Promise<ClaimedInvite> {
  const code = normalizeInviteInput(rawCode);
  const db = options.prismaClient ?? prisma;
  const now = options.now ?? new Date();

  return db.$transaction(async (tx) => {
    const creator = await tx.creator.create({
      data: {
        mindStage: "pending",
      },
      select: {
        id: true,
      },
    });

    const claimed = await tx.inviteCode.updateMany({
      where: {
        code,
        usedByCreatorId: null,
        usedAt: null,
      },
      data: {
        usedByCreatorId: creator.id,
        usedAt: now,
      },
    });

    if (claimed.count !== 1) {
      throw new SignupApiError(400, "Invite code is invalid or already used.");
    }

    const invite = await tx.inviteCode.findUniqueOrThrow({
      where: {
        code,
      },
      select: {
        id: true,
      },
    });

    return {
      creatorId: creator.id,
      inviteId: invite.id,
      code,
    };
  });
}

export function parseSignupProfile(payload: unknown): SignupProfileInput {
  const displayName = cleanString(readStringField(payload, "displayName"));
  if (!displayName || displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new SignupApiError(
      400,
      `Display name must be 1 to ${MAX_DISPLAY_NAME_LENGTH} characters.`,
    );
  }

  const rawChannelUrl = readOptionalStringField(payload, "channelUrl");
  const channelUrl = rawChannelUrl ? normalizeChannelUrl(rawChannelUrl) : null;
  const captionPreset = readStringField(payload, "captionPreset");
  if (!isCaptionPreset(captionPreset)) {
    throw new SignupApiError(400, "Pick a caption preset.");
  }

  return {
    displayName,
    channelUrl,
    captionPreset,
  };
}

export function generateCreatorAccessCode(): string {
  return `cm-${randomCodeGroup()}-${randomCodeGroup()}-${randomCodeGroup()}`;
}

function normalizeInviteInput(rawCode: string | null): string {
  const code = normalizeInviteCode(rawCode ?? "");
  if (!code || code.length > 80) {
    throw new SignupApiError(400, "Invite code is required.");
  }

  return code;
}

async function completeSignupProfile(
  db: PrismaClient,
  creatorId: string,
  profile: SignupProfileInput,
  options: {
    generateAccessCode: () => string;
  },
): Promise<string> {
  const creator = await db.creator.findUnique({
    where: {
      id: creatorId,
    },
    select: {
      id: true,
      accessCode: true,
      inviteCode: {
        select: {
          id: true,
        },
      },
    },
  });

  if (!creator?.inviteCode) {
    throw new SignupApiError(401, "Invite session expired. Start again.");
  }
  if (creator.accessCode) {
    throw new SignupApiError(409, "This invite already created an account.");
  }

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const accessCode = normalizeAccessCode(options.generateAccessCode());
    try {
      await db.creator.update({
        where: {
          id: creator.id,
        },
        data: {
          displayName: profile.displayName,
          channelUrl: profile.channelUrl,
          captionStyle: {
            preset: profile.captionPreset,
          } satisfies Prisma.InputJsonObject,
          accessCode,
          mindStage: "pending",
          mindError: null,
        },
      });
      return accessCode;
    } catch (error) {
      if (isUniqueConstraintError(error) && attempt < 5) {
        continue;
      }

      throw error;
    }
  }

  throw new Error("Could not generate a unique access code.");
}

function normalizeChannelUrl(value: string): string {
  const url = cleanString(value);
  if (!url || url.length > MAX_CHANNEL_URL_LENGTH) {
    throw new SignupApiError(
      400,
      `Channel URL must be ${MAX_CHANNEL_URL_LENGTH} characters or fewer.`,
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SignupApiError(400, "Channel URL must be a valid URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SignupApiError(400, "Channel URL must start with http or https.");
  }

  return parsed.toString();
}

function randomCodeGroup(): string {
  let value = "";
  for (let index = 0; index < 4; index += 1) {
    value += ACCESS_CODE_ALPHABET[randomInt(ACCESS_CODE_ALPHABET.length)];
  }

  return value;
}

function readStringField(payload: unknown, key: string): string {
  if (!isRecord(payload) || typeof payload[key] !== "string") {
    return "";
  }

  return payload[key];
}

function readOptionalStringField(payload: unknown, key: string): string | null {
  if (!isRecord(payload)) {
    return null;
  }

  const value = payload[key];
  return typeof value === "string" ? value : null;
}

function isCaptionPreset(value: string): value is CaptionPresetId {
  return CAPTION_PRESETS.includes(value as CaptionPresetId);
}

function cleanString(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    isRecord(error) &&
    error.code === "P2002"
  );
}

function cookieHeader(
  name: string,
  value: string,
  options: {
    maxAge: number;
    httpOnly: boolean;
  },
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${options.maxAge}`,
  ];

  if (options.httpOnly) {
    parts.push("HttpOnly");
  }
  if (process.env.NODE_ENV === "production") {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function json(payload: unknown, status: number): Response {
  return Response.json(payload, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
