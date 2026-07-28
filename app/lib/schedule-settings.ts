export const MIN_SLOTS_PER_DAY = 1;
export const MAX_SLOTS_PER_DAY = 4;
export const MIN_ANCHOR_HOUR = 0;
export const MAX_ANCHOR_HOUR = 23;
export const DEFAULT_ANCHOR_HOUR = 9;
export const MIN_RUNWAY_THRESHOLD_DAYS = 1;
export const MAX_RUNWAY_THRESHOLD_DAYS = 7;
export const DEFAULT_RUNWAY_THRESHOLD_DAYS = 2;

export type ScheduleSettings = {
  slotsPerDay: number;
  anchorHour: number;
  reviewReminders: boolean;
  runwayWarnings: boolean;
  runwayThresholdDays: number;
  postTimeNudges: boolean;
};

export const DEFAULT_SCHEDULE_SETTINGS: ScheduleSettings = {
  slotsPerDay: 2,
  anchorHour: DEFAULT_ANCHOR_HOUR,
  reviewReminders: true,
  runwayWarnings: true,
  runwayThresholdDays: DEFAULT_RUNWAY_THRESHOLD_DAYS,
  postTimeNudges: true,
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

  return {
    slotsPerDay: readInteger(
      payload.slotsPerDay,
      "slotsPerDay",
      MIN_SLOTS_PER_DAY,
      MAX_SLOTS_PER_DAY,
    ),
    anchorHour: readInteger(
      payload.anchorHour,
      "anchorHour",
      MIN_ANCHOR_HOUR,
      MAX_ANCHOR_HOUR,
    ),
    reviewReminders: readBoolean(payload.reviewReminders, "reviewReminders"),
    runwayWarnings: readBoolean(payload.runwayWarnings, "runwayWarnings"),
    runwayThresholdDays: readInteger(
      payload.runwayThresholdDays,
      "runwayThresholdDays",
      MIN_RUNWAY_THRESHOLD_DAYS,
      MAX_RUNWAY_THRESHOLD_DAYS,
    ),
    postTimeNudges: readBoolean(payload.postTimeNudges, "postTimeNudges"),
  };
}

export function scheduleSettingsFromRow(
  row: ScheduleSettings | null | undefined,
): ScheduleSettings | null {
  return row
    ? {
        slotsPerDay: row.slotsPerDay,
        anchorHour: row.anchorHour,
        reviewReminders: row.reviewReminders,
        runwayWarnings: row.runwayWarnings,
        runwayThresholdDays: row.runwayThresholdDays,
        postTimeNudges: row.postTimeNudges,
      }
    : null;
}

export function buildSlotLabels(settings: Pick<ScheduleSettings, "slotsPerDay" | "anchorHour">): string[] {
  const intervalHours = 24 / settings.slotsPerDay;
  return Array.from({ length: settings.slotsPerDay }, (_value, index) =>
    hourLabel((settings.anchorHour + index * intervalHours) % 24),
  );
}

export function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
