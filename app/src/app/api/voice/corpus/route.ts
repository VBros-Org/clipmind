import {
  handleSaveCaptionCorpus,
  handleTeachVoice,
} from "../../../../../lib/voice-corpus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function PUT(request: Request) {
  return handleSaveCaptionCorpus(request);
}

export function POST(request: Request) {
  return handleTeachVoice(request);
}
