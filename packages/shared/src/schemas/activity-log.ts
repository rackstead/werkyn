import { z } from "zod";
import { INT32_MAX } from "./common.js";

export const ActivityLogQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(INT32_MAX).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ActivityLogQueryInput = z.infer<typeof ActivityLogQuerySchema>;
