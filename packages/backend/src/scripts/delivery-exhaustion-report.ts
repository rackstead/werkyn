/** Local read-only report; see docs/remediation/delivery-exhaustion-report.md. */
import { pathToFileURL } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { Prisma, PrismaClient } from "@prisma/client";

// Coupled to the workers by integration tests, without importing their app graph.
export const DELIVERY_ATTEMPT_CAPS = Object.freeze({ chat: 20, notification: 20 });
export const MAX_REPORT_BYTES = 256 * 1024;
const MAX_ID_BYTES = 256;
type Kind = keyof typeof DELIVERY_ATTEMPT_CAPS;
type Status = "cap_reached_lease_active" | "cap_reached_unscheduled" |
  "cap_reached_lease_expired" | "cap_reached_scheduled_unleased";
const STATUSES: readonly string[] = ["cap_reached_lease_active", "cap_reached_unscheduled",
  "cap_reached_lease_expired", "cap_reached_scheduled_unleased"];
type Failure = "invalid_options" | "query_failed" | "oversized_id" | "output_limit" | "output_failed";
export class DeliveryReportError extends Error {
  constructor(readonly code: Failure) { super(code); }
}
export interface DeliveryReportOptions { kind: Kind; limit?: number; after?: string }
interface Row {
  id: string | null; idBytes: number; attempts: number; status: string;
  nextAttemptAt: Date | null; lockedUntil: Date | null;
  notifiedAt: Date | null; createdAt: Date;
}

function boundedId(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_ID_BYTES && !value.includes("\0") &&
    Buffer.byteLength(value, "utf8") <= MAX_ID_BYTES && Buffer.from(value, "utf8").toString("utf8") === value;
}
function checkedOptions(options: DeliveryReportOptions) {
  if (!options || typeof options !== "object" || Array.isArray(options) ||
    Object.keys(options).some((key) => !["kind", "limit", "after"].includes(key)) ||
    (options.kind !== "chat" && options.kind !== "notification") ||
    (options.after !== undefined && !boundedId(options.after))) throw new DeliveryReportError("invalid_options");
  const limit = options.limit === undefined ? 50 : options.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new DeliveryReportError("invalid_options");
  return { kind: options.kind, limit, after: options.after };
}
function iso(value: Date | null): string | null {
  if (value === null) return null;
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new DeliveryReportError("query_failed");
  return value.toISOString();
}

export async function findExhaustedDeliveries(prisma: PrismaClient, options: DeliveryReportOptions) {
  const { kind, limit, after } = checkedOptions(options);
  const cap = DELIVERY_ATTEMPT_CAPS[kind];
  // Static, validated identifiers only. All caller values remain bound parameters.
  const table = Prisma.raw(kind === "chat" ? '"ChatMessageDelivery"' : '"NotificationDelivery"');
  const key = Prisma.raw(kind === "chat" ? 'd."messageId"' : 'd."id"');
  try {
    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '2000ms'");
      const [clock] = await tx.$queryRaw<Array<{ at: Date }>>`
        SELECT date_trunc('milliseconds', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AS at`;
      if (!clock) throw new DeliveryReportError("query_failed");
      const observedAt = iso(clock.at);
      if (observedAt === null) throw new DeliveryReportError("query_failed");
      const cursor = after === undefined ? Prisma.empty : Prisma.sql`AND ${key} COLLATE "C" > ${after} COLLATE "C"`;
      const rows = await tx.$queryRaw<Row[]>`
        SELECT CASE WHEN octet_length(${key}) <= ${MAX_ID_BYTES} THEN ${key} ELSE NULL END AS id,
          octet_length(${key}) AS "idBytes", d.attempts,
          d."nextAttemptAt", d."lockedUntil", d."notifiedAt", d."createdAt",
          CASE WHEN d."lockedUntil" > (${observedAt}::timestamptz AT TIME ZONE 'UTC')
            THEN 'cap_reached_lease_active'
            WHEN d."nextAttemptAt" IS NULL THEN 'cap_reached_unscheduled'
            WHEN d."lockedUntil" IS NOT NULL THEN 'cap_reached_lease_expired'
            ELSE 'cap_reached_scheduled_unleased' END AS status
        FROM ${table} d WHERE d.attempts >= ${cap} ${cursor}
        ORDER BY ${key} COLLATE "C" ASC LIMIT ${limit + 1}`;
      // Inspect the lookahead too: never skip or truncate an unrepresentable key.
      if (rows.some((row) => row.idBytes > MAX_ID_BYTES || !boundedId(row.id)))
        throw new DeliveryReportError("oversized_id");
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit).map((row) => {
        if (!Number.isInteger(row.attempts) || row.attempts < cap || !STATUSES.includes(row.status))
          throw new DeliveryReportError("query_failed");
        return { id: row.id!, attempts: row.attempts, status: row.status as Status,
          nextAttemptAt: iso(row.nextAttemptAt), lockedUntil: iso(row.lockedUntil),
          notifiedAt: iso(row.notifiedAt), createdAt: iso(row.createdAt) };
      });
      return { version: 1 as const, readOnly: true as const, kind, attemptCap: cap, observedAt,
        limit, rows: page, hasMore, nextAfter: hasMore ? page.at(-1)!.id : null,
        completeAfterCursor: !hasMore };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 1000, timeout: 4000 });
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_REPORT_BYTES)
      throw new DeliveryReportError("output_limit");
    return result;
  } catch (error) {
    if (error instanceof DeliveryReportError) throw error;
    // Database exceptions can contain connection information or arbitrary data.
    throw new DeliveryReportError("query_failed");
  }
}

