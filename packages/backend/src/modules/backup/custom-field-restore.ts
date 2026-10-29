import type { Prisma } from "@prisma/client";
import {
  CustomFieldTypeEnum,
  checkCustomFieldValue,
  isSelectFieldType,
  normalizeSelectOptions,
  type BackupFile,
  type CustomFieldType,
  type SelectOption,
} from "@pm/shared";
import { ValidationError } from "../../utils/errors.js";

type BackupProject = BackupFile["projects"][number];
type BackupTask = BackupProject["tasks"][number];

export interface RestoredCustomField {
  originalId: string;
  name: string;
  type: CustomFieldType;
  options: SelectOption[] | undefined;
  required: boolean;
  position: number;
}

export interface CustomFieldRestorePlan {
  fields: RestoredCustomField[];
  /**
   * Values to restore for each task entry of the project (keyed by the entry
   * itself, since a backup's task IDs are not checked for uniqueness), each
   * already checked against its field.
   */
  values: Map<BackupTask, { fieldRef: string; value: Prisma.InputJsonValue }[]>;
  warnings: string[];
}

/**
 * Applies the custom-field rules of the API to one backup project, so preview
 * and restore report and write the same thing: select options are kept once
 * each and only when well formed, other types carry no options, and a value is
 * restored only if it is valid for its field (a second value for the same
 * field of a task is skipped). Required fields are not enforced, as for any
 * task created without values. An unknown field type rejects the backup.
 */
export function planCustomFieldRestore(entry: BackupProject): CustomFieldRestorePlan {
  const warnings: string[] = [];
  const project = entry.project.name;
  const fields: RestoredCustomField[] = [];
  const byRef = new Map<string, RestoredCustomField>();

  for (const field of entry.customFields) {
    const type = CustomFieldTypeEnum.safeParse(field.type);
    if (!type.success) {
      throw new ValidationError(
        `Invalid backup file format: custom field "${field.name}" in project "${project}" has an unknown type`,
      );
    }
    let options: SelectOption[] | undefined;
    if (isSelectFieldType(type.data)) {
      const normalized = normalizeSelectOptions(field.options);
      options = normalized.options;
      if (normalized.dropped > 0) {
        warnings.push(
          `Custom field "${field.name}" in project "${project}": dropped ${normalized.dropped} malformed or repeated option(s)`,
        );
      }
      if (options.length === 0) {
        warnings.push(
          `Custom field "${field.name}" in project "${project}" has no options; add options before setting values`,
        );
      }
    }
    const restored: RestoredCustomField = {
      originalId: field._originalId,
      name: field.name,
      type: type.data,
      options,
      required: field.required,
      position: field.position,
    };
    fields.push(restored);
    byRef.set(field._originalId, restored);
  }

  const values = new Map<BackupTask, { fieldRef: string; value: Prisma.InputJsonValue }[]>();
  const skipped = new Map<string, number>();
  for (const task of entry.tasks) {
    const seen = new Set<string>();
    const kept: { fieldRef: string; value: Prisma.InputJsonValue }[] = [];
    for (const item of task.customFieldValues) {
      const field = byRef.get(item.fieldRef);
      // Values of fields left out of the export are skipped, as before.
      if (!field) continue;
      const checked = checkCustomFieldValue({ ...field, required: false }, item.value);
      if (!checked.ok || seen.has(item.fieldRef)) {
        skipped.set(field.originalId, (skipped.get(field.originalId) ?? 0) + 1);
        continue;
      }
      seen.add(item.fieldRef);
      if (checked.value !== null) kept.push({ fieldRef: item.fieldRef, value: checked.value });
    }
    if (kept.length > 0) values.set(task, kept);
  }
  for (const field of fields) {
    const count = skipped.get(field.originalId);
    if (count) {
      warnings.push(
        `Custom field "${field.name}" in project "${project}": skipped ${count} value(s) that do not match the field's type or options, or repeat a task's value`,
      );
    }
  }

  return { fields, values, warnings };
}
