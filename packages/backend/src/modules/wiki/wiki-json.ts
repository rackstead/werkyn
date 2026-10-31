import {
  WikiCommentSelectionSchema,
  WikiPageContentSchema,
  type JsonValue,
} from "@pm/shared";
import { ValidationError } from "../../utils/errors.js";

/** The same field contract for service callers and stored version snapshots. */
export function assertWikiJson(
  value: unknown,
  field: "content" | "selectionStart" | "selectionEnd",
): asserts value is JsonValue | undefined {
  if (value === undefined) return;
  const schema =
    field === "content" ? WikiPageContentSchema : WikiCommentSelectionSchema;
  const result = schema.safeParse(value);
  if (!result.success)
    throw new ValidationError("Validation failed", [
      { field, message: result.error.issues[0].message },
    ]);
}
