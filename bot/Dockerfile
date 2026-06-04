FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg ca-certificates curl python3 \
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

COPY tsconfig.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

CMD ["node", "dist/index.js"]
