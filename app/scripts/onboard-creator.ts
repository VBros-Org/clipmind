import { createClipServiceTranscriber, clipServiceConfigFromEnv } from "../lib/clip-service";
import { prisma } from "../lib/db";
import { createMindsClientFromEnv } from "../lib/minds";
import { onboardCreator, corpusItemFromSource } from "../lib/onboarding";
import { createPrismaOnboardingRepository } from "../lib/onboarding-repository";
import { createOpenAITenetDistiller } from "../lib/openai-distill";
import type { CorpusSourceType } from "../lib/prompts/voice-distill";

interface CliOptions {
  creatorId?: string;
  channelUrl?: string;
  stewardEmail?: string;
  corpus: { source: string; sourceType: CorpusSourceType }[];
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const corpusItems = options.corpus.map((item) =>
    corpusItemFromSource(item.source, item.sourceType),
  );

  const result = await onboardCreator({
    creatorId: options.creatorId,
    channelUrl: options.channelUrl,
    stewardEmail: options.stewardEmail,
    corpusItems,
    repository: createPrismaOnboardingRepository(prisma),
    transcribeItem: createClipServiceTranscriber(clipServiceConfigFromEnv()),
    distillTenets: createOpenAITenetDistiller(),
    mindsClient: createMindsClientFromEnv(),
  });

  console.log(`Creator id=${result.creatorId}`);
  console.log(`Transcripts ingested=${result.transcriptCount}`);
  console.log("Distilled Tenet JSON:");
  console.log(JSON.stringify(result.tenets, null, 2));

  if (result.status === "DEFERRED") {
    console.log(`DEFERRED creator onboarding: ${result.message}`);
    return;
  }

  console.log(`Mind id=${result.mindId}`);
  console.log(`Mind email=${result.mindEmail}`);
  console.log("Verify Tenets reply:");
  console.log(result.verifyTenetsReply);
  console.log("PASSED creator onboarding");
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    corpus: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    if (arg === "--creator-id" || arg === "--creator") {
      options.creatorId = readValue(argv, (index += 1), arg);
      continue;
    }

    if (arg === "--channel-url") {
      options.channelUrl = readValue(argv, (index += 1), arg);
      continue;
    }

    if (arg === "--steward-email") {
      options.stewardEmail = readValue(argv, (index += 1), arg);
      continue;
    }

    if (arg === "--clip" || arg === "--existing-clip") {
      options.corpus.push({
        source: readValue(argv, (index += 1), arg),
        sourceType: "existing_clip",
      });
      continue;
    }

    if (arg === "--video" || arg === "--source" || arg === "--url") {
      options.corpus.push({
        source: readValue(argv, (index += 1), arg),
        sourceType: "source_video",
      });
      continue;
    }

    if (arg.startsWith("--")) {
      throw new Error(`Unknown option ${arg}`);
    }

    options.corpus.push(parsePositionalSource(arg));
  }

  if (options.corpus.length === 0) {
    throw new Error("Provide at least one corpus video path or URL.");
  }

  return options;
}

function parsePositionalSource(value: string): {
  source: string;
  sourceType: CorpusSourceType;
} {
  if (value.startsWith("clip:")) {
    return {
      source: value.slice("clip:".length),
      sourceType: "existing_clip",
    };
  }

  if (value.startsWith("video:")) {
    return {
      source: value.slice("video:".length),
      sourceType: "source_video",
    };
  }

  return {
    source: value,
    sourceType: "source_video",
  };
}

function readValue(argv: string[], index: number, option: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  npm run onboard:creator -- --creator-id <id|new> --video <path-or-url>",
      "  npm run onboard:creator -- --creator-id <id|new> --clip <path-or-url>",
      "",
      "Options:",
      "  --creator-id <id|new>    Use an existing id, create that id, or pass new.",
      "  --channel-url <url>       Optional channel URL for new creators.",
      "  --steward-email <email>   Optional steward email for the new Mind.",
      "  --video <path-or-url>     Source video or long-form corpus item.",
      "  --clip <path-or-url>      Existing posted clip, weighted highest.",
      "  clip:<path-or-url>        Positional existing clip shorthand.",
    ].join("\n"),
  );
}

main()
  .catch((error: unknown) => {
    console.log("FAILED creator onboarding");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
