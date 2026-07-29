import test from "node:test";
import assert from "node:assert/strict";

import { distillTenetsWithOpenAI } from "../lib/openai-distill";
import { buildVoiceDistillMessages } from "../lib/prompts/voice-distill";
import type { InitialTenets } from "../lib/tenets";
import type { Transcript } from "../lib/transcript";

const validTenets: InitialTenets = {
  version: "voice-distill-v1",
  generatedAt: "2026-07-26T00:00:00.000Z",
  voiceProfile: {
    sentenceStructure: ["Short setup, then a quick punchline."],
    phrasingHabits: ["Uses wait and watch to focus attention."],
    hookStyle: ["Opens with an immediate reaction."],
    vocabulary: ["wait", "moment"],
  },
  clipTasteProfile: {
    preferredMoments: ["Sudden reversals after a quiet setup."],
    pacing: ["Fast setup with payoff inside ten seconds."],
    emotionalSignals: ["Surprised laughter and rising volume."],
    clipPatterns: ["Setup, mistake, reaction."],
  },
  guardrails: ["Keep the dry reaction style."],
};

test("voice distill prompt gives existing clips highest weight", () => {
  const sourceTranscript = transcript("Long form source text.");
  const clipTranscript = transcript("Creator approved clip text.");

  const messages = buildVoiceDistillMessages([
    {
      source: "source.mp4",
      sourceType: "source_video",
      weight: 1,
      transcript: sourceTranscript,
    },
    {
      source: "clip.mp4",
      sourceType: "existing_clip",
      weight: 3,
      transcript: clipTranscript,
    },
  ]);

  const userPrompt = messages[1]?.content ?? "";
  assert.match(userPrompt, /Weight 3 means creator-approved existing clip/);
  const clipIndex = userPrompt.indexOf("source: clip.mp4");
  const sourceIndex = userPrompt.indexOf("source: source.mp4");
  assert.notEqual(clipIndex, -1);
  assert.notEqual(sourceIndex, -1);
  assert.ok(clipIndex < sourceIndex);
  assert.match(userPrompt, /type: existing_clip\nweight: 3/);
});

test("voice distill prompt adds pasted captions as primary caption voice evidence", () => {
  const messages = buildVoiceDistillMessages(
    [
      {
        source: "source.mp4",
        sourceType: "source_video",
        weight: 1,
        transcript: transcript("Spoken source text."),
      },
    ],
    {
      captionCorpus:
        "bro the copper hoe actually saved me\narcs be killing bro, rip",
    },
  );

  assert.match(
    messages[0]?.content ?? "",
    /Written post-copy captions are primary evidence for caption voice/,
  );
  assert.match(
    messages[0]?.content ?? "",
    /Video transcripts remain primary evidence for spoken voice/,
  );
  assert.match(messages[1]?.content ?? "", /Caption 1: bro the copper hoe/);
  assert.match(messages[1]?.content ?? "", /Caption 2: arcs be killing bro/);
});

test("voice distill prompt is unchanged when captions are absent", () => {
  const input = [
    {
      source: "clip.mp4",
      sourceType: "existing_clip" as const,
      weight: 3,
      transcript: transcript("Wait, this is the moment."),
    },
  ];

  assert.deepEqual(
    buildVoiceDistillMessages(input),
    buildVoiceDistillMessages(input, {
      captionCorpus: "",
    }),
  );
});

test("OpenAI distillation validates the Tenet JSON shape", async () => {
  const tenets = await distillTenetsWithOpenAI({
    client: fakeOpenAI(JSON.stringify(validTenets)),
        model: "test-model",
        generatedAt: validTenets.generatedAt,
        captionCorpus: "have you ever seen a run saved at zero seconds",
        transcripts: [
          {
            source: "clip.mp4",
        sourceType: "existing_clip",
        weight: 3,
        transcript: transcript("Wait, this is the moment."),
      },
    ],
  });

  assert.deepEqual(tenets, validTenets);
});

test("OpenAI distillation rejects malformed Tenet JSON", async () => {
  await assert.rejects(
    () =>
      distillTenetsWithOpenAI({
        client: fakeOpenAI(JSON.stringify({ version: "voice-distill-v1" })),
        model: "test-model",
        transcripts: [
          {
            source: "clip.mp4",
            sourceType: "existing_clip",
            weight: 3,
            transcript: transcript("Wait, this is the moment."),
          },
        ],
      }),
    /generatedAt/,
  );
});

function transcript(text: string): Transcript {
  return {
    text,
    segments: [
      {
        start_ms: 0,
        end_ms: 1_000,
        text,
      },
    ],
    words: [],
  };
}

function fakeOpenAI(content: string) {
  return {
    chat: {
      completions: {
        async create() {
          return {
            choices: [
              {
                message: {
                  content,
                },
              },
            ],
          };
        },
      },
    },
  };
}
