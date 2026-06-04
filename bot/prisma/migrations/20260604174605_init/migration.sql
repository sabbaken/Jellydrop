-- CreateTable
CREATE TABLE "jobs" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "url" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'video',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "source" TEXT,
    "title" TEXT,
    "progress" REAL NOT NULL DEFAULT 0,
    "speed" TEXT,
    "eta" TEXT,
    "staging_path" TEXT,
    "final_path" TEXT,
    "error" TEXT,
    "batch_id" TEXT NOT NULL,
    "tg_chat_id" BIGINT NOT NULL,
    "tg_status_msg_id" BIGINT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" DATETIME,
    "finished_at" DATETIME
);

-- CreateIndex
CREATE INDEX "jobs_status_idx" ON "jobs"("status");

-- CreateIndex
CREATE INDEX "jobs_batch_id_idx" ON "jobs"("batch_id");
