import { Activity, Bell, Gamepad2, Globe, Network, Plus, Server, Users } from "lucide-react";
import type { AgentState, Alert, CheckReport, CheckState, ServiceCheck, Subscription } from "../../types";
import { displayName } from "../../fivem";
import { formatAgo } from "../../format";
import { DAY, hourlySlots, summarize } from "../../reports";
import { AGENT_STATUS_LABEL, CHECK_STATUS_LABEL, KIND_LABEL, agentTone, checkTone, peakDisk } from "../../status";
import { HISTORY_LENGTH } from "../../useAgents";
import { AreaChart } from "../ui/AreaChart";
import { Gauge } from "../ui/Gauge";
import { UptimeBar } from "../ui/UptimeBar";
import { Card, EmptyState, StatTile, StatusDot, StatusPill } from "../ui/common";

interface Props {
  subscriptions: Subscription[];
  getAgent: (id: string) => AgentState;
  checks: ServiceCheck[];
  getCheck: (id: string) => CheckState;
  getReport: (id: string) => CheckReport;
  alerts: Alert[];
  onOpenHost: (id: string) => void;
  onOpenMonitor: (id: string) => void;
  onOpenAlerts: () => void;
  onAddHost: () => void;
  onAddMonitor: () => void;
}

const KIND_ICON = { fivem: Gamepad2, http: Globe, tcp: Network };

