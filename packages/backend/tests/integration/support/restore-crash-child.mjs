// Child process for backup-restore-integrity.test.mjs. It builds the real app,
// makes the process exit as the restore transaction would start (after the
// archive files were written), and uploads one restore. A clean exit means
// the crash point was never reached.
// Usage: node --import tsx restore-crash-child.mjs <manifest.json>
import crypto from "node:crypto";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));
const { buildApp } = await import("../../../src/app.ts");
const app = await buildApp();
await app.ready();

app.prisma.$transaction = () => process.exit(7);

const boundary = `crash-${crypto.randomUUID()}`;
const response = await app.inject({
  method: "POST",
  url: `/api/workspaces/${manifest.workspaceId}/backup/restore`,
  payload: Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="backup.zip"\r\nContent-Type: application/zip\r\n\r\n`,
    ),
    readFileSync(manifest.file),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]),
  headers: {
    authorization: `Bearer ${manifest.token}`,
    "content-type": `multipart/form-data; boundary=${boundary}`,
  },
});
console.log(JSON.stringify({ statusCode: response.statusCode, body: response.body.slice(0, 300) }));
await app.close();
