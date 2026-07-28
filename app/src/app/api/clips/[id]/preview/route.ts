import { handleGetClipPreview } from "../../../../../../lib/review-api";

type ClipRouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export function GET(request: Request, context: ClipRouteContext) {
  return handleGetClipPreview(request, context.params);
}
