import { prisma } from "../lib/db";

async function main() {
  const marker = `verify-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const created = await prisma.creator.create({
    data: {
      channelUrl: `https://example.com/${marker}`,
      mindId: `mind-${marker}`,
      captionStyle: {
        preset: "default",
      },
    },
  });

  console.log(`Created Creator id=${created.id}`);

  const found = await prisma.creator.findUnique({
    where: {
      id: created.id,
    },
  });

  if (!found || found.id !== created.id || found.channelUrl !== created.channelUrl) {
    console.log("FAILED Creator create/read verification");
    process.exitCode = 1;
    return;
  }

  console.log(`Read Creator id=${found.id}`);
  console.log("PASSED Creator create/read verification");
}

main()
  .catch((error: unknown) => {
    console.log("FAILED Creator create/read verification");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
