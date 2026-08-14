import { Prisma, type PrismaClient } from "@prisma/client";

import { prisma } from "./db";
import { loadCreatorSessionFromCookieHeader } from "./review-auth";
import {
  DEFAULT_SCHEDULE_SETTINGS,
  ScheduleSettingsValidationError,
  buildSlotLabels,
  parseScheduleSettingsPayload,
  scheduleSettingsFromRow,
  type ScheduleSettings,
} from "./schedule-settings";
import {
  ensureScheduleForCreator,
  runSchedulePass,
} from "./scheduling-repository";
import { normalizeCreatorTimezone, resolveCreatorTimezone } from "./timezone";

type ScheduleApiOptions = {
  prismaClient?: PrismaClient;
};

export async function handleGetSchedule(
  request: Request,
  options: ScheduleApiOptions = {},
): Promise<Response> {
  const session = await loadCreatorSession(request, options);
  if (!session) {
    return json({ error: "Login required." }, 401);
  }

  const db = options.prismaClient ?? prisma;
  const [schedule, creator] = await Promise.all([
    ensureScheduleForCreator(session.creatorId, {
      prismaClient: db,
    }),
    db.creator.findUniqueOrThrow({
      where: {
        id: session.creatorId,
      },
      select: {
        timezone: true,
      },
    }),
  ]);

  return json(
    {
      schedule,
      defaults: DEFAULT_SCHEDULE_SETTINGS,
      timezone: resolveCreatorTimezone(creator.timezone),
    },
    200,
  );
}

export async function handlePutSchedule(
  request: Request,
  options: ScheduleApiOptions = {},
): Promise<Response> {
  const session = await loadCreatorSession(request, options);
  if (!session) {
    return json({ error: "Login required." }, 401);
  }

  let payload: unknown;
  let settings: ScheduleSettings;
  let timezone: string | null;
  try {
    payload = await request.json();
    settings = parseScheduleSettingsPayload(payload);
    timezone = parseConfirmedTimezone(payload);
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      error instanceof ScheduleSettingsValidationError
    ) {
      return json({ error: errorMessage(error) }, 400);
    }

    throw error;
  }

  const db = options.prismaClient ?? prisma;
  if (timezone) {
    await db.creator.update({
      where: {
        id: session.creatorId,
      },
      data: {
        timezone,
      },
    });
  }

  const settingsData = scheduleSettingsWriteData(settings);
  const schedule = await db.schedule.upsert({
    where: {
      creatorId: session.creatorId,
    },
    create: {
      creatorId: session.creatorId,
      slots: buildSlotLabels(settings),
      rotation: {},
      ...settingsData,
    },
    update: {
      slots: buildSlotLabels(settings),
      ...settingsData,
    },
    select: scheduleSettingsSelect,
  });
  const schedulePass = await runSchedulePass(session.creatorId, new Date(), {
    prismaClient: db,
  });
  const creator = await db.creator.findUniqueOrThrow({
    where: {
      id: session.creatorId,
    },
    select: {
      timezone: true,
    },
  });

  return json(
    {
      schedule: scheduleSettingsFromRow(schedule),
      timezone: resolveCreatorTimezone(creator.timezone),
      scheduledCount: schedulePass.scheduled.length,
    },
    200,
  );
}

function parseConfirmedTimezone(payload: unknown): string | null {
  if (!isRecord(payload) || payload.timezoneConfirmed !== true) {
    return null;
  }

  const timezone = normalizeCreatorTimezone(
    readOptionalStringField(payload, "timezone"),
  );
  if (!timezone) {
    throw new ScheduleSettingsValidationError(
      "Timezone must be a valid IANA timezone.",
    );
  }

  return timezone;
}

async function loadCreatorSession(
  request: Request,
  options: ScheduleApiOptions,
) {
  return loadCreatorSessionFromCookieHeader(
    request.headers.get("cookie"),
    options,
  );
}

const scheduleSettingsSelect = {
  slotsPerDay: true,
  anchorHour: true,
  slotTimes: true,
  reviewReminders: true,
  runwayWarnings: true,
  runwayThresholdDays: true,
  postTimeNudges: true,
  pushNudges: true,
} as const;

function scheduleSettingsWriteData(settings: ScheduleSettings) {
  return {
    slotsPerDay: settings.slotsPerDay,
    anchorHour: settings.anchorHour,
    slotTimes: settings.slotTimes ?? Prisma.DbNull,
    reviewReminders: settings.reviewReminders,
    runwayWarnings: settings.runwayWarnings,
    runwayThresholdDays: settings.runwayThresholdDays,
    postTimeNudges: settings.postTimeNudges,
    pushNudges: settings.pushNudges,
  };
}

function json(payload: unknown, status: number): Response {
  return Response.json(payload, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readOptionalStringField(payload: unknown, key: string): string | null {
  if (!isRecord(payload)) {
    return null;
  }

  const value = payload[key];
  return typeof value === "string" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
