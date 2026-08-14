import test from "node:test";
import assert from "node:assert/strict";

import {
  consumeLoginAttempt,
  loginRateLimitKey,
  resetLoginRateLimiter,
} from "../lib/rate-limit";

test("login rate limiter allows 10 attempts per window then blocks", () => {
  resetLoginRateLimiter();
  const now = new Date("2026-08-14T10:00:00.000Z");

  for (let i = 0; i < 10; i += 1) {
    assert.equal(consumeLoginAttempt("1.2.3.4", now).allowed, true);
  }
  assert.equal(consumeLoginAttempt("1.2.3.4", now).allowed, false);

  // Other keys are unaffected.
  assert.equal(consumeLoginAttempt("5.6.7.8", now).allowed, true);

  // A new window resets the budget.
  const later = new Date(now.getTime() + 5 * 60 * 1000);
  assert.equal(consumeLoginAttempt("1.2.3.4", later).allowed, true);
});

test("login rate limit key uses the first forwarded address", () => {
  assert.equal(loginRateLimitKey("9.9.9.9, 10.0.0.1"), "9.9.9.9");
  assert.equal(loginRateLimitKey(null), "unknown");
  assert.equal(loginRateLimitKey("   "), "unknown");
});
