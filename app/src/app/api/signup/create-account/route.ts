import { handleCreateSignupAccount } from "../../../../../lib/signup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return handleCreateSignupAccount(request);
}
