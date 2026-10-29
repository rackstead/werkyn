// Child process for tests that may exhaust memory. Usage:
//   node --import tsx backup-json-child.mjs <guarded|unguarded> <json>...
// "guarded" parses each file with parseBackupJson; "unguarded" repeats the
// JSON.parse and full schema validation the restore routes ran before the
// limits. One JSON line is printed per file, so a crash shows which one.
import { readFileSync } from "node:fs";
import { BackupFileSchema } from "@pm/shared";

const [mode, ...files] = process.argv.slice(2);
const { parseBackupJson } = await import("../../src/modules/backup/backup-json.ts");

function unguarded(buffer) {
  const result = BackupFileSchema.safeParse(JSON.parse(buffer.toString("utf-8")));
  if (result.success) return result.data;
  const error = new Error(result.error.issues.slice(0, 5).map((i) => i.message).join("; "));
  error.statusCode = 400;
  throw error;
}

for (const file of files) {
  const buffer = readFileSync(file);
  const started = Date.now();
  const result = { file };
  try {
    (mode === "guarded" ? parseBackupJson : unguarded)(buffer);
    result.ok = true;
  } catch (error) {
    Object.assign(result, {
      ok: false,
      statusCode: error.statusCode,
      reason: error.reason,
      message: error.message,
    });
  }
  result.ms = Date.now() - started;
  result.maxRssMiB = Math.round(process.resourceUsage().maxRSS / 1024);
  console.log(JSON.stringify(result));
}
