import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

export type Tone = "ok" | "bad" | "warn" | "idle";

/** Coloured dot; glows when ok/bad. */
export const StatusDot = ({ tone }: { tone: Tone }) => <span className={`dot ${tone}`} />;

export function StatusPill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`pill ${tone}`}>
      <StatusDot tone={tone} />
      {children}
    </span>
  );
}

export function StatTile({
  icon: Icon,
  label,
  value,
  detail,
  tone = "accent",
}: {
  icon: LucideIcon;
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  tone?: "accent" | "ok" | "bad" | "warn" | "purple" | "orange" | "teal";
}) {
  return (
    <div className="card stat-tile">
      <span className={`stat-icon ${tone}`}>
        <Icon size={18} />
      </span>
      <div className="stat-text">
        <span className="label">{label}</span>
        <span className="stat-value">{value}</span>
        {detail && <span className="stat-detail">{detail}</span>}
      </div>
    </div>
  );
}

export function Card({
  title,
  icon: Icon,
  actions,
  children,
  className = "",
}: {
  title?: string;
  icon?: LucideIcon;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-header">
          {title && (
            <span className="label">
              {Icon && <Icon size={14} />}
              {title}
            </span>
          )}
          {actions && <span className="card-actions">{actions}</span>}
        </header>
      )}
      {children}
    </section>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
}: {
  icon: LucideIcon;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon size={26} />
      </span>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

/** Thin horizontal usage bar. */
export function Meter({ value, color }: { value: number | null; color?: string }) {
  const v = value === null ? 0 : Math.min(100, Math.max(0, value));
  return (
    <span className="meter">
      <span style={{ width: `${v}%`, background: color }} />
    </span>
  );
}
