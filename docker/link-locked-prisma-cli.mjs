// Image build step: links the Prisma CLI that pnpm-lock.yaml pins onto PATH as
// /usr/local/bin/prisma, for `prisma generate` here and `prisma migrate deploy`
// in docker-entrypoint.sh. The production install leaves out devDependencies,
// but @prisma/client depends on that same locked CLI, so it is resolved from
// there. The build fails if the CLI is missing or is not the locked version, so
// migrations always run with the CLI that matches the generated client.
import { readFileSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const appDir = process.env.APP_DIR ?? "/app";
const linkPath = process.env.PRISMA_LINK ?? "/usr/local/bin/prisma";

function fail(message) {
  console.error(`link-locked-prisma-cli: ${message}`);
  process.exit(1);
}

const backend = createRequire(path.join(appDir, "packages/backend/package.json"));
const { parse } = backend("yaml");
const lockfile = parse(readFileSync(path.join(appDir, "pnpm-lock.yaml"), "utf8"));
const importer = lockfile.importers?.["packages/backend"] ?? {};

// Importer versions look like `6.19.2(typescript@5.9.3)`; the peer suffix is not
// part of the package version.
function lockedVersion(name) {
  const entry = importer.dependencies?.[name] ?? importer.devDependencies?.[name];
  return entry?.version?.replace(/\(.*$/, "");
}

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const clientManifest = backend.resolve("@prisma/client/package.json");
const fromClient = createRequire(clientManifest);
let cliManifest;
try {
  cliManifest = fromClient.resolve("prisma/package.json");
} catch {
  fail("the Prisma CLI is not installed next to @prisma/client");
}

const cli = readJson(cliManifest);
const client = readJson(clientManifest);
const expected = { prisma: lockedVersion("prisma"), "@prisma/client": lockedVersion("@prisma/client") };
if (!expected.prisma || cli.version !== expected.prisma) {
  fail(`Prisma CLI ${cli.version} is installed, but the lockfile pins ${expected.prisma}`);
}
if (client.version !== expected["@prisma/client"] || client.version !== cli.version) {
  fail(
    `@prisma/client ${client.version} is installed with Prisma CLI ${cli.version}, ` +
      `but the lockfile pins @prisma/client ${expected["@prisma/client"]}`,
  );
}

const bin = typeof cli.bin === "string" ? cli.bin : cli.bin?.prisma;
if (!bin) fail("the Prisma CLI package declares no prisma executable");
const target = path.join(path.dirname(cliManifest), bin);
symlinkSync(target, linkPath);
console.log(`Prisma CLI ${cli.version} (locked) linked at ${linkPath} -> ${target}`);
