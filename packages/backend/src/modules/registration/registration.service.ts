import type { PrismaClient } from "@prisma/client";
import type { UpdateRegistrationConfigInput } from "@pm/shared";
import { mailDeliveryConfigured } from "../../utils/mailer.js";
import { ValidationError } from "../../utils/errors.js";

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
  // Off remains available so an administrator can turn the gate back off.
  // On is refused until real delivery exists; Ethereal is not delivery.
  if (data.privacyPreserving && !(await mailDeliveryConfigured(prisma))) {
    throw new ValidationError(
      "Configure email delivery under Admin > Email or set SMTP_HOST before requiring verification.",
    );
  }
  return prisma.registrationConfig.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON, privacyPreserving: data.privacyPreserving },
    update: { privacyPreserving: data.privacyPreserving },
  });
}
