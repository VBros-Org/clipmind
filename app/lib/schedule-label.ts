export function formatScheduledForLabel(
  value: Date | string | null | undefined,
  options: {
    timeZone?: string;
  } = {},
): string | null {
  const date = parseDate(value);
  if (!date) {
    return null;
  }

  const parts = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: options.timeZone,
  }).formatToParts(date);
  const weekday = partValue(parts, "weekday");
  const hour = partValue(parts, "hour");
  const minute = partValue(parts, "minute");

  if (!weekday || !hour || !minute) {
    return null;
  }

  return `Scheduled for ${weekday} ${hour}:${minute}`;
}

function parseDate(value: Date | string | null | undefined): Date | null {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function partValue(
  parts: Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): string | null {
  return parts.find((part) => part.type === type)?.value ?? null;
}
