/**
 * Read-only report of stored custom-field data that the API rules reject.
 *
 * Writers check values against their field since the DAT-013 fix, but rows
 * stored earlier can hold a date that does not exist, a link that is not
 * http(s), an option the field no longer has, a repeated option, a value of the
 * wrong type or an empty value, and select fields can hold repeated or
 * malformed options. Run this before repairing (see docs/remediation/dat-013.md)
 * and again until it is clean. Each sample names the repair it proposes; the
 * script itself never writes: every query runs in one READ ONLY transaction.
 * Output contains IDs and reason codes only, never names or values.
 *
 *   DATABASE_URL=... node dist/scripts/custom-field-value-report.js [--json] [--limit=N] [--workspace=ID]
 *
 * Exit status: 0 when clean, 2 when issues were found, 1 on error.
 */
import { pathToFileURL } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  checkCustomFieldValue,
  isEmptyCustomFieldValue,
  isSelectFieldType,
  normalizeSelectOptions,
  type CustomFieldValueIssue,
} from "@pm/shared";

export interface CustomFieldIssue {
  key: string;
  description: string;
  repair: string;
  count: number;
  samples: Record<string, string>[];
}

const ISSUES: Record<string, { description: string; repair: string }> = {
  custom_field_options: {
    description:
      "Select field options are missing, malformed, repeated, longer than 100 characters or more than 200, or a non-select field has options",
    repair:
      "repair=rewrite_options: PATCH the field with each well-formed option once. repair=add_options: add at least one option. repair=drop_options: set options to NULL on the non-select field.",
  },
  custom_field_value_empty: {
    description: "Value is blank text or an empty list, which the API stores as no value",
    repair: "repair=delete: delete the CustomFieldValue row.",
  },
  custom_field_value_type: {
    description: "Value has the wrong JSON type for its field",
    repair: "repair=delete: delete the row after review; the API cannot show or edit it.",
  },
  custom_field_value_text: {
    description: "TEXT value contains control characters other than tab and line breaks",
    repair: "repair=strip: rewrite the text without those characters (stripDisallowedControlCharacters in @pm/shared).",
  },
  custom_field_value_date: {
    description: "DATE value is not a real YYYY-MM-DD calendar date between 1900 and 2999",
    repair: "repair=delete: delete the row, or rewrite it with the intended date if it can be recovered.",
  },
  custom_field_value_url: {
    description: "URL value is not an absolute http(s) URL without spaces",
    repair: "repair=delete: delete the row; the task view no longer renders it as a link.",
  },
  custom_field_value_option: {
    description: "SELECT or MULTI_SELECT value names an option the field does not have",
    repair:
      "repair=delete: delete the row, or first restore the option (or PATCH options with renameOptions) if the value should be kept.",
  },
  custom_field_value_size: {
    description: "MULTI_SELECT value lists more than 200 options",
    repair: "repair=trim: after review, rewrite the list with at most 200 of its options.",
  },
  custom_field_value_repeated: {
    description: "MULTI_SELECT value lists an option more than once",
    repair: "repair=dedupe: rewrite the list keeping the first occurrence of each option.",
  },
};

const VALUE_ISSUE_KEYS: Record<Exclude<CustomFieldValueIssue, "required">, string> = {
  wrong_type: "custom_field_value_type",
  invalid_text: "custom_field_value_text",
  invalid_date: "custom_field_value_date",
  invalid_url: "custom_field_value_url",
  unknown_option: "custom_field_value_option",
  repeated_option: "custom_field_value_repeated",
  too_many_options: "custom_field_value_size",
};

const PAGE = 500;

/** The report entry and proposed repair for one stored value, or null when it is valid. */
export function classifyStoredValue(
  field: { type: string; options: unknown },
  value: unknown,
): { key: string; repair: string } | null {
  if (isEmptyCustomFieldValue(value)) return { key: "custom_field_value_empty", repair: "delete" };
  const checked = checkCustomFieldValue({ name: "", type: field.type, options: field.options }, value);
  if (checked.ok) return null;
  if (checked.issue === "required") return null; // unreachable: the check above ignores required
  const key = VALUE_ISSUE_KEYS[checked.issue];
  const repairs: Partial<Record<CustomFieldValueIssue, string>> = {
    repeated_option: "dedupe",
    invalid_text: "strip",
    too_many_options: "trim",
  };
  const repair = repairs[checked.issue] ?? "delete";
  return { key, repair };
}

