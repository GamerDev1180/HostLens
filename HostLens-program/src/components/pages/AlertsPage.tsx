import { Bell, BellOff, Check, CircleCheck, History, Settings, TriangleAlert } from "lucide-react";
import type { Alert } from "../../types";
import { formatAgo, formatDuration } from "../../format";
import { RULE_LABELS } from "../../useAlerts";
import { Card, EmptyState } from "../ui/common";

interface Props {
  alerts: Alert[];
  webhookConfigured: boolean;
  onAcknowledge: (id: string) => void;
  onClearResolved: () => void;
  onOpenSettings: () => void;
}

function AlertRow({ alert, onAcknowledge }: { alert: Alert; onAcknowledge?: () => void }) {
  const active = alert.resolvedAt === null;
  const now = Date.now();
  return (
    <li className={`alert-row ${active ? "active" : "resolved"} ${alert.acknowledged ? "acknowledged" : ""}`}>
      <span className="alert-icon">{active ? <TriangleAlert size={16} /> : <CircleCheck size={16} />}</span>
      <div className="alert-text">
        <span>{alert.message.replace(/^(🔴|✅)\s*/u, "")}</span>
        <span className="muted">
          {RULE_LABELS[alert.kind]} · {new Date(alert.startedAt).toLocaleString()} ·{" "}
          {active
            ? `ongoing for ${formatDuration(now - alert.startedAt)}`
            : `resolved after ${formatDuration(alert.resolvedAt! - alert.startedAt)}`}
          {alert.acknowledged && active && " · acknowledged"}
        </span>
      </div>
      <span className="muted nowrap">{formatAgo(alert.startedAt, now)}</span>
      {onAcknowledge && !alert.acknowledged && (
        <button className="button ghost small" onClick={onAcknowledge}>
          <Check size={14} /> Acknowledge
        </button>
      )}
    </li>
  );
}

export function AlertsPage({ alerts, webhookConfigured, onAcknowledge, onClearResolved, onOpenSettings }: Props) {
  const active = alerts.filter((a) => a.resolvedAt === null);
  const past = alerts.filter((a) => a.resolvedAt !== null);

  return (
    <div className="page">
      <header className="page-header">
        <div className="page-title">
          <h1>Alerts</h1>
          <p className="muted">Fired when a rule's condition holds for its set time, and resolved automatically.</p>
        </div>
        <div className="page-actions">
          <button className="button ghost" onClick={onOpenSettings}>
            <Settings size={15} /> Rules & Discord
          </button>
        </div>
      </header>

      {!webhookConfigured && (
        <div className="banner info">
          <BellOff size={18} />
          <span>
            Alerts only show up here.{" "}
            <button className="link-button" onClick={onOpenSettings}>
              Add a Discord webhook
            </button>{" "}
            to be notified when something goes down.
          </span>
        </div>
      )}

      <Card title={`Active (${active.length})`} icon={Bell}>
        {active.length === 0 ? (
          <EmptyState icon={CircleCheck} title="All clear">
            Nothing needs your attention right now.
          </EmptyState>
        ) : (
          <ul className="alert-list">
            {active.map((a) => (
              <AlertRow key={a.id} alert={a} onAcknowledge={() => onAcknowledge(a.id)} />
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="History"
        icon={History}
        actions={
          past.length > 0 && (
            <button className="link-button" onClick={onClearResolved}>
              Clear history
            </button>
          )
        }
      >
        {past.length === 0 ? (
          <p className="muted">No resolved alerts yet.</p>
        ) : (
          <ul className="alert-list">
            {past.map((a) => (
              <AlertRow key={a.id} alert={a} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
