// Ranks SQL statements by total time from a PostgreSQL log written with
// log_min_duration_statement = 0 (set it on the benchmark database only:
// ALTER DATABASE <db> SET log_min_duration_statement = 0), and optionally runs
// EXPLAIN (ANALYZE, BUFFERS) on the slowest call of the top SELECTs.
//
//   tsx scripts/perf/statements.ts <postgres.log> [--top=25] [--out=ranked.json]
//   DATABASE_URL=... tsx scripts/perf/statements.ts <postgres.log> --explain=15 [--plans=plans.txt]
//
// The log is expected in the default "%m [%p] " prefix format, as printed by
// `docker logs` for the postgres image. Durations of the parse, bind and
// execute steps of a statement are summed; calls counts executions.
// Statements that differ only in whitespace or comments outside quotes are
// grouped; quoted literals and identifiers are kept exactly. Each EXPLAIN runs
// in a read-only transaction that is rolled back, so a logged statement that
// writes or locks rows is skipped instead of executed.

import { readFileSync, writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const option = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
if (!file) throw new Error("Usage: statements.ts <postgres.log> [--top=25] [--out=file] [--explain=N] [--plans=file]");
const TOP = Number(option("top") ?? "25");
const EXPLAIN = Number(option("explain") ?? "0");

const ENTRY = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)? \S+ \[(\d+)\] (\w+):\s+(.*)$/;
const DURATION = /^duration: ([\d.]+) ms\s+(parse|bind|execute) [^:]*: ([\s\S]*)$/;

/**
 * Splits SQL into quoted text ('…' and "…", doubled quotes as escapes),
 * comments and the code between them, so edits can leave quoted text alone.
 */
function segments(sql: string) {
  const parts: { kind: "code" | "quoted" | "comment"; text: string }[] = [];
  let i = 0;
  let start = 0;
  const push = (kind: "code" | "quoted" | "comment", end: number) => {
    if (end > start) parts.push({ kind, text: sql.slice(start, end) });
    start = end;
  };
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      push("code", i);
      i += 1;
      while (i < sql.length) {
        if (sql[i] === c && sql[i + 1] === c) i += 2;
        else if (sql[i] === c) {
          i += 1;
          break;
        } else i += 1;
      }
      push("quoted", i);
    } else if (c === "-" && sql[i + 1] === "-") {
      push("code", i);
      while (i < sql.length && sql[i] !== "\n") i += 1;
      push("comment", i);
    } else if (c === "/" && sql[i + 1] === "*") {
      push("code", i);
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      push("comment", i);
    } else i += 1;
  }
  push("code", i);
  return parts;
}

/** Collapses whitespace and drops comments outside quoted text. */
function normalize(sql: string) {
  const out: string[] = [];
  let code = "";
  for (const part of segments(sql)) {
    if (part.kind === "quoted") {
      out.push(code.replace(/\s+/g, " "), part.text);
      code = "";
    } else {
      code += part.kind === "comment" ? " " : part.text;
    }
  }
  out.push(code.replace(/\s+/g, " "));
  return out.join("").trim();
}

interface Statement {
  sql: string;
  calls: number;
  totalMs: number;
  executeMs: number;
  maxMs: number;
  maxParams?: string;
}

function parse(text: string) {
  const entries: { pid: string; level: string; message: string }[] = [];
  for (const line of text.split("\n")) {
    const m = ENTRY.exec(line);
    if (m) entries.push({ pid: m[1], level: m[2], message: m[3] });
    else if (entries.length && (line.startsWith("\t") || line.startsWith(" "))) entries[entries.length - 1].message += `\n${line}`;
  }
  const stats = new Map<string, Statement>();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.level !== "LOG") continue;
    const d = DURATION.exec(e.message);
    if (!d) continue;
    const ms = Number(d[1]);
    const phase = d[2];
    // Continuation lines of a log message start with a tab after the newline.
    const sql = normalize(d[3].replace(/\n\t/g, "\n"));
    const s = stats.get(sql) ?? { sql, calls: 0, totalMs: 0, executeMs: 0, maxMs: 0 };
    s.totalMs += ms;
    if (phase === "execute") {
      s.calls += 1;
      s.executeMs += ms;
      if (ms >= s.maxMs) {
        s.maxMs = ms;
        const next = entries[i + 1];
        const params = next && next.pid === e.pid && next.level === "DETAIL" ? /^parameters: ([\s\S]*)$/i.exec(next.message)?.[1] : undefined;
        s.maxParams = params?.replace(/\n\t/g, "\n");
      }
    }
    stats.set(sql, s);
  }
  return [...stats.values()].filter((s) => s.calls > 0).sort((a, b) => b.totalMs - a.totalMs);
}

