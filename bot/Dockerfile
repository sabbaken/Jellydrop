FROM node:22-bookworm-slim

# openssl: used by the Prisma CLI's schema engine (migrate deploy at startup)
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg ca-certificates curl python3 openssl \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp as a standalone binary (easy to update via `yt-dlp -U`).
# Pick the right build per arch; the universal zipapp (needs python3) is the fallback.
ARG TARGETARCH
RUN case "$TARGETARCH" in \
      amd64) YTDLP_ASSET=yt-dlp_linux ;; \
      arm64) YTDLP_ASSET=yt-dlp_linux_aarch64 ;; \
      *)     YTDLP_ASSET=yt-dlp ;; \
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

COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

ENTRYPOINT ["./entrypoint.sh"]
