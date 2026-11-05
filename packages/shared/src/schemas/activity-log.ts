import { z } from "zod";
import { INT32_MAX } from "./common.js";

/**
 * Workspace activity counts at most this many rows for `pagination.total`;
 * beyond it the total is reported as this number with `totalCapped: true`.
 */
export const ACTIVITY_COUNT_LIMIT = 1_000;

export const ActivityLogQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(INT32_MAX).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ActivityLogQueryInput = z.infer<typeof ActivityLogQuerySchema>;