/** Splits "$1 = 'a', $2 = NULL" into literals, honouring quoted commas. */
function parameters(list: string | undefined) {
  const values = new Map<number, string>();
  if (!list) return values;
  const re = /\$(\d+) = ('(?:[^']|'')*'|NULL)/g;
  for (const m of list.matchAll(re)) values.set(Number(m[1]), m[2]);
  return values;
}

/** Substitutes the logged parameter literals for $n placeholders outside quoted text. */
function bind(sql: string, params: string | undefined) {
  const values = parameters(params);
  return segments(sql)
    .map((p) =>
      p.kind === "quoted" ? p.text : p.text.replace(/\$(\d+)/g, (whole, n: string) => values.get(Number(n)) ?? whole),
    )
    .join("");
}

/** Thrown to roll back the read-only transaction an EXPLAIN runs in. */
class Rollback extends Error {}

async function explain(ranked: Statement[]) {
  const prisma = new PrismaClient();
  const out: string[] = [];
  try {
    let done = 0;
    for (const [rank, s] of ranked.entries()) {
      if (done >= EXPLAIN) break;
      if (!/^(select|with)\b/i.test(s.sql)) continue;
      done += 1;
      const sql = bind(s.sql, s.maxParams);
      let rows: { "QUERY PLAN": string }[] = [];
      try {
        // EXPLAIN ANALYZE executes the statement: read-only refuses writes and
        // row locks, and the transaction is always rolled back.
        await prisma.$transaction(
          async (tx) => {
            await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
            rows = await tx.$queryRawUnsafe<{ "QUERY PLAN": string }[]>(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`);
            throw new Rollback();
          },
          { maxWait: 10_000, timeout: 300_000 },
        );
      } catch (error) {
        if (!(error instanceof Rollback)) {
          const reason = error instanceof Error ? error.message.split("\n").filter(Boolean).pop() : String(error);
          out.push(`### #${rank + 1}  skipped: ${reason}`, sql, "");
          continue;
        }
      }
      out.push(
        `### #${rank + 1}  total ${s.totalMs.toFixed(1)} ms, ${s.calls} calls, max ${s.maxMs.toFixed(2)} ms`,
        sql,
        ...rows.map((r) => r["QUERY PLAN"]),
        "",
      );
    }
  } finally {
    await prisma.$disconnect();
  }
  return out.join("\n");
}

async function main() {
  const ranked = parse(readFileSync(file!, "utf8"));
  const total = ranked.reduce((a, s) => a + s.totalMs, 0);
  console.log(`${ranked.length} statements, ${ranked.reduce((a, s) => a + s.calls, 0)} calls, ${total.toFixed(0)} ms total`);
  for (const [i, s] of ranked.slice(0, TOP).entries()) {
    console.log(
      `#${String(i + 1).padStart(2)} ${s.totalMs.toFixed(1).padStart(10)} ms ${String(s.calls).padStart(6)} calls ${(s.totalMs / s.calls).toFixed(2).padStart(8)} ms/call  ${s.sql.slice(0, 160)}`,
    );
  }
  const out = option("out");
  if (out) writeFileSync(out, JSON.stringify(ranked.slice(0, Math.max(TOP, EXPLAIN * 3)), null, 2));
  if (EXPLAIN > 0) {
    const plans = await explain(ranked);
    const target = option("plans");
    if (target) writeFileSync(target, plans);
    else console.log(plans);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
