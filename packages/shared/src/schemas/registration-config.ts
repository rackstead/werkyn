import { z } from "zod";

export const UpdateRegistrationConfigSchema = z.object({
  privacyPreserving: z.boolean(),
});

export type UpdateRegistrationConfigInput = z.infer<
  typeof UpdateRegistrationConfigSchema
>;
