"use client";

import {
  PUSH_HEALTH_DISMISSED_STORAGE_KEY,
  PUSH_HEALTH_EVENT_NAME,
  PUSH_HEALTH_ISSUE_STORAGE_KEY,
  PUSH_HEALTH_SYNC_STORAGE_KEY,
  type PushHealthIssue,
} from "../../lib/push-health";

export function readPushHealthIssue(): PushHealthIssue | null {
  const issue = readSessionValue(PUSH_HEALTH_ISSUE_STORAGE_KEY);
  return issue === "permission" || issue === "refresh" ? issue : null;
}

export function isPushHealthDismissed(): boolean {
  return readSessionValue(PUSH_HEALTH_DISMISSED_STORAGE_KEY) === "1";
}

export function hasPushHealthLaunchSyncRun(): boolean {
  return Boolean(readSessionValue(PUSH_HEALTH_SYNC_STORAGE_KEY));
}

export function markPushHealthLaunchSyncStarted(): void {
  writeSessionValue(PUSH_HEALTH_SYNC_STORAGE_KEY, "started");
}

export function markPushHealthHealthy(): void {
  removeSessionValue(PUSH_HEALTH_ISSUE_STORAGE_KEY);
  removeSessionValue(PUSH_HEALTH_DISMISSED_STORAGE_KEY);
  writeSessionValue(PUSH_HEALTH_SYNC_STORAGE_KEY, "done");
  dispatchPushHealthChange();
}

export function markPushHealthIssue(issue: PushHealthIssue): void {
  const currentIssue = readPushHealthIssue();
  if (currentIssue !== issue) {
    removeSessionValue(PUSH_HEALTH_DISMISSED_STORAGE_KEY);
  }

  writeSessionValue(PUSH_HEALTH_ISSUE_STORAGE_KEY, issue);
  dispatchPushHealthChange();
}

export function dismissPushHealthIssue(): void {
  writeSessionValue(PUSH_HEALTH_DISMISSED_STORAGE_KEY, "1");
  dispatchPushHealthChange();
}

function readSessionValue(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSessionValue(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // Session storage can be unavailable in private or locked-down contexts.
  }
}

function removeSessionValue(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // Session storage can be unavailable in private or locked-down contexts.
  }
}

function dispatchPushHealthChange(): void {
  window.dispatchEvent(new Event(PUSH_HEALTH_EVENT_NAME));
}
