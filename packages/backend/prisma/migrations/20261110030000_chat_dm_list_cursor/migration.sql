-- A DM-list walk keeps its order here. The request cursor is the row id and
-- an offset, so a long list does not put every remaining id in the URL.
-- Rows older than an hour are deleted when a new walk starts.

-- CreateTable
CREATE TABLE "ChatDmListCursor" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "ids" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatDmListCursor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChatDmListCursor_createdAt_idx" ON "ChatDmListCursor"("createdAt");
