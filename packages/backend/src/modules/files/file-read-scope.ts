import { Prisma } from "@prisma/client";

/**
 * Current read authority for a single active file. This mirrors
 * assertFileAccess's read policy without materializing every shared descendant.
 * Values/outer-column expressions are composed with Prisma.sql, never raw text.
 */
function fileReadable(
  fileId: Prisma.Sql,
  userId: Prisma.Sql,
  workspaceId: Prisma.Sql,
): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM "File" nf
    JOIN "WorkspaceMember" nwm
      ON nwm."workspaceId" = nf."workspaceId" AND nwm."userId" = ${userId}
    LEFT JOIN "TeamFolder" nrootRelation ON nrootRelation."folderId" = nf."id"
    LEFT JOIN "TeamFolder" nteam
      ON nteam."id" = COALESCE(nrootRelation."id", nf."teamFolderId")
    LEFT JOIN "File" nroot ON nroot."id" = nteam."folderId"
    WHERE nf."id" = ${fileId} AND nf."trashedAt" IS NULL
      AND (${workspaceId} IS NULL OR nf."workspaceId" = ${workspaceId})
      AND (
        COALESCE(nrootRelation."id", nf."teamFolderId") IS NULL
        OR (
          nteam."workspaceId" = nf."workspaceId"
          AND nroot."workspaceId" = nf."workspaceId"
          AND nroot."isFolder" = true AND nroot."trashedAt" IS NULL
        )
      )
      AND (
        nwm."role" = 'ADMIN'
        OR (COALESCE(nrootRelation."id", nf."teamFolderId") IS NULL AND nf."ownerId" = ${userId})
        OR EXISTS (
          SELECT 1 FROM "TeamFolderMember" ntm
          WHERE ntm."teamFolderId" = nteam."id" AND ntm."userId" = ${userId}
        )
        OR EXISTS (
          SELECT 1 FROM "TeamFolderGroup" ntg
          JOIN "Group" ng ON ng."id" = ntg."groupId" AND ng."workspaceId" = nf."workspaceId"
          JOIN "GroupMember" ngm ON ngm."groupId" = ng."id" AND ngm."userId" = ${userId}
          WHERE ntg."teamFolderId" = nteam."id"
        )
        OR EXISTS (
          WITH RECURSIVE ancestors AS (
            SELECT nf."id", nf."parentId"
            WHERE nf."ownerId" IS NOT NULL OR nteam."id" IS NOT NULL
            UNION
            SELECT parent."id", parent."parentId"
            FROM "File" parent
            LEFT JOIN "TeamFolder" parentRootRelation ON parentRootRelation."folderId" = parent."id"
            JOIN ancestors child ON child."parentId" = parent."id"
            WHERE parent."workspaceId" = nf."workspaceId"
              AND parent."isFolder" = true AND parent."trashedAt" IS NULL
              AND parent."ownerId" IS NOT DISTINCT FROM nf."ownerId"
              AND COALESCE(parentRootRelation."id", parent."teamFolderId")
                    IS NOT DISTINCT FROM COALESCE(nrootRelation."id", nf."teamFolderId")
          )
          SELECT 1 FROM ancestors ancestor
          JOIN "FileShare" ns ON ns."fileId" = ancestor."id"
          WHERE ns."workspaceId" = nf."workspaceId" AND ns."sharedWithId" = ${userId}
        )
      )
  )`;
}

/**
 * A file-bearing notification names an authorizable source, even when legacy
 * data omitted workspaceId. Unrelated notifications keep their existing scope
 * checks; a FILE_SHARED row without a usable fileId cannot expose its title.
 */
export function notificationFileReadableSql(
  data: Prisma.Sql,
  type: Prisma.Sql,
  userId: Prisma.Sql,
): Prisma.Sql {
  const fileId = Prisma.sql`(${data}->>'fileId')`;
  const workspaceId = Prisma.sql`(${data}->>'workspaceId')`;
  return Prisma.sql`(
    (
      ${type}::text <> 'FILE_SHARED'
      AND (${data}->'fileId' IS NULL OR ${data}->'fileId' = 'null'::jsonb)
    )
    OR (
      jsonb_typeof(${data}->'fileId') = 'string' AND ${fileId} <> ''
      AND (
        ${data}->'workspaceId' IS NULL OR ${data}->'workspaceId' = 'null'::jsonb
        OR jsonb_typeof(${data}->'workspaceId') = 'string'
      )
      AND ${fileReadable(fileId, userId, workspaceId)}
    )
  )`;
}
