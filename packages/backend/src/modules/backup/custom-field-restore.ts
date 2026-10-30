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
import { checkJsonValue } from "./restore-validation.js";

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
   * itself), each already checked against its field.
   */
  values: Map<BackupTask, { fieldRef: string; value: Prisma.InputJsonValue }[]>;
  warnings: string[];
}

/** True when PostgreSQL and Prisma can store every string in `value`. */
function isStorableJson(value: unknown): boolean {
  try {
    checkJsonValue(value, "value");
    return true;
  } catch {
    return false;
  }
}

/**
 * Applies the custom-field rules of the API to one backup project, so preview
 * and restore report and write the same thing: select options are kept once
 * each and only when well formed, other types carry no options, and a value is
 * restored only if it is valid for its field (a second value for the same
 * field of a task is skipped). Required fields are not enforced, as for any
 * task created without values. An unknown field type rejects the backup.
 * Options and values PostgreSQL cannot store (U+0000, unpaired surrogates)
 * count as malformed. A value naming a field of another project in the same
 * backup is not restored and is reported; `isOtherProjectField` says whether
 * a reference is one.
 */
export function planCustomFieldRestore(
  entry: BackupProject,
  isOtherProjectField: (fieldRef: string) => boolean = () => false,
): CustomFieldRestorePlan {
  const warnings: string[] = [];
  const project = entry.project.name;
  const fields: RestoredCustomField[] = [];
  const byRef = new Map<string, RestoredCustomField>();

  for (const field of entry.customFields) {
    const type = CustomFieldTypeEnum.safeParse(field.type);
    if (!type.success) {
      // validateBackup refuses this before any plan runs.
      throw new ValidationError("Invalid backup file: a custom field has an unknown type");
    }
    let options: SelectOption[] | undefined;
    if (isSelectFieldType(type.data)) {
      const normalized = normalizeSelectOptions(field.options);
      options = normalized.options.filter(isStorableJson);
      const dropped = normalized.dropped + normalized.options.length - options.length;
      if (dropped > 0) {
        warnings.push(
          `Custom field "${field.name}" in project "${project}": dropped ${dropped} malformed or repeated option(s)`,
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
  let otherProject = 0;
  for (const task of entry.tasks) {
    const seen = new Set<string>();
    const kept: { fieldRef: string; value: Prisma.InputJsonValue }[] = [];
    for (const item of task.customFieldValues) {
      const field = byRef.get(item.fieldRef);
      // Values of fields left out of the export are skipped, as before.
      if (!field) {
        if (isOtherProjectField(item.fieldRef)) otherProject++;
        continue;
      }
      const checked = checkCustomFieldValue({ ...field, required: false }, item.value);
      if (!checked.ok || seen.has(item.fieldRef) || !isStorableJson(checked.value)) {
        skipped.set(field.originalId, (skipped.get(field.originalId) ?? 0) + 1);
        continue;
      }
      seen.add(item.fieldRef);
      if (checked.value !== null) kept.push({ fieldRef: item.fieldRef, value: checked.value });
    }
    if (kept.length > 0) values.set(task, kept);
  }
  if (otherProject > 0) {
    warnings.push(
      `Project "${project}": skipped ${otherProject} custom field value(s) that refer to a field of another project`,
    );
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
