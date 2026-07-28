import { Prisma } from "@prisma/client";

import { generateReadableInviteCode } from "../lib/invite-codes";
import { prisma } from "../lib/db";

type MintInviteOptions =
  | {
      mode: "list";
    }
  | {
      mode: "mint";
      note: string | null;
    };

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === "list") {
    await listInvites();
    return;
  }

  const invite = await createInvite(options.note);
  console.log(invite.code);
  if (invite.note) {
    console.log(`note=${invite.note}`);
  }
}

async function createInvite(note: string | null) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = generateReadableInviteCode();
    try {
      return await prisma.inviteCode.create({
        data: {
          code,
          note,
        },
        select: {
          code: true,
          note: true,
        },
      });
    } catch (error) {
      if (isUniqueConstraintError(error) && attempt < 7) {
        continue;
      }

      throw error;
    }
  }

  throw new Error("Could not mint a unique invite code.");
}

async function listInvites() {
  const invites = await prisma.inviteCode.findMany({
    orderBy: {
      createdAt: "desc",
    },
    select: {
      code: true,
      note: true,
      usedAt: true,
      createdAt: true,
      usedByCreator: {
        select: {
          id: true,
          displayName: true,
          channelUrl: true,
        },
      },
    },
  });

  if (invites.length === 0) {
    console.log("No invite codes minted.");
    return;
  }

  for (const invite of invites) {
    const usedBy = invite.usedByCreator
      ? `${invite.usedByCreator.displayName ?? "unnamed"} (${invite.usedByCreator.id})`
      : "unused";
    const channel = invite.usedByCreator?.channelUrl
      ? ` channel=${invite.usedByCreator.channelUrl}`
      : "";
    const note = invite.note ? ` note=${invite.note}` : "";
    const usedAt = invite.usedAt ? ` usedAt=${invite.usedAt.toISOString()}` : "";
    console.log(
      `${invite.code} ${usedBy} createdAt=${invite.createdAt.toISOString()}${usedAt}${channel}${note}`,
    );
  }
}

function parseArgs(args: string[]): MintInviteOptions {
  let note: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    if (arg === "--list") {
      return {
        mode: "list",
      };
    }

    if (arg === "--note") {
      note = readValue(args, (index += 1), arg);
      continue;
    }

    if (arg.startsWith("--note=")) {
      note = arg.slice("--note=".length);
      continue;
    }

    if (arg.startsWith("--")) {
      throw new Error(`Unknown option ${arg}`);
    }

    throw new Error(`Unexpected argument ${arg}`);
  }

  return {
    mode: "mint",
    note: note ? normalizeNote(note) : null,
  };
}

function normalizeNote(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 200);
}

function readValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002";
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  npm run mint:invite -- --note \"for judge X\"",
      "  npm run mint:invite -- --list",
    ].join("\n"),
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
