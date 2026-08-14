import { handleSessionHeartbeat } from "../../../../../lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return handleSessionHeartbeat(request);
}
