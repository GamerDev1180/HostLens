export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${Math.floor(seconds % 60)}s`;
}

/** Compact duration: "45s", "5m 12s", "2h 3m", "3d 4h". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

/** "just now", "5m ago", "2h ago", or a date. */
export function formatAgo(at: number, now = Date.now()): string {
  const s = Math.round((now - at) / 1000);
  if (s < 10) return "just now";
  if (s < 3600 * 24) return `${formatDuration(s * 1000).split(" ")[0]} ago`;
  return new Date(at).toLocaleDateString();
}

export const formatPercent = (value: number | null | undefined) =>
  value === null || value === undefined ? "–" : `${value.toFixed(1)}%`;

export const formatRate = (bytesPerSec: number | null | undefined) =>
  bytesPerSec === null || bytesPerSec === undefined ? "–" : `${formatBytes(bytesPerSec)}/s`;
