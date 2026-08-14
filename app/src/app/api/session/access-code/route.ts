import { handleRevealCreatorAccessCode } from "../../../../../lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return handleRevealCreatorAccessCode(request);
}
