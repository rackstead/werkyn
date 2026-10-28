import type { FastifyRequest, FastifyReply } from "fastify";
import * as timeEntriesService from "./time-entries.service.js";
import * as timeReportsService from "./time-reports.service.js";
import * as userRatesService from "./user-rates.service.js";
import type {
  CreateTimeEntryInput,
  UpdateTimeEntryInput,
  TimeEntryQuery,
  TimeReportQuery,
  SetUserRateInput,
} from "@pm/shared";

// ─── Time Entries ───────────────────────────────────────

export async function createEntryHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { wid } = request.params as { wid: string };
  const body = request.body as CreateTimeEntryInput;

  const entry = await timeEntriesService.createEntry(
    request.server.prisma,
    wid,
    request.user!.id,
    body,
  );

  return reply.status(201).send({ data: entry });
}

export async function listEntriesHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { wid } = request.params as { wid: string };
  const query = request.query as TimeEntryQuery;

  const entries = await timeEntriesService.listEntries(
    request.server.prisma,
    wid,
    request.user!.id,
    request.workspaceMember!.role,
    query,
  );

  return reply.send({ data: entries });
}

export async function updateEntryHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { eid } = request.params as { eid: string };
  const body = request.body as UpdateTimeEntryInput;

  const entry = await timeEntriesService.updateEntry(
    request.server.prisma,
    eid,
    request.user!.id,
    request.workspaceMember!.role,
    body,
  );

  return reply.send({ data: entry });
}

export async function deleteEntryHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { eid } = request.params as { eid: string };

  await timeEntriesService.deleteEntry(
    request.server.prisma,
    eid,
    request.user!.id,
    request.workspaceMember!.role,
  );

  return reply.status(204).send();
}

// ─── Reports ────────────────────────────────────────────

/** Records report entries left out because their stored hours are not finite. */
function logSkippedEntries(
  request: FastifyRequest,
  workspaceId: string,
  query: TimeReportQuery,
  skippedEntries: number,
) {
  if (skippedEntries === 0) return;
  request.log.warn(
    {
      workspaceId,
      startDate: query.startDate,
      endDate: query.endDate,
      skippedEntries,
    },
    "Time report left out entries whose stored hours are not a finite number",
  );
}

export async function getReportHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { wid } = request.params as { wid: string };
  const query = request.query as TimeReportQuery;

  const report = await timeReportsService.generateReport(
    request.server.prisma,
    wid,
    request.user!.id,
    query,
  );
  logSkippedEntries(request, wid, query, report.summary.skippedEntries);

  return reply.send({ data: report });
}

export async function exportCSVHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { wid } = request.params as { wid: string };
  const query = request.query as TimeReportQuery;

  const { csv, skippedEntries } = await timeReportsService.exportReportCSV(
    request.server.prisma,
    wid,
    request.user!.id,
    query,
  );
  logSkippedEntries(request, wid, query, skippedEntries);

  return reply
    .header("Content-Type", "text/csv; charset=utf-8")
    .header("Content-Disposition", "attachment; filename=time-report.csv")
    // Entries left out because their stored hours are not a finite number.
    .header("X-Skipped-Entries", String(skippedEntries))
    .send(csv);
}

// ─── User Rates ─────────────────────────────────────────

export async function setRateHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { wid, uid } = request.params as { wid: string; uid: string };
  const body = request.body as SetUserRateInput;

  const rate = await userRatesService.setRate(
    request.server.prisma,
    wid,
    uid,
    body,
  );

  return reply.status(200).send({ data: rate });
}

export async function getRateHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { wid, uid } = request.params as { wid: string; uid: string };

  const rate = await userRatesService.getRate(
    request.server.prisma,
    wid,
    uid,
  );

  return reply.send({ data: rate });
}

export async function listRatesHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { wid } = request.params as { wid: string };

  const rates = await userRatesService.listRates(
    request.server.prisma,
    wid,
  );

  return reply.send({ data: rates });
}
