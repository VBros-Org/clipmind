"use client";

import { useEffect } from "react";

import {
  decidePushHealthLaunch,
  pushHealthIssueAfterRefreshFailure,
} from "../../lib/push-health";
import {
  notificationPermissionState,
  subscribeToPushNudges,
} from "./rhythm/push-client";
import {
  hasPushHealthLaunchSyncRun,
  markPushHealthHealthy,
  markPushHealthIssue,
  markPushHealthLaunchSyncStarted,
} from "./push-health-client";

export function PushHealthLaunchSync({
  pushNudgesEnabled,
}: {
  pushNudgesEnabled: boolean;
}) {
  useEffect(() => {
    const decision = decidePushHealthLaunch({
      pushEnabled: pushNudgesEnabled,
      notificationPermission: notificationPermissionState(),
      syncAlreadyRun: hasPushHealthLaunchSyncRun(),
    });

    if (decision.action === "show_card") {
      markPushHealthIssue(decision.issue);
      return;
    }

    if (decision.action !== "sync") {
      return;
    }

    markPushHealthLaunchSyncStarted();
    void subscribeToPushNudges({ requestPermission: false })
      .then(() => {
        markPushHealthHealthy();
      })
      .catch((error) => {
        console.error("Push subscription refresh failed", error);
        const issue = pushHealthIssueAfterRefreshFailure(pushNudgesEnabled);
        if (issue) {
          markPushHealthIssue(issue);
        }
      });
  }, [pushNudgesEnabled]);

  return null;
}
