import { z } from "zod";
import { isDateOnly, multilineText, singleLineText } from "./common.js";

export const CustomFieldTypeEnum = z.enum([
  "TEXT",
  "NUMBER",
  "DATE",
  "SELECT",
  "MULTI_SELECT",
  "CHECKBOX",
  "URL",
]);
export type CustomFieldType = z.infer<typeof CustomFieldTypeEnum>;

/** SELECT and MULTI_SELECT fields store option values; no other type has options. */
export function isSelectFieldType(type: string): type is "SELECT" | "MULTI_SELECT" {
  return type === "SELECT" || type === "MULTI_SELECT";
}

// ─── Options ────────────────────────────────────────────
//
// An option's `value` is its identity: task values store it, so two options of
// one field must never share a value. Renaming an option therefore goes
// through `renameOptions`, which moves the stored values along with it.

export const SelectOptionSchema = z.object({
  value: singleLineText()
    .min(1)
    .refine((value) => value.trim() !== "", "Option value must not be blank"),
  color: z.string().optional(),
});
export type SelectOption = z.infer<typeof SelectOptionSchema>;

function addRepeatedOptionIssues(options: { value: string }[], ctx: z.RefinementCtx, path: (string | number)[]) {
  const seen = new Set<string>();
  options.forEach((option, index) => {
    if (seen.has(option.value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, index, "value"],
        message: "Option values must be unique within a field",
      });
    }
    seen.add(option.value);
  });
}

export const SelectOptionsSchema = z
  .array(SelectOptionSchema)
  .min(1, "SELECT and MULTI_SELECT fields require at least one option")
  .superRefine((options, ctx) => addRepeatedOptionIssues(options, ctx, []));

/** The option values of a stored options list, skipping malformed entries. */
export function customFieldOptionValues(options: unknown): string[] {
  if (!Array.isArray(options)) return [];
  const values: string[] = [];
  for (const option of options) {
    const value = (option as { value?: unknown } | null)?.value;
    if (typeof value === "string") values.push(value);
  }
  return values;
}

/**
 * The well-formed options of a stored or imported options list, each value
 * once (the first occurrence wins), and how many entries were dropped.
 */
export function normalizeSelectOptions(options: unknown): { options: SelectOption[]; dropped: number } {
  if (!Array.isArray(options)) return { options: [], dropped: options == null ? 0 : 1 };
  const kept: SelectOption[] = [];
  const seen = new Set<string>();
  for (const option of options) {
    const parsed = SelectOptionSchema.safeParse(option);
    if (!parsed.success || seen.has(parsed.data.value)) continue;
    seen.add(parsed.data.value);
    kept.push(parsed.data);
  }
  return { options: kept, dropped: options.length - kept.length };
}

// ─── Field definitions ──────────────────────────────────

export const CreateCustomFieldSchema = z
  .object({
    name: singleLineText()
      .min(1, "Field name is required")
      .max(100, "Field name must be 100 characters or less"),
    type: CustomFieldTypeEnum,
    options: z.array(SelectOptionSchema).optional(),
    required: z.boolean().default(false),
  })
  .superRefine((data, ctx) => {
    if (isSelectFieldType(data.type)) {
      if (!data.options || data.options.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["options"],
          message: "SELECT and MULTI_SELECT fields require at least one option",
        });
        return;
      }
      addRepeatedOptionIssues(data.options, ctx, ["options"]);
    } else if (data.options && data.options.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: "Only SELECT and MULTI_SELECT fields have options",
      });
    }
  });
export type CreateCustomFieldInput = z.infer<typeof CreateCustomFieldSchema>;

/** Moves every stored `from` value to the option `to` of the new options list. */
export const RenameOptionSchema = z.object({
  from: singleLineText().min(1),
  to: singleLineText().min(1),
});
export type RenameOptionInput = z.infer<typeof RenameOptionSchema>;

export const UpdateCustomFieldSchema = z
  .object({
    name: singleLineText().min(1).max(100).optional(),
    // The type of a field cannot change; the current type is accepted so a
    // client may send the whole field back.
    type: CustomFieldTypeEnum.optional(),
    // The complete new options list. Stored values whose option is neither
    // kept nor renamed are cleared.
    options: SelectOptionsSchema.optional(),
    renameOptions: z.array(RenameOptionSchema).optional(),
    required: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.renameOptions || data.renameOptions.length === 0) return;
    if (!data.options) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["renameOptions"],
        message: "renameOptions requires the new options list",
      });
      return;
    }
    const values = new Set(data.options.map((option) => option.value));
    const sources = new Set<string>();
    data.renameOptions.forEach((rename, index) => {
      if (sources.has(rename.from)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["renameOptions", index, "from"],
          message: "Each option can be renamed only once",
        });
      }
      sources.add(rename.from);
      if (!values.has(rename.to)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["renameOptions", index, "to"],
          message: "A renamed option must be in the new options list",
        });
      }
    });
  });
