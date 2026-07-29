import { handleDeleteVideo } from "../../../../../lib/video-api";

type VideoRouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function DELETE(request: Request, context: VideoRouteContext) {
  return handleDeleteVideo(request, context.params);
}
