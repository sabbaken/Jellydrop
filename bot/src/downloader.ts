import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { Config } from "./config.js";
import type { JobMode } from "./db.js";

const PROBE_TIMEOUT_MS = 120_000;
const SIGKILL_AFTER_MS = 10_000;
const STDERR_RING_SIZE = 30;

/** Extensions yt-dlp leaves behind for unfinished work — never move these. */
const PARTIAL_SUFFIXES = [".part", ".ytdl", ".temp"];

const MEDIA_EXTENSIONS = new Set([
  ".mkv", ".mp4", ".webm", ".mov", ".avi", ".m4v", ".ts",
  ".opus", ".m4a", ".mp3", ".flac", ".ogg", ".oga", ".wav", ".aac",
]);

export class DownloadError extends Error {}
export class PlaylistError extends Error {
  constructor() {
    super("playlist");
  }
}
export class CanceledError extends Error {
  constructor() {
    super("canceled");
  }
}

export interface ProbeResult {
  /** Full yt-dlp JSON — also the source for the .nfo. */
  raw: Record<string, unknown>;
  title: string | null;
  /** extractor_key, e.g. 'Youtube'. */
  source: string | null;
  duration: number | null;
  isPlaylist: boolean;
}

export interface ProgressUpdate {
  percent: number | null;
  speed: string | null;
  eta: string | null;
}

export interface DownloadCallbacks {
  onProgress(update: ProgressUpdate): void;
  /** Fired once when yt-dlp moves into post-processing (merge/embed). */
  onPostProcessing(): void;
}

/**
 * Live yt-dlp child processes by job id — used for cancellation. The DB is the
 * source of truth for job *state*; this registry only tracks live processes.
 */
const processes = new Map<number, ChildProcess>();

function registerProcess(jobId: number, child: ChildProcess): void {
  processes.set(jobId, child);
  child.once("close", () => {
    if (processes.get(jobId) === child) processes.delete(jobId);
  });
}

/**
 * Cancel a live download: SIGTERM, escalating to SIGKILL after a timeout.
 * Returns false when no live process exists for the job (e.g. still queued or
 * between stages) — callers handle that via the DB status.
 */
export function killJobProcess(jobId: number): boolean {
  const child = processes.get(jobId);
  if (!child || child.exitCode !== null || child.signalCode !== null) return false;
  child.kill("SIGTERM");
  const escalation = setTimeout(() => {
    if (processes.get(jobId) === child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }, SIGKILL_AFTER_MS);
  escalation.unref();
  return true;
}

/** SIGTERM every live yt-dlp process (graceful shutdown). */
export function killAllProcesses(): void {
  for (const child of processes.values()) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
}

function commonArgs(config: Config): string[] {
  const args: string[] = [];
  if (config.cookiesFile && fs.existsSync(config.cookiesFile)) {
    args.push("--cookies", config.cookiesFile);
  }
  return args;
}

/** Pull the most useful part of yt-dlp stderr into a short human message. */
export function summarizeStderr(lines: string[]): string {
  const errors = lines.filter((l) => l.includes("ERROR:"));
  const picked = (errors.length > 0 ? errors : lines).slice(-3);
  const text = picked.join("\n").trim();
  return text.length > 500 ? `${text.slice(0, 500)}…` : text || "yt-dlp failed without output";
}

/**
 * Probe metadata without downloading (spec §7.1).
 * `--flat-playlist` keeps playlist probes fast — we reject them anyway.
 */
export function probe(jobId: number, url: string, config: Config): Promise<ProbeResult> {
  const args = [
    "--dump-single-json",
    "--no-download",
    "--no-warnings",
    "--no-playlist",
    "--flat-playlist",
    ...commonArgs(config),
    "--",
    url,
  ];

  return new Promise<ProbeResult>((resolve, reject) => {
    const child = spawn(config.ytDlpPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    registerProcess(jobId, child);

    let stdout = "";
    const stderr: string[] = [];
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, PROBE_TIMEOUT_MS);
    timeout.unref();

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    readline.createInterface({ input: child.stderr }).on("line", (line) => {
      stderr.push(line);
      if (stderr.length > STDERR_RING_SIZE) stderr.shift();
    });

    child.once("error", (err) => {
      clearTimeout(timeout);
      reject(new DownloadError(`failed to launch yt-dlp: ${err.message}`));
    });

    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (timedOut) {
        return reject(new DownloadError("probe timed out"));
      }
      if (signal) {
        return reject(new CanceledError());
      }
      if (code !== 0) {
        return reject(new DownloadError(summarizeStderr(stderr)));
      }
      try {
        const raw = JSON.parse(stdout) as Record<string, unknown>;
        const isPlaylist =
          raw["_type"] === "playlist" ||
          raw["_type"] === "multi_video" ||
          Array.isArray(raw["entries"]);
        resolve({
          raw,
          title: typeof raw["title"] === "string" ? raw["title"] : null,
          source: typeof raw["extractor_key"] === "string" ? raw["extractor_key"] : null,
          duration: typeof raw["duration"] === "number" ? raw["duration"] : null,
          isPlaylist,
        });
      } catch {
        reject(new DownloadError("could not parse yt-dlp metadata JSON"));
      }
    });
  });
}

const PROGRESS_PREFIX = "DLPROG|";
const PROGRESS_TEMPLATE =
  "DLPROG|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s";

