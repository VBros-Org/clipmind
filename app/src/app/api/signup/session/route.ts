import { handleGetSignupSession } from "../../../../../lib/signup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return handleGetSignupSession(request);
}
