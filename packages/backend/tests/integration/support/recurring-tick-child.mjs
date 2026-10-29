// Runs one recurring-task scheduler pass in its own process, so a test can
// kill it (SIGKILL) at a database barrier to simulate a crash mid-occurrence.
// DATABASE_URL names the database (with an application_name the test uses to
// find this process's sessions); FAKE_NOW fixes the clock.
import { mock } from "node:test";

if (process.env.FAKE_NOW) {
  mock.timers.enable({ apis: ["Date"], now: Number(process.env.FAKE_NOW) });
}

const { PrismaClient } = await import("@prisma/client");
const { processRecurringTasks } = await import("../../../src/schedulers/recurring-tasks.js");

const prisma = new PrismaClient();
const quiet = { info() {}, warn() {}, error() {} };
try {
  await processRecurringTasks(prisma, { log: quiet, broadcast() {} });
} finally {
  await prisma.$disconnect();
}
