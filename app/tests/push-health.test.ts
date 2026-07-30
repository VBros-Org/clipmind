import test from "node:test";
import assert from "node:assert/strict";

import {
  decidePushHealthLaunch,
  pushHealthIssueAfterRefreshFailure,
  shouldShowPushHealthCard,
} from "../lib/push-health";

test("push health launch decision gates silent shell sync", () => {
  assert.deepEqual(
    decidePushHealthLaunch({
      pushEnabled: true,
      notificationPermission: "granted",
      syncAlreadyRun: false,
    }),
    {
      action: "sync",
      issue: null,
    },
  );

  assert.deepEqual(
    decidePushHealthLaunch({
      pushEnabled: true,
      notificationPermission: "denied",
      syncAlreadyRun: false,
    }),
    {
      action: "show_card",
      issue: "permission",
    },
  );

  assert.deepEqual(
    decidePushHealthLaunch({
      pushEnabled: true,
      notificationPermission: "granted",
      syncAlreadyRun: true,
    }),
    {
      action: "skip",
      issue: null,
    },
  );
});

test("push health card state follows permission and token refresh failures", () => {
  assert.equal(
    shouldShowPushHealthCard({
      pushEnabled: true,
      issue: "permission",
      dismissed: false,
    }),
    true,
  );

  assert.equal(
    shouldShowPushHealthCard({
      pushEnabled: true,
      issue: pushHealthIssueAfterRefreshFailure(true),
      dismissed: false,
    }),
    true,
  );

  assert.equal(
    shouldShowPushHealthCard({
      pushEnabled: true,
      issue: "refresh",
      dismissed: true,
    }),
    false,
  );

  assert.equal(pushHealthIssueAfterRefreshFailure(false), null);
});
