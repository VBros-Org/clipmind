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
import { runSchedulePass } from "./scheduling-repository";

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
  const schedule = await db.schedule.findUnique({
    where: {
      creatorId: session.creatorId,
    },
    select: scheduleSettingsSelect,
  });

  return json(
    {
      schedule: scheduleSettingsFromRow(schedule),
      defaults: DEFAULT_SCHEDULE_SETTINGS,
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

  let settings: ScheduleSettings;
  try {
    settings = parseScheduleSettingsPayload(await request.json());
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

  return json(
    {
      schedule: scheduleSettingsFromRow(schedule),
      scheduledCount: schedulePass.scheduled.length,
    },
    200,
  );
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