export function parseDeliveryReportArgs(args: string[]): DeliveryReportOptions {
  if (!Array.isArray(args) || args.length > 3 || args.some((arg) => typeof arg !== "string" || arg.length > 512))
    throw new DeliveryReportError("invalid_options");
  const values: Record<string, string> = {};
  for (const arg of args) {
    const match = /^--(kind|limit|after)=([\s\S]*)$/.exec(arg);
    if (!match || Object.hasOwn(values, match[1]!)) throw new DeliveryReportError("invalid_options");
    values[match[1]!] = match[2]!;
  }
  if (values.limit !== undefined && !/^[1-9][0-9]{0,2}$/.test(values.limit))
    throw new DeliveryReportError("invalid_options");
  return checkedOptions({ kind: values.kind as Kind,
    ...(values.limit === undefined ? {} : { limit: Number(values.limit) }),
    ...(values.after === undefined ? {} : { after: values.after }) });
}

async function main() {
  let prisma: PrismaClient | undefined;
  let report: Awaited<ReturnType<typeof findExhaustedDeliveries>> | undefined;
  let failure: Failure | undefined;
  let deadlineFired = false;
  let outputChild: ChildProcess | undefined;
  let outputClosed: Promise<void> = Promise.resolve();
  let outputFailed = false, closingOutput = false, killSent = false, nextOutputId = 0;
  const pending = new Map<number, (ok: boolean) => void>();
  const settlePending = () => { for (const resolve of pending.values()) resolve(false); pending.clear(); };
  // The child owns potentially blocking descriptors. It receives no database or
  // application environment and has no child-launch code. Its IPC is finite:
  // one report and at most two fixed errors, with at most two writes in flight.
  const outputProgram = String.raw`
const fs = require("node:fs");
let received = 0, active = 0;
process.on("message", m => {
  if (!m || typeof m !== "object" || Object.keys(m).length !== 3 ||
      !Number.isInteger(m.id) || m.id !== received || received >= 3 ||
      (m.fd !== 1 && m.fd !== 2) || typeof m.text !== "string" || active >= 2)
    return process.exit(1);
  const bytes = Buffer.from(m.text, "utf8");
  if (bytes.length > ${MAX_REPORT_BYTES + 1}) return process.exit(1);
  received++; active++;
  let offset = 0, settled = false;
  const finish = ok => {
    if (settled) return; settled = true; active--;
    if (process.connected) process.send({ id: m.id, ok }, () => {});
  };
  const step = () => {
    try {
      fs.write(m.fd, bytes, offset, bytes.length - offset, null, (error, count) => {
        if (error && (error.code === "EAGAIN" || error.code === "EWOULDBLOCK")) return setTimeout(step, 10);
        if (error || count <= 0) return finish(false);
        offset += count;
        if (offset === bytes.length) finish(true); else step();
      });
    } catch { finish(false); }
  };
  if (bytes.length) step(); else finish(true);
});
process.on("disconnect", () => process.exit(0));
`;
  const killOutput = () => {
    if (outputChild && outputChild.exitCode === null && outputChild.signalCode === null && !killSent) {
      killSent = outputChild.kill("SIGKILL");
    }
  };
  const closeOutput = async (force: boolean) => {
    if (!outputChild) return;
    if (force) killOutput();
    else if (outputChild.connected) { closingOutput = true; outputChild.disconnect(); }
    await outputClosed;
  };
  const startOutput = () => {
    if (outputChild || outputFailed) return;
    const childEnv: NodeJS.ProcessEnv = {};
    if (process.platform === "win32" && process.env.SystemRoot) childEnv.SystemRoot = process.env.SystemRoot;
    try {
      const child = spawn(process.execPath, ["--input-type=commonjs", "-e", outputProgram], {
        stdio: ["ignore", 1, 2, "ipc"], env: childEnv, windowsHide: true,
      });
      outputChild = child;
      // There are no owned stdio streams to drain: descriptors1/2 are inherited.
      // Explicit IPC disconnect need not emit ChildProcess.close on Node22.
      // Require both actual process exit and IPC disconnect instead.
      let exited = false, disconnected = false;
      let resolveOutput!: () => void;
      outputClosed = new Promise<void>((resolve) => { resolveOutput = resolve; });
      const settled = () => { if (exited && disconnected) resolveOutput(); };
      child.once("exit", (code, signal) => {
        exited = true;
        if (code !== 0 || signal !== null) outputFailed = true;
        settlePending(); settled();
      });
      child.on("error", () => {
        outputFailed = true; settlePending();
        if (child.pid === undefined) resolveOutput(); // Spawn failed: no process can emit exit.
        else killOutput();
      });
      child.once("disconnect", () => {
        disconnected = true;
        if (!closingOutput) { outputFailed = true; settlePending(); killOutput(); }
        settled();
      });
      child.on("message", (raw) => {
        const message = raw as { id?: unknown; ok?: unknown } | null;
        if (!message || typeof message !== "object" || Object.keys(message).length !== 2 ||
            typeof message.id !== "number" || !Number.isInteger(message.id) ||
            typeof message.ok !== "boolean" || !pending.has(message.id)) {
          outputFailed = true; settlePending(); killOutput(); return;
        }
        const resolve = pending.get(message.id)!; pending.delete(message.id); resolve(message.ok);
      });
    } catch { outputFailed = true; settlePending(); }
  };
  const write = (fd: 1 | 2, text: string): Promise<boolean> => {
    if (Buffer.byteLength(text, "utf8") > MAX_REPORT_BYTES + 1 || pending.size >= 2 || nextOutputId >= 3)
      return Promise.resolve(false);
    startOutput();
    if (outputFailed || !outputChild?.connected || !outputChild.send) return Promise.resolve(false);
    const id = nextOutputId++;
    return new Promise<boolean>((resolve) => {
      pending.set(id, resolve);
      try {
        outputChild!.send!({ id, fd, text }, (error) => {
          if (error) { outputFailed = true; settlePending(); killOutput(); }
        });
      } catch { outputFailed = true; settlePending(); killOutput(); }
    });
  };
  // Reserve the last100ms for collecting the owned output child. The absolute
  // 15-second stop remains referenced, including child startup and blocked I/O.
  const absoluteStop = setTimeout(() => { deadlineFired = true; killOutput(); process.exit(1); }, 15_000);
  const collectDeadline = setTimeout(() => {
    deadlineFired = true; process.exitCode = 1;
    void closeOutput(true).finally(() => process.exit(1));
  }, 14_900);
  const deadline = setTimeout(() => {
    deadlineFired = true; process.exitCode = 1;
    void write(2, '{"error":"deadline_exceeded"}\n')
      .finally(() => closeOutput(true).finally(() => process.exit(1)));
  }, 14_750);
  try {
    const options = parseDeliveryReportArgs(process.argv.slice(2));
    const url = new URL(process.env.DATABASE_URL ?? "");
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || url.pathname.length < 2)
      throw new DeliveryReportError("invalid_options");
    url.searchParams.set("connect_timeout", "5");
    url.searchParams.set("pool_timeout", "2");
    url.searchParams.set("connection_limit", "1");
    prisma = new PrismaClient({ datasourceUrl: url.toString() });
    report = await findExhaustedDeliveries(prisma, options);
  } catch (error) {
    failure = error instanceof DeliveryReportError ? error.code : "query_failed";
  } finally {
    try { await prisma?.$disconnect(); }
    catch { failure ??= "query_failed"; }
  }
  try {
    if (deadlineFired) return;
    if (failure || !report) {
      await write(2, JSON.stringify({ error: failure ?? "query_failed" }) + "\n");
      process.exitCode = 1;
    } else {
      const delivered = await write(1, JSON.stringify(report) + "\n");
      if (deadlineFired) return;
      if (delivered) process.exitCode = report.rows.length ? 2 : 0;
      else {
        await write(2, '{"error":"output_failed"}\n');
        process.exitCode = 1;
      }
    }
  } finally {
    if (!deadlineFired) {
      await closeOutput(false);
      if (outputFailed) process.exitCode = 1;
      if (!deadlineFired) { clearTimeout(deadline); clearTimeout(collectDeadline); clearTimeout(absoluteStop); }
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
