import { handleAbortMultipartUpload } from "../../../../../../../../lib/video-api";

type MultipartUploadRouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request, context: MultipartUploadRouteContext) {
  return handleAbortMultipartUpload(request, context.params);
}