function greeting() {
  const h = new Date().getHours();
  return h < 6 ? "Good night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export function OverviewPage(props: Props) {
  const { subscriptions, getAgent, checks, getCheck, getReport, alerts } = props;
  const agentStates = subscriptions.map((s) => getAgent(s.id));
  const online = agentStates.filter((s) => s.status === "online").length;
  const checkStates = checks.map((c) => getCheck(c.id));
  const up = checkStates.filter((s) => s.status === "up").length;
  const down = checkStates.filter((s) => s.status === "down").length;
  const fivemStates = checks.filter((c) => c.kind === "fivem").map((c) => getCheck(c.id));
  const players = fivemStates.reduce((sum, s) => sum + (s.status === "up" ? (s.fivem?.clients ?? 0) : 0), 0);
  const slots = fivemStates.reduce((sum, s) => sum + (s.status === "up" ? (s.fivem?.maxClients ?? 0) : 0), 0);
  const active = alerts.filter((a) => a.resolvedAt === null);
  const allGood = active.length === 0 && down === 0 && online === subscriptions.length;
  const now = Date.now();

  return (
    <div className="page">
      <header className="page-header hero">
        <div className="page-title">
          <h1>{greeting()}</h1>
          <p className="muted">
            {subscriptions.length + checks.length === 0
              ? "Add a host or a monitor to get started."
              : allGood
                ? "All systems are running normally."
                : `${active.length} active alert${active.length === 1 ? "" : "s"} · ${down} monitor${down === 1 ? "" : "s"} down · ${subscriptions.length - online} host${subscriptions.length - online === 1 ? "" : "s"} offline`}
          </p>
        </div>
        <div className="page-actions">
          <button className="button ghost" onClick={props.onAddHost}>
            <Server size={15} /> Add host
          </button>
          <button className="button primary" onClick={props.onAddMonitor}>
            <Plus size={15} /> Add monitor
          </button>
        </div>
      </header>

      <div className="stat-grid">
        <StatTile
          icon={Server}
          label="Hosts online"
          value={`${online} / ${subscriptions.length}`}
          tone={online < subscriptions.length ? "bad" : "accent"}
        />
        <StatTile
          icon={Activity}
          label="Monitors up"
          value={`${up} / ${checks.length}`}
          detail={down ? `${down} down` : undefined}
          tone={down ? "bad" : "ok"}
        />
        <StatTile
          icon={Users}
          label="Players online"
          value={fivemStates.length ? players : "–"}
          detail={fivemStates.length ? `${slots} slots on ${fivemStates.length} FiveM server${fivemStates.length === 1 ? "" : "s"}` : "no FiveM servers"}
          tone="orange"
        />
        <StatTile
          icon={Bell}
          label="Active alerts"
          value={active.length}
          detail={active[0] ? formatAgo(active[0].startedAt, now) : "all clear"}
          tone={active.length ? "warn" : "purple"}
        />
      </div>

      <section className="section">
        <h2 className="section-title">Hosts</h2>
        {subscriptions.length === 0 ? (
          <EmptyState
            icon={Server}
            title="No hosts yet"
            action={
              <button className="button primary" onClick={props.onAddHost}>
                <Plus size={15} /> Add host
              </button>
            }
          >
            Run the HostLens agent on a PC or server to see its CPU, memory, disks and network here.
          </EmptyState>
        ) : (
          <div className="tile-grid">
            {subscriptions.map((sub) => {
              const s = getAgent(sub.id);
              return (
                <button className="card host-tile" key={sub.id} onClick={() => props.onOpenHost(sub.id)}>
                  <div className="tile-head">
                    <StatusDot tone={agentTone(s)} />
                    <div className="tile-title">
                      <b className="ellipsis">{sub.name}</b>
                      <span className="mono muted ellipsis">{s.info?.osName ?? sub.url}</span>
                    </div>
                    <StatusPill tone={agentTone(s)}>{AGENT_STATUS_LABEL[s.status]}</StatusPill>
                  </div>
                  <div className="tile-gauges">
                    <Gauge size={72} value={s.metrics?.cpu?.usagePercent ?? null} label="CPU" />
                    <Gauge size={72} value={s.metrics?.memory?.usagePercent ?? null} label="RAM" />
                    <Gauge size={72} value={peakDisk(s)} label="Disk" />
                  </div>
                  <AreaChart
                    series={[{ label: "CPU", values: s.cpuHistory, color: "var(--accent)" }]}
                    length={HISTORY_LENGTH}
                    max={100}
                    format={(v) => `${Math.round(v)}%`}
                    height={56}
                  />
                </button>
              );
            })}
          </div>
        )}
      </section>

      <section className="section">
        <h2 className="section-title">Monitors</h2>
        {checks.length === 0 ? (
          <EmptyState
            icon={Gamepad2}
            title="No monitors yet"
            action={
              <button className="button primary" onClick={props.onAddMonitor}>
                <Plus size={15} /> Add monitor
              </button>
            }
          >
            Watch a FiveM server, a website or any TCP port and get told on Discord when it goes down.
          </EmptyState>
        ) : (
          <div className="tile-grid">
            {checks.map((check) => {
              const s = getCheck(check.id);
              const report = getReport(check.id);
              const day = summarize(report, DAY, now);
              const last = s.history[s.history.length - 1];
              const Icon = KIND_ICON[check.kind];
              return (
                <button className="card monitor-tile" key={check.id} onClick={() => props.onOpenMonitor(check.id)}>
                  <div className="tile-head">
                    {s.fivem?.info?.icon ? (
                      <img className="server-icon small" src={s.fivem.info.icon} alt="" />
                    ) : (
                      <span className={`kind-badge ${check.kind}`}>
                        <Icon size={16} />
                      </span>
                    )}
                    <div className="tile-title">
                      <b className="ellipsis">{check.name}</b>
                      <span className="mono muted ellipsis">
                        {KIND_LABEL[check.kind]} · {check.joinCode ? `cfx.re/join/${check.joinCode}` : check.target}
                      </span>
                    </div>
                    <StatusPill tone={checkTone(s)}>{CHECK_STATUS_LABEL[s.status]}</StatusPill>
                  </div>
                  <div className="tile-stats">
                    {check.kind === "fivem" && (
                      <span>
                        <span className="label">Players</span>
                        <b>{s.fivem ? `${s.fivem.clients}/${s.fivem.maxClients}` : "–"}</b>
                      </span>
                    )}
                    <span>
                      <span className="label">Response</span>
                      <b>{last?.latencyMs != null ? `${last.latencyMs} ms` : "–"}</b>
                    </span>
                    <span>
                      <span className="label">Uptime 24 h</span>
                      <b>{day.uptime === null ? "–" : `${day.uptime.toFixed(1)}%`}</b>
                    </span>
                  </div>
                  {s.fivem && check.kind === "fivem" && s.fivem.hostname && (
                    <span className="muted ellipsis small-text">{displayName(s.fivem)}</span>
                  )}
                  <UptimeBar slots={hourlySlots(report, 24, now)} compact />
                </button>
              );
            })}
          </div>
        )}
      </section>

      {alerts.length > 0 && (
        <Card
          title="Recent alerts"
          icon={Bell}
          actions={
            <button className="link-button" onClick={props.onOpenAlerts}>
              View all
            </button>
          }
        >
          <ul className="alert-feed">
            {alerts.slice(0, 5).map((a) => (
              <li key={a.id}>
                <StatusDot tone={a.resolvedAt === null ? "bad" : "ok"} />
                <span className="ellipsis">{a.message.replace(/^(🔴|✅)\s*/u, "")}</span>
                <span className="muted nowrap">{formatAgo(a.startedAt, now)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
