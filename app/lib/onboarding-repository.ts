import type { Prisma, PrismaClient } from "@prisma/client";

import type { OnboardingRepository } from "./onboarding";
import type { InitialTenets } from "./tenets";

export function createPrismaOnboardingRepository(
  prisma: PrismaClient,
): OnboardingRepository {
  return {
    async ensureCreator(args) {
      if (args.creatorId && args.creatorId !== "new") {
        const existing = await prisma.creator.findUnique({
          where: { id: args.creatorId },
        });
        if (existing) {
          return { id: existing.id };
        }

        const created = await prisma.creator.create({
          data: {
            id: args.creatorId,
            channelUrl: args.channelUrl,
          },
        });
        return { id: created.id };
      }

      const created = await prisma.creator.create({
        data: {
          channelUrl: args.channelUrl,
        },
      });
      return { id: created.id };
    },

    async saveInitialTenets(creatorId: string, tenets: InitialTenets) {
      await prisma.creator.update({
        where: { id: creatorId },
        data: {
          initialTenets: tenets as unknown as Prisma.InputJsonValue,
        },
      });
    },

    async saveMindIdAndInitialTenets(
      creatorId: string,
      mindId: string,
      tenets: InitialTenets,
    ) {
      await prisma.creator.update({
        where: { id: creatorId },
        data: {
          mindId,
          initialTenets: tenets as unknown as Prisma.InputJsonValue,
        },
      });
    },
  };
}
