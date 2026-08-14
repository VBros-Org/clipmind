import { handleCreateMultipartUpload } from "../../../../../../lib/video-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return handleCreateMultipartUpload(request);
}
