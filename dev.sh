#!/bin/sh
# Run the bot on the host in watch mode against dockerized Jellyfin:
#
#   docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d jellyfin
#   ./dev.sh
#
# Uses ./data for the sqlite db and ./data/media for staging/library —
# the same host dir docker-compose.dev.yml mounts into Jellyfin (read-only).
set -e
cd "$(dirname "$0")"

# token + allowed user id (+ optional JELLYFIN_API_KEY) from the real .env
set -a; . ./.env; set +a

ROOT="$(pwd)"
export JELLYFIN_URL="${JELLYFIN_URL:-http://localhost:8096}"
export DB_PATH="${DB_PATH:-$ROOT/data/dev.db}"
export STAGING_DIR="${STAGING_DIR:-$ROOT/data/media/staging}"
export LIBRARY_DIR="${LIBRARY_DIR:-$ROOT/data/media/library}"
mkdir -p "$STAGING_DIR" "$LIBRARY_DIR"

export DATABASE_URL="file:$DB_PATH"
pnpm -C bot exec prisma migrate deploy

exec pnpm -C bot dev
