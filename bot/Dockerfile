# --- builder: deps, prisma generate, tsc, prod-prune -------------------------
FROM node:22-bookworm-slim AS builder

# curl only lives here — used to fetch the yt-dlp binary for the final stage.
# Pick the right standalone build per arch (no python needed at runtime).
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ARG TARGETARCH
RUN case "$TARGETARCH" in \
      amd64) YTDLP_ASSET=yt-dlp_linux ;; \
      arm64) YTDLP_ASSET=yt-dlp_linux_aarch64 ;; \
      *)     echo "unsupported TARGETARCH=$TARGETARCH (standalone yt-dlp builds exist for amd64/arm64)" >&2; exit 1 ;; \
    esac \
    && curl -fL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/${YTDLP_ASSET}" \
         -o /usr/local/bin/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp

RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
# build = prisma generate + tsc; prune drops dev deps but keeps the prisma CLI
RUN pnpm build && pnpm prune --prod

# --- runtime: node + ffmpeg + the build artifacts only -----------------------
FROM node:22-bookworm-slim

# openssl: used by the Prisma CLI's schema engine (migrate deploy at startup)
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /usr/local/bin/yt-dlp /usr/local/bin/yt-dlp

ENV NODE_ENV=production
WORKDIR /app

# package.json: "type": "module" is required to run dist/ as ESM
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
# prisma CLI needs the schema + migrations + config for `migrate deploy`
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./

COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

ENTRYPOINT ["./entrypoint.sh"]
