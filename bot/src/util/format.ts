const BAR_WIDTH = 8;

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/** `52` -> `▓▓▓▓░░░░` */
export function progressBar(percent: number, width = BAR_WIDTH): string {
  const filled = Math.round((clampPercent(percent) / 100) * width);
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

export function truncate(text: string, max = 100): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Escape text for Telegram HTML parse mode. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
