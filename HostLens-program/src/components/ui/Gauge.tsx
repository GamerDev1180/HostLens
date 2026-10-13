import type { ReactNode } from "react";

interface Props {
  /** 0–100; `null` shows an empty ring. */
  value: number | null;
  /** Replaces the percentage in the centre, e.g. a player count. */
  centerText?: ReactNode;
  label: string;
  /** Small text under the label, e.g. "6.2 / 16 GB". */
  detail?: string;
  size?: number;
  /** Override the threshold colour (green < 70 ≤ amber < 90 ≤ red). */
  color?: string;
}

const SWEEP = 0.75; // a 270° arc, open at the bottom

export const levelColor = (value: number | null) =>
  value === null ? "var(--text-3)" : value >= 90 ? "var(--danger)" : value >= 70 ? "var(--warning)" : "var(--success)";

export function Gauge({ value, centerText, label, detail, size = 112, color }: Props) {
  const stroke = Math.max(6, size * 0.085);
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const arc = circumference * SWEEP;
  const filled = value === null ? 0 : (Math.min(100, Math.max(0, value)) / 100) * arc;
  const tint = color ?? levelColor(value);

  return (
    <div className="gauge" style={{ width: size }}>
      <div className="gauge-ring" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
          <g transform={`rotate(135 ${size / 2} ${size / 2})`}>
            <circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke="var(--track)"
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={`${arc} ${circumference}`}
            />
            <circle
              className="gauge-value-arc"
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={tint}
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={`${filled} ${circumference}`}
              style={{ filter: value !== null ? `drop-shadow(0 0 6px ${tint})` : undefined }}
            />
          </g>
        </svg>
        <span className="gauge-value" style={{ fontSize: size * 0.2 }}>
          {centerText ?? (
            <>
              {value === null ? "–" : Math.round(value)}
              {value !== null && <small>%</small>}
            </>
          )}
        </span>
      </div>
      <span className="gauge-label">{label}</span>
      {detail && <span className="gauge-detail">{detail}</span>}
    </div>
  );
}
