import { handleUploadVideo } from "../../../../../lib/video-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 3600;

export function POST(request: Request) {
  return handleUploadVideo(request);
}
