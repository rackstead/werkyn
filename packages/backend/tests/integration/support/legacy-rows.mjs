// Rows that the R35 database constraints refuse (docs/remediation/r35-constraints.md),
// for tests of how the application treats rows an older version could have
// stored. A migrated database cannot hold them, so tests write them with the
// constraints bypassed.

/**
 * Runs `write(tx)` in one transaction with foreign keys and triggers switched
 * off (session_replication_role = replica, which needs a superuser, as the
 * disposable test databases have). Covers the composite keys and the
 * same-project triggers; CHECK constraints need withoutConstraints().
 */
export function writeLegacyRows(prisma, write) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
    return write(tx);
  });
}

/**
 * Drops the named CHECK constraints ("Table.constraint") while `work` runs and
 * adds them back afterwards. `work` must delete or repair the rows it stored
 * that break them: adding them back validates every row and fails otherwise.
 * When `work` or the validation fails, the constraints stay NOT VALID, which
 * still refuses new rows.
 */
export async function withoutConstraints(prisma, names, work) {
  const dropped = [];
  let failed = false;
  try {
    for (const name of names) {
      const [table, constraint] = name.split(".");
      const [row] = await prisma.$queryRaw`
        SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid = ${`"${table}"`}::regclass AND conname = ${constraint} AND contype = 'c'`;
      if (!row) throw new Error(`No CHECK constraint ${name}`);
      await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" DROP CONSTRAINT "${constraint}"`);
      dropped.push([table, constraint, row.definition]);
    }
    return await work();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    for (const [table, constraint, definition] of dropped)
      await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" ADD CONSTRAINT "${constraint}" ${definition} NOT VALID`);
    if (!failed)
      for (const [table, constraint] of dropped)
        await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" VALIDATE CONSTRAINT "${constraint}"`);
  }
}
