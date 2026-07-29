export const MIN_SLOTS_PER_DAY = 1;
export const MAX_SLOTS_PER_DAY = 4;
export const MIN_ANCHOR_HOUR = 0;
export const MAX_ANCHOR_HOUR = 23;
export const DEFAULT_ANCHOR_HOUR = 9;
export const QUARTER_HOUR_MINUTES = [0, 15, 30, 45] as const;
export const MIN_RUNWAY_THRESHOLD_DAYS = 1;
export const MAX_RUNWAY_THRESHOLD_DAYS = 7;
export const DEFAULT_RUNWAY_THRESHOLD_DAYS = 2;

export type ScheduleSettings = {
  slotsPerDay: number;
  anchorHour: number;
  slotTimes: string[] | null;
  reviewReminders: boolean;
  runwayWarnings: boolean;
  runwayThresholdDays: number;
  postTimeNudges: boolean;
  pushNudges: boolean;
};

export const DEFAULT_SCHEDULE_SETTINGS: ScheduleSettings = {
  slotsPerDay: 2,
  anchorHour: DEFAULT_ANCHOR_HOUR,
  slotTimes: buildEvenSlotTimes(2, DEFAULT_ANCHOR_HOUR),
  reviewReminders: true,
  runwayWarnings: true,
  runwayThresholdDays: DEFAULT_RUNWAY_THRESHOLD_DAYS,
  postTimeNudges: true,
  pushNudges: false,
};

export class ScheduleSettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export function parseScheduleSettingsPayload(
  payload: unknown,
): ScheduleSettings {
  if (!isRecord(payload)) {
    throw new ScheduleSettingsValidationError("Schedule settings must be an object.");
  }

  const slotTimes = readSlotTimes(payload.slotTimes);
  const slotsPerDay = readInteger(
    payload.slotsPerDay,
    "slotsPerDay",
    MIN_SLOTS_PER_DAY,
    MAX_SLOTS_PER_DAY,
  );

  return {
    slotsPerDay: slotTimes ? slotTimes.length : slotsPerDay,
    anchorHour: readInteger(
      payload.anchorHour,
      "anchorHour",
      MIN_ANCHOR_HOUR,
      MAX_ANCHOR_HOUR,
    ),
    slotTimes,
    reviewReminders: readBoolean(payload.reviewReminders, "reviewReminders"),
    runwayWarnings: readBoolean(payload.runwayWarnings, "runwayWarnings"),
    runwayThresholdDays: readInteger(
      payload.runwayThresholdDays,
      "runwayThresholdDays",
      MIN_RUNWAY_THRESHOLD_DAYS,
      MAX_RUNWAY_THRESHOLD_DAYS,
    ),
    postTimeNudges: readBoolean(payload.postTimeNudges, "postTimeNudges"),
    pushNudges: readBoolean(payload.pushNudges, "pushNudges"),
  };
}

export function scheduleSettingsFromRow(
  row:
    | (Omit<ScheduleSettings, "slotTimes"> & {
        slotTimes?: unknown;
      })
    | null
    | undefined,
): ScheduleSettings | null {
  return row
    ? {
        slotsPerDay: row.slotsPerDay,
        anchorHour: row.anchorHour,
        slotTimes: normalizeSlotTimes(row.slotTimes),
        reviewReminders: row.reviewReminders,
        runwayWarnings: row.runwayWarnings,
        runwayThresholdDays: row.runwayThresholdDays,
        postTimeNudges: row.postTimeNudges,
        pushNudges: row.pushNudges,
      }
    : null;
}

export function buildSlotLabels(
  settings: Pick<ScheduleSettings, "slotsPerDay" | "anchorHour" | "slotTimes">,
): string[] {
  return (
    settings.slotTimes ??
    buildEvenSlotTimes(settings.slotsPerDay, settings.anchorHour)
  );
}

