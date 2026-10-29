// Child process for tests that may exhaust memory. Usage:
//   node --import tsx backup-archive-child.mjs <guarded|unguarded> <zip>...
// "guarded" reads each archive with readBackupArchive; "unguarded" repeats the
// adm-zip calls the restore route made before archives were inspected. One
// JSON line is printed per archive, so a crash shows which archive caused it.
import { readFileSync } from "node:fs";
import AdmZip from "adm-zip";

const [mode, ...files] = process.argv.slice(2);
const { readBackupArchive } = await import(
  "../../src/modules/backup/backup-archive.ts"
);

function unguarded(buffer) {
  const zip = new AdmZip(buffer);
  const json = zip.getEntry("backup.json");
  if (!json) throw new Error("missing backup.json");
  const assets = new Map();
  for (const entry of zip.getEntries())
    if (entry.entryName.startsWith("assets/") && !entry.isDirectory)
      assets.set(entry.entryName, entry.getData());
  return { jsonBuffer: json.getData(), assets };
}

for (const file of files) {
  const buffer = readFileSync(file);
  const started = Date.now();
  const result = { file };
  try {
    const { jsonBuffer, assets } =
      mode === "guarded" ? readBackupArchive(buffer) : unguarded(buffer);
    Object.assign(result, { ok: true, json: jsonBuffer.length, assets: assets.size });
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
