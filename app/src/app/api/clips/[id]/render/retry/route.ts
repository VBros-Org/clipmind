import { handleRetryClipRender } from "../../../../../../../lib/review-api";

type ClipRouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export function POST(request: Request, context: ClipRouteContext) {
  return handleRetryClipRender(request, context.params);
}
