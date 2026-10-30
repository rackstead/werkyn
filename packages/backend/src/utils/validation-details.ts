import type { z } from "zod";

export interface ValidationDetail {
  field: string;
  message: string;
}

/**
 * The `details` of a 400 for Zod issues, one entry per problem. Zod 4 still
 * runs length checks (`.min()`, `.max()`) on a value that already failed its
 * type check, so a string field sent as an array also reports "Array must
 * contain…". Zod 3 stopped at the type error, and clients show the last
 * message per field, so only the type error is kept for that field.
 */
export function validationDetails(issues: readonly z.core.$ZodIssue[]): ValidationDetail[] {
  const mistyped = new Set<string>();
  const details: ValidationDetail[] = [];
  for (const issue of issues) {
    const field = issue.path.join(".");
    if (mistyped.has(field)) continue;
    if (issue.code === "invalid_type") mistyped.add(field);
    details.push({ field, message: issue.message });
  }
  return details;
}