export function buildEvenSlotTimes(
  slotsPerDay: number,
  anchorHour: number,
): string[] {
  validateLegacyCadence(slotsPerDay, anchorHour);
  const intervalMinutes = (24 * 60) / slotsPerDay;
  if (!Number.isInteger(intervalMinutes)) {
    throw new ScheduleSettingsValidationError(
      "slotsPerDay must divide one day into whole minutes.",
    );
  }

  return Array.from({ length: slotsPerDay }, (_value, index) => {
    return (anchorHour * 60 + index * intervalMinutes) % (24 * 60);
  })
    .sort((left, right) => left - right)
    .map(minutesToSlotTime);
}

export function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

export function normalizeSlotTimes(value: unknown): string[] | null {
  return readSlotTimes(value);
}

export function slotCountForSchedule(
  schedule:
    | {
        slotsPerDay: number;
        slotTimes?: readonly string[] | null;
      }
    | null
    | undefined,
): number | null {
  if (!schedule) {
    return null;
  }

  if (schedule.slotTimes && schedule.slotTimes.length > 0) {
    return schedule.slotTimes.length;
  }

  return schedule.slotsPerDay;
}

export function slotTimeParts(slotTime: string): {
  hour: number;
  minute: number;
} {
  const totalMinutes = slotTimeToMinutes(slotTime);
  return {
    hour: Math.floor(totalMinutes / 60),
    minute: totalMinutes % 60,
  };
}

function readInteger(
  value: unknown,
  label: string,
  min: number,
  max: number,
): number {
  const numberValue = typeof value === "number" ? value : Number.NaN;
  if (
    !Number.isInteger(numberValue) ||
    numberValue < min ||
    numberValue > max
  ) {
    throw new ScheduleSettingsValidationError(
      `${label} must be an integer from ${min} to ${max}.`,
    );
  }

  return numberValue;
}

function readBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new ScheduleSettingsValidationError(`${label} must be true or false.`);
  }

  return value;
}

function readSlotTimes(value: unknown): string[] | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (!Array.isArray(value)) {
    throw new ScheduleSettingsValidationError("slotTimes must be an array.");
  }

  if (value.length < MIN_SLOTS_PER_DAY || value.length > MAX_SLOTS_PER_DAY) {
    throw new ScheduleSettingsValidationError(
      `slotTimes must contain ${MIN_SLOTS_PER_DAY} to ${MAX_SLOTS_PER_DAY} times.`,
    );
  }

  const normalized: string[] = [];
  let previousMinutes = -1;
  const seen = new Set<string>();

  for (const item of value) {
    if (typeof item !== "string") {
      throw new ScheduleSettingsValidationError(
        "slotTimes entries must be HH:MM strings.",
      );
    }

    const totalMinutes = slotTimeToMinutes(item);
    const normalizedTime = minutesToSlotTime(totalMinutes);
    if (item !== normalizedTime) {
      throw new ScheduleSettingsValidationError(
        "slotTimes entries must use HH:MM format.",
      );
    }

    if (seen.has(normalizedTime)) {
      throw new ScheduleSettingsValidationError("slotTimes must be unique.");
    }

    if (totalMinutes <= previousMinutes) {
      throw new ScheduleSettingsValidationError("slotTimes must be sorted.");
    }

    previousMinutes = totalMinutes;
    seen.add(normalizedTime);
    normalized.push(normalizedTime);
  }

  return normalized;
}

function slotTimeToMinutes(value: string): number {
  const match = /^([0-1][0-9]|2[0-3]):([0-5][0-9])$/.exec(value);
  if (!match) {
    throw new ScheduleSettingsValidationError(
      "slotTimes entries must use HH:MM format.",
    );
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (
    !QUARTER_HOUR_MINUTES.includes(
      minute as (typeof QUARTER_HOUR_MINUTES)[number],
    )
  ) {
    throw new ScheduleSettingsValidationError(
      "slotTimes minutes must be 00, 15, 30, or 45.",
    );
  }

  return hour * 60 + minute;
}

function minutesToSlotTime(totalMinutes: number): string {
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function validateLegacyCadence(slotsPerDay: number, anchorHour: number): void {
  readInteger(
    slotsPerDay,
    "slotsPerDay",
    MIN_SLOTS_PER_DAY,
    MAX_SLOTS_PER_DAY,
  );
  readInteger(anchorHour, "anchorHour", MIN_ANCHOR_HOUR, MAX_ANCHOR_HOUR);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
