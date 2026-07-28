import { randomBytes } from "node:crypto";

import { prisma } from "../lib/db";
import { normalizeAccessCode } from "../lib/review-auth";

type ParsedArgs = {
  creatorId: string;
  code: string | null;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const code = args.code ? normalizeAccessCode(args.code) : await generateUniqueCode();

  const creator = await prisma.creator.update({
    where: {
      id: args.creatorId,
    },
    data: {
      accessCode: code,
    },
    select: {
      id: true,
      accessCode: true,
    },
  });

  console.log(
    [
      "PASSED set access code",
      `creatorId=${creator.id}`,
      `accessCode=${creator.accessCode}`,
    ].join(" "),
  );
}

function parseArgs(args: string[]): ParsedArgs {
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  const creatorId = readOption(args, "--creator-id");
  const code = readOption(args, "--code");

  if (!creatorId) {
    throw new Error(
      "Usage: npm run set:access-code -- --creator-id <id> [--code <code>]",
    );
  }

  return {
    creatorId,
    code,
  };
}

async function generateUniqueCode(): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = randomBytes(9).toString("base64url").toLowerCase();
    const existing = await prisma.creator.findUnique({
      where: {
        accessCode: code,
      },
      select: {
        id: true,
      },
    });
    if (!existing) {
      return code;
    }
  }

  throw new Error("Could not generate a unique creator access code.");
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

function printUsage() {
  console.log(
    [
      "Usage:",
      "  npm run set:access-code -- --creator-id <id> [--code <code>]",
      "",
      "Options:",
      "  --creator-id <id>   Creator to enable for review login.",
      "  --code <code>       Optional code to set instead of generating one.",
    ].join("\n"),
  );
}

main()
  .catch((error: unknown) => {
    console.log("FAILED set access code");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
