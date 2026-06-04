import { defineConfig } from "prisma/config";

// Prisma 7 CLI config. The DATABASE_URL is only needed by CLI commands that
// connect (migrate dev/deploy); the app itself builds the connection from
// DB_PATH via the driver adapter (see src/db.ts). The fallback matches the
// container default so `prisma migrate deploy` works with just DB_PATH set.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: {
    url:
      process.env.DATABASE_URL ??
      (process.env.DB_PATH ? `file:${process.env.DB_PATH}` : "file:/data/queue.db"),
  },
});
