const MAX_CREATOR_TIMEZONE_LENGTH = 100;

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

function isValidTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function assertValidDate(value: Date, label: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`${label} must be a valid Date.`);
  }
}
