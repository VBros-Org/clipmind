export const REJECT_UNDO_WINDOW_MS = 6_000;

export type RejectUndoCommitCause = "timer" | "background" | "navigation";

export type RejectUndoSnapshot = {
  clipId: string;
  deadlineMs: number;
  remainingMs: number;
};

type TimerHandle = unknown;

type RejectUndoTimerOptions = {
  commit(clipId: string, cause: RejectUndoCommitCause): void;
  windowMs?: number;
  now?: () => number;
  setTimeoutImpl?: (handler: () => void, timeoutMs: number) => TimerHandle;
  clearTimeoutImpl?: (handle: TimerHandle) => void;
};

type PendingReject = {
  deadlineMs: number;
  timer: TimerHandle;
};

export class RejectUndoTimer {
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly setTimeoutImpl: (
    handler: () => void,
    timeoutMs: number,
  ) => TimerHandle;
  private readonly clearTimeoutImpl: (handle: TimerHandle) => void;
  private readonly pending = new Map<string, PendingReject>();

  constructor(private readonly options: RejectUndoTimerOptions) {
    this.windowMs = options.windowMs ?? REJECT_UNDO_WINDOW_MS;
    this.now = options.now ?? Date.now;
    this.setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
    this.clearTimeoutImpl =
      options.clearTimeoutImpl ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  start(clipId: string): RejectUndoSnapshot {
    this.undo(clipId);

    const deadlineMs = this.now() + this.windowMs;
    const timer = this.setTimeoutImpl(() => {
      this.commitNow(clipId, "timer");
    }, this.windowMs);
    this.pending.set(clipId, {
      deadlineMs,
      timer,
    });

    return this.snapshot(clipId) ?? {
      clipId,
      deadlineMs,
      remainingMs: this.windowMs,
    };
  }

  undo(clipId: string): boolean {
    const pending = this.pending.get(clipId);
    if (!pending) {
      return false;
    }

    this.clearTimeoutImpl(pending.timer);
    this.pending.delete(clipId);
    return true;
  }

  commitNow(clipId: string, cause: RejectUndoCommitCause): boolean {
    const pending = this.pending.get(clipId);
    if (!pending) {
      return false;
    }

    this.clearTimeoutImpl(pending.timer);
    this.pending.delete(clipId);
    this.options.commit(clipId, cause);
    return true;
  }

  commitAll(cause: RejectUndoCommitCause): string[] {
    const clipIds = [...this.pending.keys()];
    for (const clipId of clipIds) {
      this.commitNow(clipId, cause);
    }
    return clipIds;
  }

  snapshot(clipId: string): RejectUndoSnapshot | null {
    const pending = this.pending.get(clipId);
    if (!pending) {
      return null;
    }

    return {
      clipId,
      deadlineMs: pending.deadlineMs,
      remainingMs: Math.max(0, pending.deadlineMs - this.now()),
    };
  }

  snapshots(): RejectUndoSnapshot[] {
    return [...this.pending.keys()]
      .map((clipId) => this.snapshot(clipId))
      .filter((snapshot): snapshot is RejectUndoSnapshot => snapshot !== null);
  }
}
