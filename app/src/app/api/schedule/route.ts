import { handleGetSchedule, handlePutSchedule } from "../../../../lib/schedule-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return handleGetSchedule(request);
}

export function PUT(request: Request) {
  return handlePutSchedule(request);
}
