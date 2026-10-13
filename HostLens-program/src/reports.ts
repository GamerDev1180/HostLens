import type { CheckReport, CheckResult, HourBucket, Incident, ServiceCheck } from "./types";
import { formatDuration } from "./format";

// Pure helpers behind monitor reports: results are folded into hourly buckets
// (uptime, response time, peak players) and outages into incidents. Both are
// small enough to keep in localStorage for a week.

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
const KEEP_HOURS = 7 * 24;
const KEEP_INCIDENTS = 100;
/** Longer than the slowest check interval (5 min) plus slack. */
const MAX_RESULT_GAP = 10 * 60_000;

export const emptyReport = (): CheckReport => ({ buckets: [], incidents: [], lastResultAt: null });

/** Folds one check result into the report. */
export function recordResult(report: CheckReport, result: CheckResult, cause: string): CheckReport {
  const hour = Math.floor(result.at / HOUR) * HOUR;
  const buckets = report.buckets.slice();
  let bucket = buckets[buckets.length - 1];
  if (!bucket || bucket.hour !== hour) {
    bucket = { hour, up: 0, down: 0, latencySum: 0, latencyCount: 0 };
    buckets.push(bucket);
  } else {
    bucket = { ...bucket };
    buckets[buckets.length - 1] = bucket;
  }
  if (result.ok) bucket.up++;
  else bucket.down++;
  if (result.ok && result.latencyMs !== null) {
    bucket.latencySum += result.latencyMs;
    bucket.latencyCount++;
  }
  if (result.players !== undefined) bucket.peakPlayers = Math.max(bucket.peakPlayers ?? 0, result.players);

  let incidents = report.incidents;
  const open = incidents[0]?.endedAt === null ? incidents[0] : undefined;
  if (!result.ok && !open) {
    incidents = [{ id: crypto.randomUUID(), startedAt: result.at, endedAt: null, cause }, ...incidents];
  } else if (result.ok && open) {
    // A long gap since the last result means the app was closed: the outage
    // ended somewhere in that gap, so the end time is only an upper bound.
    const gap = report.lastResultAt === null ? 0 : result.at - report.lastResultAt;
    incidents = [
      { ...open, endedAt: result.at, ...(gap > MAX_RESULT_GAP ? { approximate: true } : {}) },
      ...incidents.slice(1),
    ];
  }

  return {
    buckets: buckets.filter((b) => b.hour > result.at - KEEP_HOURS * HOUR),
    incidents: incidents.slice(0, KEEP_INCIDENTS),
    lastResultAt: result.at,
  };
}

export interface ReportSummary {
  /** Percentage of successful checks in the window; `null` without data. */
  uptime: number | null;
  avgLatencyMs: number | null;
  checks: number;
  incidents: Incident[];
  downtimeMs: number;
  longestOutageMs: number;
  peakPlayers: number | null;
}

/** Summary over the last `windowMs`. */
export function summarize(report: CheckReport, windowMs: number, now = Date.now()): ReportSummary {
  const from = now - windowMs;
  const buckets = report.buckets.filter((b) => b.hour + HOUR > from);
  const up = buckets.reduce((s, b) => s + b.up, 0);
  const down = buckets.reduce((s, b) => s + b.down, 0);
  const latencyCount = buckets.reduce((s, b) => s + b.latencyCount, 0);
  const peaks = buckets.map((b) => b.peakPlayers).filter((p): p is number => p !== undefined);
  const incidents = report.incidents.filter((i) => (i.endedAt ?? now) > from);
  const durations = incidents.map((i) => (i.endedAt ?? now) - Math.max(i.startedAt, from));
  return {
    uptime: up + down > 0 ? (up / (up + down)) * 100 : null,
    avgLatencyMs: latencyCount ? buckets.reduce((s, b) => s + b.latencySum, 0) / latencyCount : null,
    checks: up + down,
    incidents,
    downtimeMs: durations.reduce((s, d) => s + d, 0),
    longestOutageMs: Math.max(0, ...durations),
    peakPlayers: peaks.length ? Math.max(...peaks) : null,
  };
}

/** One slot per hour for the last `hours` hours, oldest first; `null` where nothing was checked. */
export function hourlySlots(report: CheckReport, hours: number, now = Date.now()): (HourBucket | null)[] {
  const current = Math.floor(now / HOUR) * HOUR;
  const byHour = new Map(report.buckets.map((b) => [b.hour, b]));
  return Array.from({ length: hours }, (_, i) => byHour.get(current - (hours - 1 - i) * HOUR) ?? null);
}

export const bucketUptime = (b: HourBucket) => (b.up + b.down ? (b.up / (b.up + b.down)) * 100 : null);

/** Plain-text report for Discord. */
export function reportText(check: ServiceCheck, report: CheckReport, now = Date.now()): string {
  const day = summarize(report, DAY, now);
  const week = summarize(report, 7 * DAY, now);
  const pct = (v: number | null) => (v === null ? "no data" : `${v.toFixed(2)}%`);
  const lines = [
    `📊 **HostLens report: ${check.name}**`,
    `\`${check.joinCode ? `cfx.re/join/${check.joinCode}` : check.target}\``,
    `Uptime: **${pct(day.uptime)}** (24 h) · ${pct(week.uptime)} (7 d)`,
    day.avgLatencyMs !== null ? `Avg response: ${Math.round(day.avgLatencyMs)} ms (24 h)` : null,
    day.peakPlayers !== null ? `Peak players: ${day.peakPlayers} (24 h)` : null,
    `Outages (24 h): ${day.incidents.length}${day.incidents.length ? `, ${formatDuration(day.downtimeMs)} down in total, longest ${formatDuration(day.longestOutageMs)}` : ""}`,
    ...day.incidents.slice(0, 5).map(
      (i) =>
        `• ${new Date(i.startedAt).toLocaleString()} for ${formatDuration((i.endedAt ?? now) - i.startedAt)}${i.endedAt === null ? " (ongoing)" : ""}: ${i.cause}`,
    ),
  ];
  return lines.filter((l) => l !== null).join("\n");
}
