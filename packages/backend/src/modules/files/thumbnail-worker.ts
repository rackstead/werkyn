import fs from "node:fs";
import { thumbnailFromFile, type DecodeResult } from "./thumbnail-decode.js";

/**
 * A thumbnail decoder process, started by thumbnail-workers.ts with a hard
 * data limit. It decodes one stored file at a time, as asked over the IPC
 * channel, and answers with the thumbnail or the reason there is none. It
 * exits when the channel closes, so it never outlives the server.
 *
 *   node thumbnail-worker.js [--no-memory-checks]
 */

export type WorkerRequest = { id: number; path: string };

export type WorkerMessage =
  | { type: "ready"; pid: number; dataLimitBytes: number | null; oomScoreAdj: number | null }
  | { type: "result"; id: number; result: DecodeResult; memory: WorkerMemory };

/** Memory of the worker after a job, in bytes (Linux), for recycling and logs. */
export interface WorkerMemory {
  dataBytes: number | null;
  rssBytes: number;
}

if (!process.send) {
  console.error("thumbnail-worker must be started by the server (no IPC channel)");
  process.exit(1);
}

process.on("disconnect", () => process.exit(0));

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

const send = (message: WorkerMessage) => {
  process.send!(message, undefined, undefined, () => {}); // the server may be gone
};

const memoryChecks = !process.argv.includes("--no-memory-checks");
let jobs = Promise.resolve();

process.on("message", (request: WorkerRequest) => {
  // One decode at a time, in order.
  jobs = jobs.then(async () => {
    const result = await thumbnailFromFile(request.path, { memoryChecks });
    // Free the source and decoder buffers now rather than at V8's next
    // collection, so the next decode starts from the worker's own size.
    globalThis.gc?.();
    send({ type: "result", id: request.id, result, memory: memory() });
  });
});

const oomScoreAdj = preferAsOomVictim();
send({ type: "ready", pid: process.pid, dataLimitBytes: dataLimit(), oomScoreAdj });
