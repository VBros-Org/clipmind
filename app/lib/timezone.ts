const MAX_CREATOR_TIMEZONE_LENGTH = 100;
const DEFAULT_CREATOR_TIMEZONE = "UTC";
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

export type CreatorLocalDate = {
  year: number;
  month: number;
  day: number;
};

type CreatorLocalDateTime = CreatorLocalDate & {
  hour: number;
  minute: number;
  second?: number;
  millisecond?: number;
};

export function normalizeCreatorTimezone(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const timezone = value.trim();
  if (!timezone || timezone.length > MAX_CREATOR_TIMEZONE_LENGTH) {
    return null;
  }

  return isValidTimeZone(timezone) ? timezone : null;
}

export function resolveCreatorTimezone(
  timezone: string | null | undefined,
): string {
  return normalizeCreatorTimezone(timezone) ?? DEFAULT_CREATOR_TIMEZONE;
}

export function formatCreatorLocalTime(
  date: Date,
  timezone: string | null | undefined,
): string | null {
  assertValidDate(date, "date");

  const normalizedTimezone = normalizeCreatorTimezone(timezone);
  if (!normalizedTimezone) {
    return null;
  }

  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: normalizedTimezone,
  }).format(date);
}

export function creatorLocalDateForInstant(
  date: Date,
  timezone: string | null | undefined,
): CreatorLocalDate {
  const parts = zonedDateTimeParts(date, resolveCreatorTimezone(timezone));
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
  };
}

export function addCreatorLocalDays(
  date: CreatorLocalDate,
  days: number,
): CreatorLocalDate {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

export function creatorLocalDateTimeToUtc(
  localDateTime: CreatorLocalDateTime,
  timezone: string | null | undefined,
): Date {
  const normalizedTimezone = resolveCreatorTimezone(timezone);
  const target = normalizeLocalDateTime(localDateTime);
  const localAsUtcMs = localDateTimeAsUtcMs(target);
  const exactCandidates = new Set<number>();

  for (const seedMs of [
    localAsUtcMs - 24 * HOUR_MS,
    localAsUtcMs,
    localAsUtcMs + 24 * HOUR_MS,
  ]) {
    const offsetMs = timezoneOffsetMs(new Date(seedMs), normalizedTimezone);
    exactCandidates.add(localAsUtcMs - offsetMs);
  }

  for (const candidateMs of [...exactCandidates].sort(
    (left, right) => left - right,
  )) {
    const candidate = new Date(candidateMs);
    if (compareZonedDateTime(candidate, target, normalizedTimezone) === 0) {
      return candidate;
    }
  }

  return firstInstantAtOrAfterLocalDateTime(
    target,
    normalizedTimezone,
    localAsUtcMs,
  );
}

export function startOfCreatorLocalWeekUtc(
  date: Date,
  timezone: string | null | undefined,
): Date {
  assertValidDate(date, "date");
  const normalizedTimezone = resolveCreatorTimezone(timezone);
  const local = zonedDateTimeParts(date, normalizedTimezone);
  const mondayOffset = local.weekday === 0 ? 6 : local.weekday - 1;
  const startDate = addCreatorLocalDays(local, -mondayOffset);

  return creatorLocalDateTimeToUtc(
    {
      ...startDate,
      hour: 0,
      minute: 0,
      second: 0,
      millisecond: 0,
    },
    normalizedTimezone,
  );
}

export function creatorLocalDateKey(
  date: Date,
  timezone: string | null | undefined,
): string {
  assertValidDate(date, "date");
  const local = zonedDateTimeParts(date, resolveCreatorTimezone(timezone));
  return [
    String(local.year).padStart(4, "0"),
    String(local.month).padStart(2, "0"),
    String(local.day).padStart(2, "0"),
  ].join("-");
}

function isValidTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function zonedDateTimeParts(
  date: Date,
  timezone: string,
): Required<CreatorLocalDateTime> & { weekday: number } {
  assertValidDate(date, "date");
  const rawParts = dateTimeFormatter(timezone).formatToParts(date);
  const values = new Map<string, string>();
  for (const part of rawParts) {
    values.set(part.type, part.value);
  }

  const weekday = weekdayFormatter(timezone).format(date);
  return {
    year: Number(values.get("year")),
    month: Number(values.get("month")),
    day: Number(values.get("day")),
    hour: Number(values.get("hour")),
    minute: Number(values.get("minute")),
    second: Number(values.get("second")),
    millisecond: date.getUTCMilliseconds(),
    weekday: weekdayNumber(weekday),
  };
}

function dateTimeFormatter(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

function weekdayFormatter(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
  });
}

function weekdayNumber(value: string): number {
  switch (value) {
    case "Sun":
      return 0;
    case "Mon":
      return 1;
    case "Tue":
      return 2;
    case "Wed":
      return 3;
    case "Thu":
      return 4;
    case "Fri":
      return 5;
    case "Sat":
      return 6;
    default:
      throw new Error(`Unknown weekday ${value}.`);
  }
}

function normalizeLocalDateTime(
  value: CreatorLocalDateTime,
): Required<CreatorLocalDateTime> {
  return {
    year: value.year,
    month: value.month,
    day: value.day,
    hour: value.hour,
    minute: value.minute,
    second: value.second ?? 0,
    millisecond: value.millisecond ?? 0,
  };
}

function localDateTimeAsUtcMs(value: Required<CreatorLocalDateTime>): number {
  return Date.UTC(
    value.year,
    value.month - 1,
    value.day,
    value.hour,
    value.minute,
    value.second,
    value.millisecond,
  );
}

function timezoneOffsetMs(date: Date, timezone: string): number {
  const local = zonedDateTimeParts(date, timezone);
  return localDateTimeAsUtcMs(local) - date.getTime();
}

function compareZonedDateTime(
  date: Date,
  target: Required<CreatorLocalDateTime>,
  timezone: string,
): number {
  const local = zonedDateTimeParts(date, timezone);
  const fields = [
    "year",
    "month",
    "day",
    "hour",
    "minute",
    "second",
    "millisecond",
  ] as const;

  for (const field of fields) {
    const diff = local[field] - target[field];
    if (diff !== 0) {
      return diff;
    }
  }

  return 0;
}

function firstInstantAtOrAfterLocalDateTime(
  target: Required<CreatorLocalDateTime>,
  timezone: string,
  localAsUtcMs: number,
): Date {
  const startMs = localAsUtcMs - 36 * HOUR_MS;
  const endMs = localAsUtcMs + 36 * HOUR_MS;

  for (
    let candidateMs = startMs;
    candidateMs <= endMs;
    candidateMs += MINUTE_MS
  ) {
    const candidate = new Date(candidateMs);
    if (compareZonedDateTime(candidate, target, timezone) >= 0) {
      return candidate;
    }
  }

  throw new Error(`Could not resolve local time in ${timezone}.`);
}

function assertValidDate(value: Date, label: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`${label} must be a valid Date.`);
  }
}
