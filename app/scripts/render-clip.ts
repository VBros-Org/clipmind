import { renderClip } from "../lib/render";
import { prisma } from "../lib/db";

type ParsedArgs = {
  clipId: string;
  preset: string;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await renderClip(args.clipId, args.preset);

  console.log(
    [
      "PASSED render clip",
      `clipId=${result.clipId}`,
      `videoId=${result.videoId}`,
      `preset=${args.preset}`,
      `renderedUrl=${result.renderedUrl}`,
    ].join(" "),
  );
}

function parseArgs(args: string[]): ParsedArgs {
  const clipId = readOption(args, "--clip-id");
  const preset = readOption(args, "--preset");

  if (!clipId || !preset) {
    throw new Error(
      "Usage: npm run render:clip -- --clip-id <id> --preset <preset-id>",
    );
  }

  return {
    clipId,
    preset,
  };
}

function readOption(args: string[], name: string): string | null {
  const exactIndex = args.indexOf(name);

  if (exactIndex >= 0) {
    return args[exactIndex + 1] ?? null;
  }

  const prefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : null;
}

main()
  .catch((error: unknown) => {
    console.log("FAILED render clip");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
