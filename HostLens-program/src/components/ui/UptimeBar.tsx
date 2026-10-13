import { bucketUptime, HOUR } from "../../reports";
import type { HourBucket } from "../../types";

interface Props {
  /** Oldest first; `null` = not monitored in that hour. */
  slots: (HourBucket | null)[];
  compact?: boolean;
}

function slotClass(b: HourBucket | null) {
  const up = b ? bucketUptime(b) : null;
  if (up === null) return "empty";
  if (up >= 99.9) return "ok";
  if (up >= 95) return "warn";
  return "bad";
}

function slotTitle(b: HourBucket | null) {
  if (!b) return "Not monitored";
  const from = new Date(b.hour);
  const to = new Date(b.hour + HOUR);
  const time = (d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const lines = [
    `${from.toLocaleDateString()} ${time(from)}–${time(to)}`,
    `Uptime ${bucketUptime(b)?.toFixed(2)}% (${b.up + b.down} checks)`,
    b.latencyCount ? `Avg response ${Math.round(b.latencySum / b.latencyCount)} ms` : null,
    b.peakPlayers !== undefined ? `Peak players ${b.peakPlayers}` : null,
  ];
  return lines.filter(Boolean).join("\n");
}

// Status-page style strip: one bar per hour, coloured by uptime.
export function UptimeBar({ slots, compact }: Props) {
  return (
    <div className={`uptime-bar ${compact ? "compact" : ""}`} role="img" aria-label="Uptime per hour">
      {slots.map((b, i) => (
        <span key={i} className={slotClass(b)} title={slotTitle(b)} />
      ))}
    </div>
  );
}
