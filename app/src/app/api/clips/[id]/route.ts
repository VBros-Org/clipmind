import { handleGetClip } from "../../../../../lib/review-api";

type ClipRouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export function GET(request: Request, context: ClipRouteContext) {
  return handleGetClip(request, context.params);
}
