import fs from "node:fs";
import net from "node:net";
import { thumbnailFromFile, type DecodeDetails, type DecodeResult } from "./thumbnail-decode.js";
import { MAX_REQUEST_BYTES, encodeFrame } from "./thumbnail-protocol.js";

/**
 * A thumbnail decoder process, started by thumbnail-workers.ts with a hard
 * data limit. It decodes one stored file at a time, as asked over the
 * socket at fd 3 (thumbnail-protocol.ts), and answers with the thumbnail
 * or the reason there is none. It exits when the server closes the socket
 * or goes away, so it never outlives the server.
 *
 *   node thumbnail-worker.js [--no-memory-checks]
 */

/** Decode `path`, below the trusted directory `root` (the storage root). */
export type WorkerRequest = { id: number; root: string; path: string };

/** Frame headers; a successful result's thumbnail is the frame body. */
export type WorkerMessage =
  | { type: "ready"; pid: number; dataLimitBytes: number | null; oomScoreAdj: number | null }
  | ({ type: "result"; id: number; memory: WorkerMemory } & (
    | { ok: true; details: DecodeDetails }
    | { ok: false; outcome: Exclude<DecodeResult, { ok: true }>["outcome"]; details: DecodeDetails }
  ));

/** Memory of the worker after a job, in bytes (Linux), for recycling and logs. */
export interface WorkerMemory {
  dataBytes: number | null;
  rssBytes: number;
}

let channel: net.Socket;
try {
  channel = new net.Socket({ fd: 3, readable: true, writable: true });
} catch {
  console.error("thumbnail-worker must be started by the server (no channel at fd 3)");
  process.exit(1);
}
// The server closed the channel or is gone.
channel.on("end", () => process.exit(0));
channel.on("close", () => process.exit(0));
channel.on("error", () => process.exit(0));

/** The soft RLIMIT_DATA this process runs under, or null when unlimited or unknown. */
function dataLimit(): number | null {
  try {
    const line = fs.readFileSync("/proc/self/limits", "utf8").split("\n").find((l) => l.startsWith("Max data size"));
    const soft = line?.slice("Max data size".length).trim().split(/\s+/)[0];
    return soft && /^\d+$/.test(soft) ? Number(soft) : null;
  } catch {
    return null;
  }
}

/**
 * Ask the kernel's OOM killer to pick this process first. Raising one's own
 * score needs no privilege. If the server's container runs out of memory
 * despite the data limit, a worker is killed rather than the server.
 */
function preferAsOomVictim(): number | null {
  try {
    fs.writeFileSync("/proc/self/oom_score_adj", "1000");
    return Number(fs.readFileSync("/proc/self/oom_score_adj", "utf8").trim());
  } catch {
    return null;
  }
}

function memory(): WorkerMemory {
  const rssBytes = process.memoryUsage.rss();
  try {
    const data = /^VmData:\s+(\d+) kB/m.exec(fs.readFileSync("/proc/self/status", "utf8"));
    return { dataBytes: data ? Number(data[1]) * 1024 : null, rssBytes };
  } catch {
    return { dataBytes: null, rssBytes };
  }
}

const memoryChecks = !process.argv.includes("--no-memory-checks");
let jobs = Promise.resolve();

async function handle(request: WorkerRequest) {
  const result = await thumbnailFromFile({ root: request.root, path: request.path }, { memoryChecks });
  // Free the source and decoder buffers now rather than at V8's next
  // collection, so the next decode starts from the worker's own size.
  globalThis.gc?.();
  const header = { type: "result", id: request.id, memory: memory() };
  channel.write(result.ok
    ? encodeFrame({ ...header, ok: true, details: result.details }, result.thumbnail)
    : encodeFrame({ ...header, ok: false, outcome: result.outcome, details: result.details }));
}

// Requests are JSON lines; one decode at a time, in order.
let pending = "";
channel.on("data", (chunk: Buffer) => {
  pending += chunk.toString("utf8");
  if (pending.length > MAX_REQUEST_BYTES) process.exit(1);
  for (let end = pending.indexOf("\n"); end !== -1; end = pending.indexOf("\n")) {
    const request = JSON.parse(pending.slice(0, end)) as WorkerRequest;
    pending = pending.slice(end + 1);
    jobs = jobs.then(() => handle(request));
  }
});

const oomScoreAdj = preferAsOomVictim();
channel.write(encodeFrame({ type: "ready", pid: process.pid, dataLimitBytes: dataLimit(), oomScoreAdj }));
