/** Minimal shape of a Telegram message entity we care about. */
export interface MessageEntityLike {
  type: string;
  offset: number;
  length: number;
  url?: string;
}

const URL_RE = /https?:\/\/[^\s<>"'`«»]+/gi;

/** Characters that are usually message punctuation, not part of the URL. */
const TRAILING_PUNCTUATION = /[).,!?;:'"\]»…]+$/;

function cleanUrl(raw: string): string | null {
  let url = raw.replace(TRAILING_PUNCTUATION, "");
  // Keep a single trailing ')' if the URL actually contains a matching '(' —
  // e.g. wikipedia article titles.
  if (raw.endsWith(")") && (url.match(/\(/g)?.length ?? 0) > (url.match(/\)/g)?.length ?? 0)) {
    url += ")";
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * Extract all http(s) URLs from message text plus `text_link` entities
 * (hyperlinked text whose URL is not present in the plain text).
 * Returns unique URLs in order of appearance.
 */
export function extractUrls(text?: string, entities?: MessageEntityLike[]): string[] {
  const found: string[] = [];

  for (const match of (text ?? "").matchAll(URL_RE)) {
    const url = cleanUrl(match[0]);
    if (url) found.push(url);
  }

  for (const entity of entities ?? []) {
    if (entity.type === "text_link" && entity.url) {
      const url = cleanUrl(entity.url);
      if (url) found.push(url);
    }
  }

  return [...new Set(found)];
}
