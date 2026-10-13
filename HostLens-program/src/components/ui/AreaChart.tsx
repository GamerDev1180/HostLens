import { useId, useRef, useState, type PointerEvent } from "react";

export interface Series {
  label: string;
  values: number[];
  /** CSS color, e.g. "var(--accent)". */
  color: string;
}

interface Props {
  series: Series[];
  /** Shown instead of the plot while there are fewer than two points. */
  emptyText?: string;
  /** Number of slots on the x axis; series shorter than this are right-aligned (newest on the right). */
  length: number;
  /** Top of the y axis. Defaults to the data maximum plus headroom. */
  max?: number;
  format: (value: number) => string;
  /** Left and right x-axis captions, e.g. ["60 s ago", "now"]. */
  xLabels?: [string, string];
  /** Caption for the hovered slot, from its distance to the newest slot. */
  slotLabel?: (fromEnd: number) => string;
  height?: number;
}

// Area chart with gradient fills, y-axis gridlines and a hover crosshair. The
// SVG stretches to fit (preserveAspectRatio="none"), so labels, dots and the
// tooltip are HTML positioned in percentages on top of it.
export function AreaChart({ series, emptyText = "Collecting data…", length, max, format, xLabels, slotLabel, height = 160 }: Props) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const dataMax = Math.max(0, ...series.flatMap((s) => s.values));
  const top = max ?? (dataMax > 0 ? dataMax * 1.2 : 1);
  const last = length - 1;
  const x = (i: number) => (last > 0 ? (i / last) * 100 : 0);
  const y = (v: number) => 100 - Math.min(100, Math.max(0, (v / top) * 100));
  const offsetOf = (s: Series) => length - s.values.length;

  function onMove(e: PointerEvent<HTMLDivElement>) {
    const rect = box.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    setHover(Math.round(ratio * last));
  }

  const hovered =
    hover === null
      ? []
      : series
          .map((s) => ({ s, value: s.values[hover - offsetOf(s)] }))
          .filter((h): h is { s: Series; value: number } => h.value !== undefined);

  if (series.every((s) => s.values.length < 2)) {
    return (
      <div className="chart">
        <div className="chart-empty" style={{ height }}>
          {emptyText}
        </div>
      </div>
    );
  }

  return (
    <div className="chart">
      <div className="chart-plot" style={{ height }}>
        <div className="chart-y">
          {[1, 0.5, 0].map((f) => (
            <span key={f} style={{ top: `${(1 - f) * 100}%` }}>
              {format(top * f)}
            </span>
          ))}
        </div>
        <div
          className="chart-area"
          ref={box}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <defs>
              {series.map((s, i) => (
                <linearGradient key={i} id={`${id}-${i}`} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor={s.color} stopOpacity={0.32} />
                  <stop offset="100%" stopColor={s.color} stopOpacity={0} />
                </linearGradient>
              ))}
            </defs>
            {[0, 25, 50, 75, 100].map((g) => (
              <line key={g} x1={0} x2={100} y1={g} y2={g} className="chart-grid" />
            ))}
            {series.map((s, i) => {
              if (s.values.length < 2) return null;
              const off = offsetOf(s);
              const points = s.values.map((v, j) => `${x(off + j)},${y(v)}`).join(" ");
              return (
                <g key={i}>
                  <polygon points={`${x(off)},100 ${points} ${x(last)},100`} fill={`url(#${id}-${i})`} />
                  <polyline
                    points={points}
                    fill="none"
                    stroke={s.color}
                    strokeWidth={2}
                    vectorEffect="non-scaling-stroke"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                </g>
              );
            })}
          </svg>
          {hover !== null && hovered.length > 0 && (
            <>
              <div className="chart-cursor" style={{ left: `${x(hover)}%` }} />
              {hovered.map(({ s, value }) => (
                <span
                  key={s.label}
                  className="chart-dot"
                  style={{ left: `${x(hover)}%`, top: `${y(value)}%`, background: s.color }}
                />
              ))}
              <div
                className={`chart-tooltip ${x(hover) > 60 ? "left" : ""}`}
                style={{ left: `${x(hover)}%` }}
              >
                {slotLabel && <span className="chart-tooltip-title">{slotLabel(last - hover)}</span>}
                {hovered.map(({ s, value }) => (
                  <span key={s.label} className="chart-tooltip-row">
                    <i style={{ background: s.color }} />
                    {s.label}
                    <b>{format(value)}</b>
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
      {(xLabels || series.length > 1) && (
        <div className="chart-footer">
          {xLabels && <span>{xLabels[0]}</span>}
          {series.length > 1 && (
            <span className="chart-legend">
              {series.map((s) => (
                <span key={s.label}>
                  <i style={{ background: s.color }} />
                  {s.label}
                </span>
              ))}
            </span>
          )}
          {xLabels && <span>{xLabels[1]}</span>}
        </div>
      )}
    </div>
  );
}
