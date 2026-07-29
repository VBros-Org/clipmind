import OpenAI from "openai";

import {
  buildVoiceDistillMessages,
  type VoiceDistillEvidence,
  type WeightedTranscript,
} from "./prompts/voice-distill";
import { parseInitialTenets, type InitialTenets } from "./tenets";

export interface ChatCompletionClient {
  chat: {
    completions: {
      create(args: {
        model: string;
        messages: { role: "system" | "user"; content: string }[];
        response_format: { type: "json_object" };
        temperature: number;
      }): Promise<{
        choices: { message: { content: string | null } }[];
      }>;
    };
  };
}

export function createOpenAITenetDistiller(
  env = process.env,
): (
  transcripts: WeightedTranscript[],
  evidence?: VoiceDistillEvidence,
) => Promise<InitialTenets> {
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for Tenet distillation.");
  }

  const model = env.OPENAI_DISTILL_MODEL?.trim() || "gpt-4o-mini";
  const client = new OpenAI({ apiKey });

  return (transcripts, evidence) =>
    distillTenetsWithOpenAI({
      client,
      model,
      transcripts,
      captionCorpus: evidence?.captionCorpus,
    });
}

export async function distillTenetsWithOpenAI(args: {
  client: ChatCompletionClient;
  model: string;
  transcripts: WeightedTranscript[];
  captionCorpus?: string | null;
  generatedAt?: string;
}): Promise<InitialTenets> {
  const response = await args.client.chat.completions.create({
    model: args.model,
    messages: buildVoiceDistillMessages(args.transcripts, {
      captionCorpus: args.captionCorpus,
    }),
    response_format: { type: "json_object" },
    temperature: 0.2,
  });

  const content = response.choices[0]?.message.content;
  if (!content) {
    throw new Error("OpenAI distillation returned no content.");
  }

  return {
    ...parseInitialTenets(content),
    generatedAt: args.generatedAt ?? new Date().toISOString(),
  };
}
