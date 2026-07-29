type WakeLockType = "screen";
type WakeLockEvent = "release";
type VisibilityEvent = "visibilitychange";

export type WakeLockSentinelLike = {
  release?: () => Promise<void> | void;
  addEventListener?: (event: WakeLockEvent, listener: () => void) => void;
  removeEventListener?: (event: WakeLockEvent, listener: () => void) => void;
};

export type WakeLockNavigatorLike = {
  wakeLock?: {
    request?: (type: WakeLockType) => Promise<WakeLockSentinelLike>;
  } | null;
};

export type WakeLockDocumentLike = {
  visibilityState?: string;
  addEventListener?: (event: VisibilityEvent, listener: () => void) => void;
  removeEventListener?: (event: VisibilityEvent, listener: () => void) => void;
};

export class ScreenWakeLockManager {
  private active = false;
  private listening = false;
  private requestInFlight: Promise<void> | null = null;
  private sentinel: WakeLockSentinelLike | null = null;

  private readonly handleRelease = () => {
    this.sentinel = null;
    if (this.active && this.isVisible()) {
      void this.requestLock();
    }
  };

  private readonly handleVisibilityChange = () => {
    if (this.active && this.isVisible()) {
      void this.requestLock();
    }
  };

  constructor(
    private readonly navigatorLike: WakeLockNavigatorLike,
    private readonly documentLike: WakeLockDocumentLike,
  ) {}

  start(): Promise<void> {
    this.active = true;
    this.attachVisibilityListener();
    return this.requestLock();
  }

  async stop(): Promise<void> {
    this.active = false;
    this.detachVisibilityListener();
    await this.releaseLock();
  }

  private attachVisibilityListener() {
    if (this.listening) {
      return;
    }

    this.documentLike.addEventListener?.(
      "visibilitychange",
      this.handleVisibilityChange,
    );
    this.listening = true;
  }

  private detachVisibilityListener() {
    if (!this.listening) {
      return;
    }

    this.documentLike.removeEventListener?.(
      "visibilitychange",
      this.handleVisibilityChange,
    );
    this.listening = false;
  }

  private requestLock(): Promise<void> {
    if (!this.active || !this.isVisible()) {
      return Promise.resolve();
    }

    const request = this.navigatorLike.wakeLock?.request;
    if (!request || this.sentinel || this.requestInFlight) {
      return this.requestInFlight ?? Promise.resolve();
    }

    const nextRequest = request("screen")
      .then(async (sentinel) => {
        if (!this.active) {
          await releaseSentinel(sentinel);
          return;
        }

        this.sentinel = sentinel;
        sentinel.addEventListener?.("release", this.handleRelease);
      })
      .catch(() => {
        // Unsupported browsers and permission failures should not block upload.
      })
      .finally(() => {
        if (this.requestInFlight === nextRequest) {
          this.requestInFlight = null;
        }
      });

    this.requestInFlight = nextRequest;
    return nextRequest;
  }

  private async releaseLock() {
    const sentinel = this.sentinel;
    this.sentinel = null;
    if (!sentinel) {
      return;
    }

    sentinel.removeEventListener?.("release", this.handleRelease);
    await releaseSentinel(sentinel);
  }

  private isVisible(): boolean {
    return this.documentLike.visibilityState !== "hidden";
  }
}

export function createScreenWakeLockManager(
  navigatorLike: WakeLockNavigatorLike,
  documentLike: WakeLockDocumentLike,
) {
  return new ScreenWakeLockManager(navigatorLike, documentLike);
}

async function releaseSentinel(sentinel: WakeLockSentinelLike) {
  try {
    await sentinel.release?.();
  } catch {
    // A wake lock may already be released by the browser.
  }
}