/** The proposed repair for a field's options, or null when they are valid. */
export function classifyFieldOptions(field: { type: string; options: unknown }): string | null {
  if (!isSelectFieldType(field.type)) {
    const hasOptions = Array.isArray(field.options) ? field.options.length > 0 : field.options != null;
    return hasOptions ? "drop_options" : null;
  }
  const { options, dropped } = normalizeSelectOptions(field.options);
  if (options.length === 0) return "add_options";
  return dropped > 0 ? "rewrite_options" : null;
}

export async function findCustomFieldIssues(
  prisma: PrismaClient,
  options: { sampleLimit?: number; workspaceId?: string } = {},
): Promise<{ readOnly: true; issues: CustomFieldIssue[] }> {
  const sampleLimit = Math.max(1, Math.floor(options.sampleLimit ?? 50));
  const found = new Map<string, CustomFieldIssue>(
    Object.entries(ISSUES).map(([key, info]) => [key, { key, ...info, count: 0, samples: [] }]),
  );
  const record = (key: string, sample: Record<string, string>) => {
    const issue = found.get(key)!;
    issue.count++;
    if (issue.samples.length < sampleLimit) issue.samples.push(sample);
  };

  await prisma.$transaction(
    async (tx) => {
      // Any accidental write in this transaction fails instead of committing.
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const fields = await tx.customField.findMany({
        where: options.workspaceId ? { project: { workspaceId: options.workspaceId } } : {},
        select: { id: true, projectId: true, type: true, options: true },
        orderBy: { id: "asc" },
      });
      for (const field of fields) {
        const optionRepair = classifyFieldOptions(field);
        if (optionRepair) {
          record("custom_field_options", { id: field.id, projectId: field.projectId, repair: optionRepair });
        }
        let cursor: string | undefined;
        for (;;) {
          const rows = await tx.customFieldValue.findMany({
            where: { fieldId: field.id, ...(cursor ? { id: { gt: cursor } } : {}) },
            select: { id: true, taskId: true, value: true },
            orderBy: { id: "asc" },
            take: PAGE,
          });
          for (const row of rows) {
            const problem = classifyStoredValue(field, row.value);
            if (problem) {
              record(problem.key, {
                id: row.id, taskId: row.taskId, fieldId: field.id, projectId: field.projectId, repair: problem.repair,
              });
            }
          }
          if (rows.length < PAGE) break;
          cursor = rows[rows.length - 1].id;
        }
      }
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 10 * 60_000, maxWait: 60_000 },
  );
  return { readOnly: true, issues: [...found.values()] };
}

async function main() {
  const args = process.argv.slice(2);
  const limitArg = args.find((arg) => arg.startsWith("--limit="));
  const sampleLimit = limitArg ? Number(limitArg.slice("--limit=".length)) : 50;
  if (!Number.isFinite(sampleLimit) || sampleLimit < 1) throw new Error("--limit must be a positive number");
  const workspaceArg = args.find((arg) => arg.startsWith("--workspace="));
  const workspaceId = workspaceArg ? workspaceArg.slice("--workspace=".length) : undefined;
  const prisma = new PrismaClient();
  try {
    const report = await findCustomFieldIssues(prisma, { sampleLimit, workspaceId });
    if (args.includes("--json")) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      for (const issue of report.issues) {
        console.log(`${issue.count === 0 ? "ok  " : "FAIL"} ${issue.key}: ${issue.count} (${issue.description})`);
        if (issue.count > 0) {
          console.log(`     repair: ${issue.repair}`);
          for (const sample of issue.samples) console.log(`     ${JSON.stringify(sample)}`);
          if (issue.count > issue.samples.length) console.log(`     ... ${issue.count - issue.samples.length} more`);
        }
      }
    }
    process.exitCode = report.issues.some((issue) => issue.count > 0) ? 2 : 0;
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
