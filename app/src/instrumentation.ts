export async function register() {
  if (process.env.NEXT_RUNTIME === "edge") {
    return;
  }

  const { startPushTickInterval } = await import("../lib/push-tick-interval");
  startPushTickInterval();
}
