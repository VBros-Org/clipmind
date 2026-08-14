import type { Prisma, PrismaClient } from "@prisma/client";

import { prisma } from "./db";
import {
  runPushTick,
  type PushTickOptions,
  type PushTickResult,
} from "./push-tick";

const PUSH_TICK_INTERVAL_MS = 5 * 60 * 1000;
const FIRST_TICK_DELAY_MS = 30 * 1000;

const globalForPushTick = globalThis as unknown as {
  clipmindPushTickInterval?: NodeJS.Timeout;
};

export type LockedPushTickResult =
  | PushTickResult
  | {
      status: "locked";
    };

export function startPushTickInterval(): void {
  if (globalForPushTick.clipmindPushTickInterval) {
    return;
  }

  if (process.env.NODE_ENV === "test") {
    return;
  }

  const run = () => {
    void runPushTickWithAdvisoryLock().catch((error: unknown) => {
      console.error("Push tick failed", error);
    });
  };

  const firstTick = setTimeout(run, FIRST_TICK_DELAY_MS);
  firstTick.unref?.();

  const interval = setInterval(run, PUSH_TICK_INTERVAL_MS);
  interval.unref?.();
  globalForPushTick.clipmindPushTickInterval = interval;
}

export async function runPushTickWithAdvisoryLock(
  now: Date = new Date(),
  options: Omit<PushTickOptions, "prismaClient"> & {
    prismaClient?: PrismaClient;
  } = {},
): Promise<LockedPushTickResult> {
  const db = options.prismaClient ?? prisma;
  return db.$transaction(
    async (tx) => {
      const lockRows = await tx.$queryRawUnsafe<Array<{ locked: boolean }>>(
        "SELECT pg_try_advisory_xact_lock(7019, 19) AS locked",
      );
      const locked = lockRows[0]?.locked === true;

      if (!locked) {
        return {
          status: "locked",
        };
      }

      return runPushTick(now, {
        prismaClient: tx,
        creatorIds: options.creatorIds,
        sendPushNudgeToCreatorImpl: options.sendPushNudgeToCreatorImpl,
      });
    },
    {
      isolationLevel:
        "ReadCommitted" satisfies Prisma.TransactionIsolationLevel,
      maxWait: 5_000,
      timeout: 120_000,
    },
  );
}
