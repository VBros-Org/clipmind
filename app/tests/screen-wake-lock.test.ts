import test from "node:test";
import assert from "node:assert/strict";

import {
  ScreenWakeLockManager,
  type WakeLockDocumentLike,
  type WakeLockNavigatorLike,
  type WakeLockSentinelLike,
} from "../lib/screen-wake-lock";

test("screen wake lock requests and releases while a transfer is active", async () => {
  const documentLike = new FakeDocument();
  const sentinel = new FakeWakeLockSentinel();
  const requests: string[] = [];
  const navigatorLike: WakeLockNavigatorLike = {
    wakeLock: {
      async request(type) {
        requests.push(type);
        return sentinel;
      },
    },
  };
  const manager = new ScreenWakeLockManager(navigatorLike, documentLike);

  await manager.start();
  await manager.stop();

  assert.deepEqual(requests, ["screen"]);
  assert.equal(sentinel.releaseCount, 1);
  assert.equal(documentLike.listenerCount("visibilitychange"), 0);
});

test("screen wake lock re-requests on visibility after browser release", async () => {
  const documentLike = new FakeDocument();
  const firstSentinel = new FakeWakeLockSentinel();
  const secondSentinel = new FakeWakeLockSentinel();
  const sentinels = [firstSentinel, secondSentinel];
  const navigatorLike: WakeLockNavigatorLike = {
    wakeLock: {
      async request() {
        const sentinel = sentinels.shift();
        if (!sentinel) {
          throw new Error("unexpected request");
        }
        return sentinel;
      },
    },
  };
  const manager = new ScreenWakeLockManager(navigatorLike, documentLike);

  await manager.start();
  documentLike.visibilityState = "hidden";
  firstSentinel.emitRelease();
  assert.equal(sentinels.length, 1);

  documentLike.visibilityState = "visible";
  documentLike.emit("visibilitychange");
  await Promise.resolve();

  assert.equal(sentinels.length, 0);
});

test("screen wake lock unsupported browsers are a no-op", async () => {
  const documentLike = new FakeDocument();
  const manager = new ScreenWakeLockManager({}, documentLike);

  await manager.start();
  await manager.stop();

  assert.equal(documentLike.listenerCount("visibilitychange"), 0);
});

class FakeDocument implements WakeLockDocumentLike {
  visibilityState = "visible";
  private readonly listeners = new Map<string, Set<() => void>>();

  addEventListener(event: "visibilitychange", listener: () => void) {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  removeEventListener(event: "visibilitychange", listener: () => void) {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: "visibilitychange") {
    for (const listener of this.listeners.get(event) ?? []) {
      listener();
    }
  }

  listenerCount(event: "visibilitychange"): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

class FakeWakeLockSentinel implements WakeLockSentinelLike {
  releaseCount = 0;
  private readonly releaseListeners = new Set<() => void>();

  release() {
    this.releaseCount += 1;
  }

  addEventListener(event: "release", listener: () => void) {
    this.releaseListeners.add(listener);
  }

  removeEventListener(event: "release", listener: () => void) {
    this.releaseListeners.delete(listener);
  }

  emitRelease() {
    for (const listener of this.releaseListeners) {
      listener();
    }
  }
}
