import { handlePushTick } from "../../../../../lib/push-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return handlePushTick(request);
}
