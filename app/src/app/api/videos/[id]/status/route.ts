import { handleGetVideoStatus } from "../../../../../../lib/video-api";

type VideoRouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request, context: VideoRouteContext) {
  return handleGetVideoStatus(request, context.params);
}
