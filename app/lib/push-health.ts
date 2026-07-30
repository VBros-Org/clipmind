export const PUSH_HEALTH_CARD_TITLE = "Nudges are off. Tap to fix.";
export const PUSH_HEALTH_FIX_HREF = "/rhythm?push=fix";
export const PUSH_HEALTH_EVENT_NAME = "clipmind:push-health";
export const PUSH_HEALTH_ISSUE_STORAGE_KEY = "clipmind.pushHealth.issue";
export const PUSH_HEALTH_DISMISSED_STORAGE_KEY =
  "clipmind.pushHealth.dismissed";
export const PUSH_HEALTH_SYNC_STORAGE_KEY = "clipmind.pushHealth.launchSync";

export type PushNotificationPermission =
  | "default"
  | "denied"
  | "granted"
  | "unsupported";

export type PushHealthIssue = "permission" | "refresh";

export type PushHealthLaunchDecision =
  | {
      action: "skip";
      issue: null;
    }
  | {
      action: "sync";
      issue: null;
    }
  | {
      action: "show_card";
      issue: PushHealthIssue;
    };

export function decidePushHealthLaunch(args: {
  pushEnabled: boolean;
  notificationPermission: PushNotificationPermission;
  syncAlreadyRun: boolean;
}): PushHealthLaunchDecision {
  if (!args.pushEnabled) {
    return {
      action: "skip",
      issue: null,
    };
  }

  if (args.notificationPermission !== "granted") {
    return {
      action: "show_card",
      issue: "permission",
    };
  }

  if (args.syncAlreadyRun) {
    return {
      action: "skip",
      issue: null,
    };
  }

  return {
    action: "sync",
    issue: null,
  };
}

export function pushHealthIssueAfterRefreshFailure(
  pushEnabled: boolean,
): PushHealthIssue | null {
  return pushEnabled ? "refresh" : null;
}

export function shouldShowPushHealthCard(args: {
  pushEnabled: boolean;
  issue: PushHealthIssue | null;
  dismissed: boolean;
}): boolean {
  return args.pushEnabled && Boolean(args.issue) && !args.dismissed;
}
