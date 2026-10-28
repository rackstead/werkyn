// A stand-in for the Dex binary used by the Dex manager tests. It records each
// start and stop in FAKE_DEX_LOG as one JSON line, along with the connector
// names of the config file it was started with, and then stays up until it is
// signalled. FAKE_DEX_IGNORE_TERM=1 makes it ignore SIGTERM, and
// FAKE_DEX_EXIT_CODE makes it exit with that code right after starting.
import { appendFileSync, readFileSync } from "node:fs";

const log = process.env.FAKE_DEX_LOG;
const configPath = process.argv[3];
const config = readFileSync(configPath, "utf8");
const connectors = [...config.matchAll(/^\s+name: (.+)$/gm)]
  .map((match) => match[1])
  .filter((name) => name !== "Werkyn");

function record(event) {
  appendFileSync(
    log,
    `${JSON.stringify({ event, pid: process.pid, connectors })}\n`,
  );
}

process.on("SIGTERM", () => {
  if (process.env.FAKE_DEX_IGNORE_TERM === "1") {
    record("ignored-sigterm");
    return;
  }
  record("stop");
  process.exit(0);
});

setInterval(() => {}, 60_000);
record("start");
if (process.env.FAKE_DEX_EXIT_CODE)
  process.exit(Number(process.env.FAKE_DEX_EXIT_CODE));
