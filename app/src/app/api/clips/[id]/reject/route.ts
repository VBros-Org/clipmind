import { handleRejectClip } from "../../../../../../lib/review-api";

type ClipRouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export function POST(request: Request, context: ClipRouteContext) {
  return handleRejectClip(request, context.params);
}
