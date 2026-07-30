import {
  handleGetChannelPullStatus,
  handleStartChannelPull,
} from "../../../../../lib/channelPull";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 3600;

export function GET(request: Request) {
  return handleGetChannelPullStatus(request);
}

export function POST(request: Request) {
  return handleStartChannelPull(request);
}
