import type { PrismaClient } from "@prisma/client";
import type { UpdateRegistrationConfigInput } from "@pm/shared";

const SINGLETON = "singleton";

export async function getRegistrationConfig(prisma: PrismaClient) {
  return prisma.registrationConfig.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON },
    update: {},
  });
}

export async function updateRegistrationConfig(
  prisma: PrismaClient,
  data: UpdateRegistrationConfigInput,
) {
  return prisma.registrationConfig.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON, privacyPreserving: data.privacyPreserving },
    update: { privacyPreserving: data.privacyPreserving },
  });
}
