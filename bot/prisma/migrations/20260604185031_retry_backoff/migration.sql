-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_jobs" (
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
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "retry_at" DATETIME,
    "batch_id" TEXT NOT NULL,
    "tg_chat_id" BIGINT NOT NULL,
    "tg_status_msg_id" BIGINT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" DATETIME,
    "finished_at" DATETIME
);
INSERT INTO "new_jobs" ("batch_id", "created_at", "error", "eta", "final_path", "finished_at", "id", "mode", "progress", "source", "speed", "staging_path", "started_at", "status", "tg_chat_id", "tg_status_msg_id", "title", "url") SELECT "batch_id", "created_at", "error", "eta", "final_path", "finished_at", "id", "mode", "progress", "source", "speed", "staging_path", "started_at", "status", "tg_chat_id", "tg_status_msg_id", "title", "url" FROM "jobs";
DROP TABLE "jobs";
ALTER TABLE "new_jobs" RENAME TO "jobs";
CREATE INDEX "jobs_status_idx" ON "jobs"("status");
CREATE INDEX "jobs_batch_id_idx" ON "jobs"("batch_id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
