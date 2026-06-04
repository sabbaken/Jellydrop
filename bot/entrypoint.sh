#!/bin/sh
# Apply pending schema migrations, then hand PID 1 to the bot (exec keeps
# SIGTERM delivery intact for graceful shutdown).
set -e

export DATABASE_URL="${DATABASE_URL:-file:${DB_PATH:-/data/queue.db}}"

echo "[entrypoint] applying database migrations to ${DATABASE_URL}"
./node_modules/.bin/prisma migrate deploy

exec node dist/index.js