export type UpdateCustomFieldInput = z.infer<typeof UpdateCustomFieldSchema>;

export const ReorderCustomFieldsSchema = z.object({
  orderedIds: z.array(z.string().min(1)).min(1),
});
export type ReorderCustomFieldsInput = z.infer<typeof ReorderCustomFieldsSchema>;

// ─── Values ─────────────────────────────────────────────

export const SetCustomFieldValueSchema = z.object({
  value: z
    .union([
      multilineText(),
      z.number().finite(),
      z.boolean(),
      z.array(singleLineText()),
    ])
    .nullable(),
});
export type SetCustomFieldValueInput = z.infer<typeof SetCustomFieldValueSchema>;

export type CustomFieldValue = string | number | boolean | string[];

/** null, blank text and an empty list all mean "no value". */
export function isEmptyCustomFieldValue(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    (typeof value === "string" && value.trim() === "") ||
    (Array.isArray(value) && value.length === 0)
  );
}

export const MAX_CUSTOM_FIELD_URL_LENGTH = 2048;
const HTTP_URL_PREFIX = /^https?:\/\//i;
// Browsers drop tabs and line breaks inside a URL, so "java\tscript:" would
// still run as javascript:. Reject every whitespace and control character.
const URL_DISALLOWED = /[\s\u0000-\u001F\u007F]/;

// Node and every browser provide URL; the ES2022 library types do not declare it.
declare const URL: new (input: string) => { protocol: string; hostname: string };

/** True for an absolute http(s) URL with a host, the only links a URL field shows. */
export function isHttpUrl(value: string): boolean {
  if (
    value.length > MAX_CUSTOM_FIELD_URL_LENGTH ||
    !HTTP_URL_PREFIX.test(value) ||
    URL_DISALLOWED.test(value)
  ) {
    return false;
  }
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "";
  } catch {
    return false;
  }
}

export interface CustomFieldDefinition {
  name: string;
  type: string;
  options?: unknown;
  required?: boolean;
}

export type CustomFieldValueIssue =
  | "required"
  | "wrong_type"
  | "invalid_date"
  | "invalid_url"
  | "unknown_option"
  | "repeated_option";

export type CustomFieldValueCheck =
  | { ok: true; value: CustomFieldValue | null }
  | { ok: false; issue: CustomFieldValueIssue; message: string };

/**
 * Checks a value against its field definition. On success, `value` is what to
 * store, or null to delete the stored value (empty values are not stored).
 */
export function checkCustomFieldValue(field: CustomFieldDefinition, value: unknown): CustomFieldValueCheck {
  const label = `"${field.name}"`;
  const fail = (issue: CustomFieldValueIssue, message: string): CustomFieldValueCheck => ({
    ok: false,
    issue,
    message: `${label} ${message}`,
  });

  if (isEmptyCustomFieldValue(value)) {
    return field.required ? fail("required", "is required") : { ok: true, value: null };
  }

  switch (field.type) {
    case "TEXT":
      return typeof value === "string" ? { ok: true, value } : fail("wrong_type", "must be text");
    case "NUMBER":
      return typeof value === "number" && Number.isFinite(value)
        ? { ok: true, value }
        : fail("wrong_type", "must be a finite number");
    case "CHECKBOX":
      return typeof value === "boolean" ? { ok: true, value } : fail("wrong_type", "must be true or false");
    case "DATE":
      if (typeof value !== "string") return fail("wrong_type", "must be a date string");
      return isDateOnly(value)
        ? { ok: true, value }
        : fail("invalid_date", "must be a real calendar date in YYYY-MM-DD format between 1900 and 2999");
    case "URL":
      if (typeof value !== "string") return fail("wrong_type", "must be a URL string");
      return isHttpUrl(value)
        ? { ok: true, value }
        : fail("invalid_url", "must be an http or https URL, such as https://example.com, without spaces");
    case "SELECT": {
      if (typeof value !== "string") return fail("wrong_type", "must be one of its options");
      return customFieldOptionValues(field.options).includes(value)
        ? { ok: true, value }
        : fail("unknown_option", "must be one of its options");
    }
    case "MULTI_SELECT": {
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        return fail("wrong_type", "must be a list of its options");
      }
      const options = new Set(customFieldOptionValues(field.options));
      if (value.some((item) => !options.has(item))) return fail("unknown_option", "must only list its options");
      if (new Set(value).size !== value.length) return fail("repeated_option", "lists an option more than once");
      return { ok: true, value: [...value] };
    }
    default:
      return fail("wrong_type", "has an unknown field type");
  }
}
