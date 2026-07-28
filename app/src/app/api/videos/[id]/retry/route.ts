import { handleRetryVideo } from "../../../../../../lib/video-api";

type VideoRouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request, context: VideoRouteContext) {
  return handleRetryVideo(request, context.params);
}
