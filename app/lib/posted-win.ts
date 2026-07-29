export const POSTED_WIN_EVENT_NAME = "clipmind:posted-win";
export const POSTED_WIN_STORAGE_KEY = "clipmind.postedWinPending";

export type PostedWinStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export type PostedWinPayload = {
  postedThisWeek: number;
};

export function postedWinMessage(postedThisWeek: number): string {
  return `Posted. ${safeCount(postedThisWeek)} this week.`;
}

export function storePostedWin(
  storage: PostedWinStorage,
  postedThisWeek: number,
): void {
  try {
    storage.setItem(
      POSTED_WIN_STORAGE_KEY,
      JSON.stringify({
        postedThisWeek: safeCount(postedThisWeek),
      } satisfies PostedWinPayload),
    );
  } catch {
    // Session storage can be unavailable in private or locked-down browsers.
  }
}

export function consumePostedWin(
  storage: PostedWinStorage,
): PostedWinPayload | null {
  try {
    const raw = storage.getItem(POSTED_WIN_STORAGE_KEY);
    storage.removeItem(POSTED_WIN_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<PostedWinPayload> | null;
    if (!parsed || typeof parsed.postedThisWeek !== "number") {
      return null;
    }

    return {
      postedThisWeek: safeCount(parsed.postedThisWeek),
    };
  } catch {
    return null;
  }
}

export function startOfUtcWeek(date: Date): Date {
  assertValidDate(date, "date");
  const start = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const day = start.getUTCDay();
  const mondayOffset = day === 0 ? 6 : day - 1;
  start.setUTCDate(start.getUTCDate() - mondayOffset);
  return start;
}

function safeCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function assertValidDate(value: Date, label: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`${label} must be a valid Date.`);
  }
}
