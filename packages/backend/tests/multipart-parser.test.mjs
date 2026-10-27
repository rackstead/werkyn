import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";

// Resolve exactly the parser used by the production multipart plugin, rather
// than adding a second direct parser dependency just for this regression.
const require = createRequire(import.meta.url);
const multipartRequire = createRequire(require.resolve("@fastify/multipart"));
const parserPath = multipartRequire.resolve("@fastify/busboy");

function runParser(body) {
  const result = spawnSync(
    process.execPath,
    [
      "--max-old-space-size=64",
      "--input-type=commonjs",
      "-e",
      `const Busboy = require(${JSON.stringify(parserPath)});\n${body}`,
    ],
    {
      timeout: 2000,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
      encoding: "utf8",
    },
  );
  assert.equal(
    result.error,
    undefined,
    `parser deadline exceeded: ${result.error?.code}`,
  );
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("fragmented 252-byte multipart boundary makes progress without blocking the event loop", () => {
  // Matches the upstream security regression's fragmented-prefix preconditions.
  // An external hard deadline remains effective if synchronous parser code spins.
  const output = runParser(`
    const boundary = "A".repeat(252);
    const parser = Busboy({ headers: { "content-type": "multipart/form-data; boundary=" + boundary } });
    parser.on("error", () => process.exit(1));
    parser.write(Buffer.from("--" + boundary.slice(0, -1)));
    parser.write(Buffer.from("X"), error => {
      if (error) process.exit(1);
      process.stdout.write("progress", () => process.exit(0));
    });
    setTimeout(() => process.exit(2), 1000);
  `);
  assert.equal(output, "progress");
});

test("prototype-named part headers do not crash the patched multipart parser", () => {
  // The minimum upstream security release also fixes this inseparable parser
  // issue. Run it in the same bounded child so a regressed throw cannot crash CI.
  const output = runParser(`
    const boundary = "safe-boundary";
    const parser = Busboy({ headers: { "content-type": "multipart/form-data; boundary=" + boundary } });
    parser.on("error", () => process.exit(1));
    parser.on("field", (name, value) => {
      if (name !== "example" || value !== "value") process.exit(1);
      process.stdout.write("parsed");
    });
    parser.on("finish", () => process.exit(0));
    parser.end(Buffer.from("--" + boundary + "\\r\\nContent-Disposition: form-data; name=\\"example\\"\\r\\n__proto__: harmless\\r\\nconstructor: harmless\\r\\n\\r\\nvalue\\r\\n--" + boundary + "--\\r\\n"));
    setTimeout(() => process.exit(2), 1000);
  `);
  assert.equal(output, "parsed");
});
