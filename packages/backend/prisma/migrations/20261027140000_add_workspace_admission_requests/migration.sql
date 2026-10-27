-- CreateTable
CREATE TABLE "WorkspaceAdmissionRequest" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "inviteId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceAdmissionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkspaceAdmissionRequest_workspaceId_createdAt_idx" ON "WorkspaceAdmissionRequest"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkspaceAdmissionRequest_inviteId_workspaceId_idx" ON "WorkspaceAdmissionRequest"("inviteId", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceAdmissionRequest_userId_workspaceId_key" ON "WorkspaceAdmissionRequest"("userId", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceInvite_id_workspaceId_key" ON "WorkspaceInvite"("id", "workspaceId");

-- AddForeignKey
ALTER TABLE "WorkspaceAdmissionRequest" ADD CONSTRAINT "WorkspaceAdmissionRequest_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceAdmissionRequest" ADD CONSTRAINT "WorkspaceAdmissionRequest_inviteId_workspaceId_fkey" FOREIGN KEY ("inviteId", "workspaceId") REFERENCES "WorkspaceInvite"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceAdmissionRequest" ADD CONSTRAINT "WorkspaceAdmissionRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

