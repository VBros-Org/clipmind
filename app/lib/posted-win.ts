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

function safeCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
