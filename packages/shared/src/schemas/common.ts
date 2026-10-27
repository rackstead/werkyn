import { z } from "zod";

// Query parameters arrive as strings. Boolean("false") is true, so coercion
// cannot be used for boolean filters.
export const QueryBooleanSchema = z.union([
  z.boolean(),
  z.enum(["true", "false"]).transform((value) => value === "true"),
]);

export const PaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type PaginationInput = z.infer<typeof PaginationSchema>;

export const IdParamSchema = z.object({
  id: z.string().min(1),
});
export type IdParam = z.infer<typeof IdParamSchema>;

export const SearchSchema = z.object({
  search: z.string().optional(),
});
export type SearchInput = z.infer<typeof SearchSchema>;

export const WorkspaceSearchSchema = z.object({
  q: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type WorkspaceSearchInput = z.infer<typeof WorkspaceSearchSchema>;
