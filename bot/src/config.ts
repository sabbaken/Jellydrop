export interface Config {
  telegramBotToken: string;
  allowedTelegramUserId: number;
  jellyfinUrl: string;
  jellyfinApiKey: string | null;
  jellyfinPublicUrl: string;
  downloadConcurrency: number;
  dbPath: string;
  stagingDir: string;
  libraryDir: string;
  progressEditIntervalMs: number;
  cookiesFile: string | null;
  maxFilesize: string | null;
  enableAudioMode: boolean;
  enableAutoCleanup: boolean;
  cleanupAfterDays: number;
  enableJellyfinDeeplink: boolean;
  ytDlpPath: string;
}

class ConfigError extends Error {}

function str(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

function requiredStr(env: NodeJS.ProcessEnv, name: string, hint?: string): string {
  const value = str(env, name);
  if (!value) {
    throw new ConfigError(`Missing required env var ${name}${hint ? ` (${hint})` : ""}`);
  }
  return value;
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = str(env, name);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigError(`Env var ${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

function bool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = str(env, name);
  if (raw === null) return fallback;
  if (/^(true|1|yes|on)$/i.test(raw)) return true;
  if (/^(false|0|no|off)$/i.test(raw)) return false;
  throw new ConfigError(`Env var ${name} must be a boolean (true/false), got "${raw}"`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // TG_BOT_SECRET is accepted as an alias for TELEGRAM_BOT_TOKEN
  const telegramBotToken = str(env, "TELEGRAM_BOT_TOKEN") ?? str(env, "TG_BOT_SECRET");
  if (!telegramBotToken) {
    throw new ConfigError(
      "Missing required env var TELEGRAM_BOT_TOKEN (bot token from @BotFather; TG_BOT_SECRET is accepted as an alias)",
    );
  }

  const allowedRaw = requiredStr(
    env,
    "ALLOWED_TELEGRAM_USER_ID",
    "your numeric Telegram user id, ask @userinfobot",
  );
  const allowedTelegramUserId = Number.parseInt(allowedRaw, 10);
  if (!Number.isSafeInteger(allowedTelegramUserId) || allowedTelegramUserId <= 0) {
    throw new ConfigError(
      `ALLOWED_TELEGRAM_USER_ID must be a positive integer, got "${allowedRaw}"`,
    );
  }

  const jellyfinUrl = (str(env, "JELLYFIN_URL") ?? "http://jellyfin:8096").replace(/\/+$/, "");

  return {
    telegramBotToken,
    allowedTelegramUserId,
    jellyfinUrl,
    jellyfinApiKey: str(env, "JELLYFIN_API_KEY"),
    jellyfinPublicUrl: (str(env, "JELLYFIN_PUBLIC_URL") ?? jellyfinUrl).replace(/\/+$/, ""),
    downloadConcurrency: int(env, "DOWNLOAD_CONCURRENCY", 2),
    dbPath: str(env, "DB_PATH") ?? "/data/queue.db",
    stagingDir: str(env, "STAGING_DIR") ?? "/media/staging",
    libraryDir: str(env, "LIBRARY_DIR") ?? "/media/library",
    progressEditIntervalMs: int(env, "PROGRESS_EDIT_INTERVAL_MS", 3000),
    cookiesFile: str(env, "COOKIES_FILE"),
    maxFilesize: str(env, "MAX_FILESIZE"),
    enableAudioMode: bool(env, "ENABLE_AUDIO_MODE", false),
    enableAutoCleanup: bool(env, "ENABLE_AUTO_CLEANUP", false),
    cleanupAfterDays: int(env, "CLEANUP_AFTER_DAYS", 30),
    enableJellyfinDeeplink: bool(env, "ENABLE_JELLYFIN_DEEPLINK", false),
    ytDlpPath: str(env, "YTDLP_PATH") ?? "yt-dlp",
  };
}
