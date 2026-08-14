import { handleGetMultipartUpload } from "../../../../../../../lib/video-api";

type MultipartUploadRouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request, context: MultipartUploadRouteContext) {
  return handleGetMultipartUpload(request, context.params);
}
