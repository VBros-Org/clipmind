import { handleGetRecentUploads } from "../../../../../lib/video-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return handleGetRecentUploads(request);
}
