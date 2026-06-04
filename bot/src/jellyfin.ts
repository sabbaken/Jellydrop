import type { Config } from "./config.js";

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    // Strip control characters that are invalid in XML 1.0
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

function tag(name: string, value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return `  <${name}>${escapeXml(trimmed)}</${name}>`;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}

/**
 * Build a Jellyfin `movie` NFO from the yt-dlp probe JSON (spec §9.2).
 * Empty fields are omitted entirely.
 */
export function buildNfo(info: Record<string, unknown>): string {
  const lines: (string | null)[] = [];

  lines.push(tag("title", asString(info["title"])));
  lines.push(tag("plot", asString(info["description"])));
  lines.push(tag("studio", asString(info["uploader"]) ?? asString(info["channel"])));

  const uploadDate = asString(info["upload_date"]);
  const dateMatch = uploadDate?.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (dateMatch) {
    lines.push(tag("premiered", `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`));
    lines.push(tag("year", dateMatch[1]));
  }

  const duration = info["duration"];
  if (typeof duration === "number" && duration > 0) {
    lines.push(tag("runtime", String(Math.max(1, Math.round(duration / 60)))));
  }

  const tags = [...new Set([...asStringArray(info["tags"]), ...asStringArray(info["categories"])])];
  for (const t of tags) {
    lines.push(tag("tag", t));
  }

  const body = lines.filter((l): l is string => l !== null).join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>\n<movie>\n${body}\n</movie>\n`;
}

function authHeaders(apiKey: string): Record<string, string> {
  return { "X-Emby-Token": apiKey };
}

/**
 * Trigger a global library refresh (spec §9.3). Never throws: Jellyfin being
 * down must not fail the job (spec §14) — returns false and the caller logs.
 */
export async function refreshLibrary(config: Config): Promise<boolean> {
  if (!config.jellyfinApiKey) return false;
  try {
    const res = await fetch(`${config.jellyfinUrl}/Library/Refresh`, {
      method: "POST",
      headers: authHeaders(config.jellyfinApiKey),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.warn(`[jellyfin] Library/Refresh returned HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[jellyfin] Library/Refresh failed: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Optional deep link to the item card (spec §13). Best effort: the item may
 * not be indexed yet right after the refresh — try a few times, give up quietly.
 */
export async function findItemDeepLink(config: Config, title: string): Promise<string | null> {
  if (!config.jellyfinApiKey) return null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    try {
      const url = new URL(`${config.jellyfinUrl}/Items`);
      url.searchParams.set("searchTerm", title.slice(0, 100));
      url.searchParams.set("recursive", "true");
      url.searchParams.set("limit", "1");
      const res = await fetch(url, {
        headers: authHeaders(config.jellyfinApiKey),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as { Items?: { Id?: string }[] };
      const id = data.Items?.[0]?.Id;
      if (id) return `${config.jellyfinPublicUrl}/web/#/details?id=${id}`;
    } catch {
      // ignore and retry
    }
  }
  return null;
}