/** Lines that signal yt-dlp post-processing (merge, embed, extract). */
const POSTPROCESS_RE =
  /^\[(Merger|ExtractAudio|VideoConvertor|VideoRemuxer|Metadata|EmbedThumbnail|EmbedSubtitle|SplitChapters|ThumbnailsConvertor|Fixup\w*)\]/;

function parseProgressLine(line: string): ProgressUpdate | null {
  if (!line.startsWith(PROGRESS_PREFIX)) return null;
  const [, rawPercent = "", rawSpeed = "", rawEta = ""] = line.split("|");
  const percentMatch = rawPercent.match(/([\d.]+)\s*%/);
  const speed = rawSpeed.trim();
  const eta = rawEta.trim();
  return {
    percent: percentMatch ? Number.parseFloat(percentMatch[1]!) : null,
    speed: speed && speed !== "Unknown" && !speed.startsWith("NA") ? speed : null,
    eta: eta && eta !== "Unknown" && !eta.startsWith("NA") ? eta : null,
  };
}

function downloadArgs(mode: JobMode, jobDir: string, config: Config): string[] {
  const output = path.join(jobDir, "%(title)s [%(id)s].%(ext)s");
  const args: string[] =
    mode === "audio"
      ? ["-f", "ba/b", "-x", "--audio-format", "opus", "--embed-metadata", "--embed-thumbnail"]
      : [
          "-f", "bv*+ba/b",
          "--merge-output-format", "mkv",
          "--embed-metadata",
          "--embed-thumbnail",
          "--embed-chapters",
          "--embed-subs",
        ];

  args.push(
    "--restrict-filenames",
    "--no-playlist",
    "--continue",
    // mtime must be the download time, not the remote upload date — the
    // optional auto-cleanup sweeps by mtime (cleanup.ts).
    "--no-mtime",
    "--newline",
    "--progress-template", PROGRESS_TEMPLATE,
    "-o", output,
    ...commonArgs(config),
  );
  if (config.maxFilesize) args.push("--max-filesize", config.maxFilesize);
  return args;
}

/**
 * Download into the job's staging dir (spec §7.2). Resolves on success,
 * rejects with CanceledError when the process was killed, or DownloadError
 * with a stderr summary otherwise.
 */
export function download(
  jobId: number,
  url: string,
  mode: JobMode,
  jobDir: string,
  config: Config,
  callbacks: DownloadCallbacks,
): Promise<void> {
  const args = [...downloadArgs(mode, jobDir, config), "--", url];

  return new Promise<void>((resolve, reject) => {
    const child = spawn(config.ytDlpPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    registerProcess(jobId, child);

    const stderr: string[] = [];
    let sawMaxFilesizeSkip = false;
    let postProcessing = false;

    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      const progress = parseProgressLine(line);
      if (progress) {
        callbacks.onProgress(progress);
        return;
      }
      if (line.includes("larger than max-filesize")) sawMaxFilesizeSkip = true;
      if (!postProcessing && POSTPROCESS_RE.test(line)) {
        postProcessing = true;
        callbacks.onPostProcessing();
      }
    });

    readline.createInterface({ input: child.stderr }).on("line", (line) => {
      stderr.push(line);
      if (stderr.length > STDERR_RING_SIZE) stderr.shift();
      if (line.includes("larger than max-filesize")) sawMaxFilesizeSkip = true;
    });

    child.once("error", (err) => {
      reject(new DownloadError(`failed to launch yt-dlp: ${err.message}`));
    });

    child.once("close", (code, signal) => {
      if (signal) return reject(new CanceledError());
      if (code !== 0) return reject(new DownloadError(summarizeStderr(stderr)));
      if (sawMaxFilesizeSkip && !findOutputFiles(jobDir).media) {
        return reject(
          new DownloadError(`file exceeds the MAX_FILESIZE limit (${config.maxFilesize})`),
        );
      }
      resolve();
    });
  });
}

export interface OutputFiles {
  /** The main media file, or null when nothing finished downloading. */
  media: string | null;
  /** Sidecars to move alongside the media file (thumbnails, subs, ...). */
  sidecars: string[];
}

function isPartialFile(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.startsWith(".") ||
    PARTIAL_SUFFIXES.some((s) => lower.endsWith(s)) ||
    /\.part-frag\d+/i.test(lower) ||
    /\.f\d+\.\w+$/i.test(lower) // intermediate format files before merge
  );
}

/**
 * After yt-dlp exits 0, locate the finished media file and its sidecars in
 * the per-job staging dir. The media file is the largest completed file with
 * a known media extension.
 */
export function findOutputFiles(jobDir: string): OutputFiles {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(jobDir, { withFileTypes: true });
  } catch {
    return { media: null, sidecars: [] };
  }

  const completed = entries
    .filter((e) => e.isFile() && !isPartialFile(e.name))
    .map((e) => {
      const filePath = path.join(jobDir, e.name);
      return { filePath, size: fs.statSync(filePath).size, ext: path.extname(e.name).toLowerCase() };
    });

  const mediaCandidates = completed
    .filter((f) => MEDIA_EXTENSIONS.has(f.ext))
    .sort((a, b) => b.size - a.size);

  const media = mediaCandidates[0]?.filePath ?? null;
  const sidecars = completed.map((f) => f.filePath).filter((p) => p !== media);
  return { media, sidecars };
}
