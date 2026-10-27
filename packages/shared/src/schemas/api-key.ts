import { z } from "zod";

export const CreateApiKeySchema = z.object({
  name: z.string().trim().min(1).max(100),
  // null explicitly opts into a key that does not expire.
  expiresInDays: z.number().int().min(1).max(365).nullable().default(30),
});

export type CreateApiKeyInput = z.infer<typeof CreateApiKeySchema>;
