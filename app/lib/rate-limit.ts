// In-process fixed-window rate limiter for the login form. Jam-scale by
// design: one app instance, so process-local state is the whole picture.
// 10 attempts per IP per 5-minute window; windows reset wholesale, and the
// map is pruned on write so it cannot grow unbounded.

const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS_PER_WINDOW = 10;
const MAX_TRACKED_KEYS = 10_000;

type WindowState = {
  windowStartMs: number;
  attempts: number;
};

const loginWindows = new Map<string, WindowState>();

export function loginRateLimitKey(
  forwardedFor: string | null | undefined,
): string {
  const first = (forwardedFor ?? "").split(",")[0]?.trim();
  return first || "unknown";
}

export function consumeLoginAttempt(
  key: string,
  now: Date = new Date(),
): { allowed: boolean } {
  const nowMs = now.getTime();
  pruneExpired(nowMs);

  const state = loginWindows.get(key);
  if (!state || nowMs - state.windowStartMs >= LOGIN_WINDOW_MS) {
    loginWindows.set(key, { windowStartMs: nowMs, attempts: 1 });
    return { allowed: true };
  }

  state.attempts += 1;
  return { allowed: state.attempts <= LOGIN_MAX_ATTEMPTS_PER_WINDOW };
}

export function resetLoginRateLimiter(): void {
  loginWindows.clear();
}

function pruneExpired(nowMs: number): void {
  if (loginWindows.size < MAX_TRACKED_KEYS) {
    return;
  }

  for (const [key, state] of loginWindows) {
    if (nowMs - state.windowStartMs >= LOGIN_WINDOW_MS) {
      loginWindows.delete(key);
    }
  }
}
