import test from "node:test";
import assert from "node:assert/strict";

import { CREATOR_ACCESS_COOKIE } from "../lib/review-auth";
import { SIGNUP_CREATOR_COOKIE } from "../lib/signup";
import { handleLogoutCreatorSession } from "../lib/session";

test("logout route clears creator cookie and redirects without auth", () => {
  const response = handleLogoutCreatorSession();

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/login");
  assert.equal(response.headers.get("cache-control"), "no-store");

  const setCookie = response.headers.get("set-cookie") ?? "";
  assert.match(setCookie, new RegExp(`${CREATOR_ACCESS_COOKIE}=`));
  assert.match(setCookie, new RegExp(`${SIGNUP_CREATOR_COOKIE}=`));
  assert.match(setCookie, /Max-Age=0/);
  assert.match(setCookie, /Path=\//);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /HttpOnly/);
});
