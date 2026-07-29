import { timingSafeEqual } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

import { prisma } from "./db";
import { loadCreatorSessionFromCookieHeader } from "./review-auth";
import { runPushTick, type PushTickResult } from "./push-tick";

type PushApiOptions = {
  prismaClient?: PrismaClient;
  now?: Date;
  env?: Record<string, string | undefined>;
  runPushTickImpl?: typeof runPushTick;
};

export async function handlePushSubscribe(
  request: Request,
  options: PushApiOptions = {},
): Promise<Response> {
  const session = await loadCreatorSessionFromCookieHeader(
    request.headers.get("cookie"),
    options,
  );
  if (!session) {
    return json({ error: "Login required." }, 401);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Push token is required." }, 400);
  }

  if (!isRecord(payload) || typeof payload.token !== "string") {
    return json({ error: "Push token is required." }, 400);
  }

  const token = payload.token.trim();
  if (token.length < 10 || token.length > 4096) {
    return json({ error: "Push token is invalid." }, 400);
  }

  const db = options.prismaClient ?? prisma;
  const subscription = await db.pushSubscription.upsert({
    where: {
      token,
    },
    create: {
      creatorId: session.creatorId,
      token,
      userAgent: request.headers.get("user-agent"),
      lastSeenAt: options.now ?? new Date(),
    },
    update: {
      creatorId: session.creatorId,
      userAgent: request.headers.get("user-agent"),
      lastSeenAt: options.now ?? new Date(),
      disabledAt: null,
    },
    select: {
      id: true,
      creatorId: true,
      lastSeenAt: true,
    },
  });

  return json(
    {
      subscription: {
        id: subscription.id,
        creatorId: subscription.creatorId,
        lastSeenAt: subscription.lastSeenAt.toISOString(),
      },
    },
    200,
  );
}

export async function handlePushTick(
  request: Request,
  options: PushApiOptions = {},
): Promise<Response> {
  const auth = authorizeCronRequest(request, options.env ?? process.env);
  if (auth.status !== "authorized") {
    return json({ error: auth.error }, auth.status);
  }

  const runTick = options.runPushTickImpl ?? runPushTick;
  const result: PushTickResult = await runTick(options.now ?? new Date(), {
    prismaClient: options.prismaClient,
  });

  return json(result, 200);
}

function authorizeCronRequest(
  request: Request,
  env: Record<string, string | undefined>,
): { status: "authorized" } | { status: 401 | 500; error: string } {
  const expected = env.CRON_SECRET?.trim();
  if (!expected) {
    return {
      status: 500,
      error: "CRON_SECRET is not configured.",
    };
  }

  const candidate =
    bearerToken(request.headers.get("authorization")) ??
    request.headers.get("x-cron-secret")?.trim() ??
    "";

  if (!safeEqual(candidate, expected)) {
    return {
      status: 401,
      error: "Unauthorized.",
    };
  }

  return {
    status: "authorized",
  };
}

function bearerToken(header: string | null): string | null {
  if (!header) {
    return null;
  }

  const [scheme, token] = header.split(/\s+/, 2);
  return scheme?.toLowerCase() === "bearer" && token ? token.trim() : null;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

function json(payload: unknown, status: number): Response {
  return Response.json(payload, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
