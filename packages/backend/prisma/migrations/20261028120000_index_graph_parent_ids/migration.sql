-- Parent foreign keys cascade by "parentId" alone, and subtree validation
-- looks children up by "parentId" alone to detect rows outside the expected
-- workspace or space. The existing composite indexes lead with
-- "workspaceId"/"spaceId", so each cascaded row otherwise scans the table.

-- CreateIndex
CREATE INDEX "File_parentId_idx" ON "File"("parentId");

-- CreateIndex
CREATE INDEX "WikiPage_parentId_idx" ON "WikiPage"("parentId");
