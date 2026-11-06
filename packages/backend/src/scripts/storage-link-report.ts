/**
 * Read-only report of the symbolic links and special files (FIFOs, sockets,
 * devices) below the storage root. Since R33 the server refuses every one of
 * them for reads, writes and deletes, so a file reached through a link is no
 * longer served. Run this before upgrading an installation whose storage may
 * hold links (for example a workspace folder moved to another disk), and
 * replace each link with the real folder or file it points to; see
 * docs/remediation/r33-storage-symlinks.md.
 *
 * The root itself may be a link or mount point and is followed; nothing below
 * it is. The script only lists folders, examines entries and reads links: it
 * never changes, opens or follows anything. Output names paths below the root
 * and where each link points, never file contents.
 *
 *   STORAGE_DIR=/app/storage node dist/scripts/storage-link-report.js [--json] [--limit=N] [--dir=PATH]
 *
 * Exit status: 0 when nothing was found, 2 when links or special files were
 * found or a folder could not be listed, 1 on error.
 */
import { realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { findStorageLinks } from "../services/storage-paths.js";

export async function storageLinkReport(dir: string, limit = 1000) {
  const configured = path.resolve(dir);
  const root = await realpath(configured);
  const found = await findStorageLinks(root, { limit });
  return { readOnly: true as const, storageDir: configured, storageRoot: root, ...found };
}

async function main() {
  const args = process.argv.slice(2);
  const limitArg = args.find((arg) => arg.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : 1000;
  if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit must be a positive whole number");
  const dirArg = args.find((arg) => arg.startsWith("--dir="));
  const dir = dirArg ? dirArg.slice("--dir=".length) : (process.env.STORAGE_DIR ?? "./storage");
  const report = await storageLinkReport(dir, limit);
  if (args.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`storage root: ${report.storageRoot}${report.storageRoot === report.storageDir ? "" : ` (from ${report.storageDir})`}`);
    console.log(`folders listed: ${report.directories}`);
    for (const finding of report.findings) {
      console.log(`${finding.kind}\t${finding.path}${finding.target === undefined ? "" : `\t-> ${finding.target}`}`);
    }
    if (report.total > report.findings.length) console.log(`... ${report.total - report.findings.length} more`);
    for (const folder of report.unreadable) console.log(`unreadable folder\t${folder}`);
    console.log(report.total === 0 && report.unreadable.length === 0
      ? "ok: no links or special files below the storage root"
      : `found: ${report.total} link(s) or special file(s), ${report.unreadable.length} unreadable folder(s)`);
  }
  process.exitCode = report.total > 0 || report.unreadable.length > 0 ? 2 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
