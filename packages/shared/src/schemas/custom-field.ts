import { z } from "zod";
import { multilineText, singleLineText } from "./common.js";

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

export const SelectOptionSchema = z.object({
  value: singleLineText().min(1),
  color: z.string().optional(),
});

export const CreateCustomFieldSchema = z.object({
  name: singleLineText()
    .min(1, "Field name is required")
    .max(100, "Field name must be 100 characters or less"),
  type: CustomFieldTypeEnum,
  options: z.array(SelectOptionSchema).optional(),
  required: z.boolean().default(false),
});
export type CreateCustomFieldInput = z.infer<typeof CreateCustomFieldSchema>;

export const UpdateCustomFieldSchema = z.object({
  name: singleLineText().min(1).max(100).optional(),
  options: z.array(SelectOptionSchema).optional(),
  required: z.boolean().optional(),
});
export type UpdateCustomFieldInput = z.infer<typeof UpdateCustomFieldSchema>;

export const ReorderCustomFieldsSchema = z.object({
  orderedIds: z.array(z.string().min(1)).min(1),
});
export type ReorderCustomFieldsInput = z.infer<typeof ReorderCustomFieldsSchema>;

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
