import { randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";

export const WORKFLOW_LEASE_TTL_MS = 10 * 60 * 1000;
export const WORKFLOW_HEARTBEAT_INTERVAL_MS = 60 * 1000;
export const WORKFLOW_LEASE_TTL_LABEL = "10 minutes";

export class WorkflowLeaseLostError extends Error {
  constructor(workflow: string, id: string) {
    super(`${workflow} ${id} is owned by another active run.`);
  }
}

export function newWorkflowRunId(workflow: string): string {
  return `${workflow}-${randomUUID()}`;
}

export function isWorkflowLeaseExpired(
  heartbeatAt: Date | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!heartbeatAt) {
    return true;
  }

  return now.getTime() - heartbeatAt.getTime() > WORKFLOW_LEASE_TTL_MS;
}

export function workflowLeaseExpiredError(stage: string): string {
  return `${stage}: Workflow lease expired after ${WORKFLOW_LEASE_TTL_LABEL}.`;
}

export function incrementStageAttempt(
  value: Prisma.JsonValue | null | undefined,
  stage: string,
): Prisma.InputJsonValue {
  const attempts = stageAttempts(value);
  attempts[stage] = (attempts[stage] ?? 0) + 1;
  return attempts;
}

export function stageAttempts(
  value: Prisma.JsonValue | null | undefined,
): Record<string, number> {
  if (!isRecord(value)) {
    return {};
  }

  const attempts: Record<string, number> = {};
  for (const [stage, count] of Object.entries(value)) {
    if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) {
      attempts[stage] = count;
    }
  }

  return attempts;
}

export async function withWorkflowHeartbeat<T>(
  heartbeat: () => Promise<void>,
  work: () => Promise<T>,
  intervalMs = WORKFLOW_HEARTBEAT_INTERVAL_MS,
): Promise<T> {
  await heartbeat();
  const timer = setInterval(() => {
    void heartbeat().catch(() => undefined);
  }, intervalMs);
  timer.unref?.();

  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
