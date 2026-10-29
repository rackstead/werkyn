// Child process for backup-zip-budget.test.mjs. It builds the real app and
// uploads each archive in the manifest to preview and/or restore, printing one
// JSON line per request so that a crash shows which archive caused it.
// Usage: node --import tsx backup-upload-child.mjs <manifest.json>
import crypto from "node:crypto";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));
const { buildApp } = await import("../../../src/app.ts");
const app = await buildApp();
await app.ready();

let requests = 0;
function upload(action, zip, filename) {
  const boundary = `zip-${crypto.randomUUID()}`;
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/zip\r\n\r\n`,
    ),
    zip,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return app.inject({
    method: "POST",
    url: `/api/workspaces/${manifest.workspaceId}/backup/${action}`,
    payload,
    headers: {
      authorization: `Bearer ${manifest.token}`,
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    remoteAddress: `127.0.4.${1 + (++requests % 200)}`,
  });
}

try {
  for (const item of manifest.cases) {
    const zip = readFileSync(item.file);
    for (const action of item.actions) {
      const response = await upload(action, zip, item.filename ?? "backup.zip");
      let body;
      try {
        body = response.json();
      } catch {
        body = response.body;
      }
      console.log(
        JSON.stringify({
          label: item.label,
          action,
          statusCode: response.statusCode,
          body,
          maxRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
        }),
      );
    }
  }
} finally {
  await app.close();
}
