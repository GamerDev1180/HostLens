import { useState } from "react";
import {
  ArrowLeft,
  CalendarClock,
  Gamepad2,
  Globe,
  History,
  Network,
  RefreshCw,
  Search,
  Send,
  Timer,
  Trash2,
  TrendingUp,
  TriangleAlert,
  Users,
} from "lucide-react";
import type { CheckReport, CheckState, ServiceCheck } from "../../types";
import { displayName } from "../../fivem";
import { formatAgo, formatDuration } from "../../format";
import { DAY, hourlySlots, reportText, summarize } from "../../reports";
import { CHECK_STATUS_LABEL, KIND_LABEL, checkTone } from "../../status";
import { AreaChart } from "../ui/AreaChart";
import { Gauge } from "../ui/Gauge";
import { UptimeBar } from "../ui/UptimeBar";
import { useNarrow } from "../../useNarrow";
import { Card, StatTile, StatusPill } from "../ui/common";

interface Props {
  check: ServiceCheck;
  state: CheckState;
  report: CheckReport;
  onRunNow: () => void;
  onRemove: () => void;
  onSendReport: (text: string) => Promise<unknown>;
  onBack: () => void;
}

const KIND_ICON = { fivem: Gamepad2, http: Globe, tcp: Network };
const pct = (v: number | null) => (v === null ? "–" : `${v.toFixed(v === 100 ? 0 : 2)}%`);

function FiveMPanel({ state }: { state: CheckState }) {
  const fivem = state.fivem!;
  const [query, setQuery] = useState("");
  const info = fivem.info;
  const fill = fivem.maxClients ? (fivem.clients / fivem.maxClients) * 100 : null;
  const players = (fivem.players ?? [])
    .filter((p) => p.name.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => a.id - b.id);

  return (
    <>
      <div className="card fivem-hero">
        <div className="fivem-identity">
          {info?.icon ? (
            <img className="server-icon" src={info.icon} alt="" />
          ) : (
            <span className="server-icon placeholder">
              <Gamepad2 size={28} />
            </span>
          )}
          <div className="fivem-text">
            <h2>{displayName(fivem)}</h2>
            {info?.projectName && fivem.hostname !== info.projectName && <p className="muted">{fivem.hostname}</p>}
            {info?.projectDesc && <p>{info.projectDesc}</p>}
            <div className="tag-row">
              {fivem.gametype && <span className="tag accent">{fivem.gametype}</span>}
              {fivem.mapname && <span className="tag">{fivem.mapname}</span>}
              {info?.tags.map((t) => (
                <span className="tag" key={t}>
                  {t}
                </span>
              ))}
            </div>
          </div>
        </div>
        <div className="fivem-players">
          <Gauge
            value={fill}
            size={128}
            label="Players"
            centerText={
              <>
                {fivem.clients}
                <small>/{fivem.maxClients}</small>
              </>
            }
            detail={fill === null ? undefined : `${Math.round(fill)}% full`}
            color="var(--orange)"
          />
        </div>
        {info && (
          <dl className="facts fivem-facts">
            <dt>Server build</dt>
            <dd className="mono">{info.build ?? info.server ?? "–"}</dd>
            <dt>Game build</dt>
            <dd className="mono">{info.gameBuild ?? "–"}</dd>
            <dt>Resources</dt>
            <dd>{info.resources ?? "–"}</dd>
            <dt>OneSync</dt>
            <dd>{info.onesync === null ? "–" : info.onesync ? "Enabled" : "Off"}</dd>
            {info.locale && (
              <>
                <dt>Locale</dt>
                <dd>{info.locale}</dd>
              </>
            )}
            {info.txAdminVersion && (
              <>
                <dt>txAdmin</dt>
                <dd>v{info.txAdminVersion}</dd>
              </>
            )}
          </dl>
        )}
      </div>

      <div className="grid-2">
        <Card title="Players online" icon={TrendingUp}>
          <AreaChart
            series={[
              {
                label: "Players",
                values: state.history.filter((r) => r.players !== undefined).map((r) => r.players!),
                color: "var(--orange)",
              },
            ]}
            length={60}
            max={Math.max(fivem.maxClients, 1)}
            format={(v) => String(Math.round(v))}
            xLabels={["last 60 checks", "now"]}
            slotLabel={(n) => (n === 0 ? "latest check" : `${n} checks ago`)}
          />
        </Card>
        <Card
          title={`Players (${fivem.players?.length ?? fivem.clients})`}
          icon={Users}
          actions={
            fivem.players && !fivem.playersAnonymized && fivem.players.length > 8 ? (
              <label className="search small">
                <Search size={13} />
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find player" />
              </label>
            ) : undefined
          }
        >
          {fivem.players === null ? (
            <p className="muted">This server doesn't publish its player list.</p>
          ) : fivem.playersAnonymized ? (
            <p className="muted">
              The server hides player names and IDs (its <code>players.json</code> is anonymized), so only the count
              is available.
            </p>
          ) : fivem.players.length === 0 ? (
            <p className="muted">Nobody is online.</p>
          ) : (
            <div className="player-list">
              <table className="table">
                <thead>
                  <tr>
                    <th className="num">ID</th>
                    <th>Name</th>
                    <th className="num">Ping</th>
                  </tr>
                </thead>
                <tbody>
                  {players.map((p, i) => (
                    <tr key={`${p.id}-${i}`}>
                      <td className="num mono muted">{p.id}</td>
                      <td className="ellipsis">{p.name}</td>
                      <td className={`num mono ${p.ping > 150 ? "warn-text" : ""}`}>{p.ping} ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

export function MonitorDetail({ check, state, report, onRunNow, onRemove, onSendReport, onBack }: Props) {
  const [sending, setSending] = useState<"idle" | "sending" | "sent" | string>("idle");
  // 168 hourly bars don't fit on a phone; show the last two days there.
  const stripHours = useNarrow() ? 48 : 7 * 24;
  const now = Date.now();
  const day = summarize(report, DAY, now);
  const week = summarize(report, 7 * DAY, now);
  const last = state.history[state.history.length - 1];
  const Icon = KIND_ICON[check.kind];
  const latencies = state.history.filter((r) => r.ok && r.latencyMs !== null).map((r) => r.latencyMs!);
  const address = check.joinCode ? `cfx.re/join/${check.joinCode} → ${check.target}` : check.target;

  async function sendReport() {
    setSending("sending");
    try {
      await onSendReport(reportText(check, report));
      setSending("sent");
    } catch (e) {
      setSending(String(e));
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <button className="icon-button back-button" onClick={onBack} aria-label="Back">
          <ArrowLeft size={18} />
        </button>
        <span className={`kind-badge large ${check.kind}`}>
          <Icon size={20} />
        </span>
        <div className="page-title">
          <h1>{check.name}</h1>
          <p className="mono muted ellipsis" title={address}>
            {KIND_LABEL[check.kind]} · {address} · every {check.intervalSeconds < 60 ? `${check.intervalSeconds}s` : `${check.intervalSeconds / 60} min`}
          </p>
        </div>
        <div className="page-actions">
          <StatusPill tone={checkTone(state)}>
            {CHECK_STATUS_LABEL[state.status]}
            {state.status === "down" && state.downSince && ` · ${formatDuration(now - state.downSince)}`}
          </StatusPill>
          <button className="icon-button" onClick={onRunNow} title="Check now" aria-label="Check now">
            <RefreshCw size={17} />
          </button>
          <button className="button ghost" onClick={sendReport} disabled={sending === "sending"} title="Post a report to Discord">
            <Send size={15} /> {sending === "sending" ? "Sending…" : sending === "sent" ? "Report sent" : "Report"}
          </button>
          <button className="icon-button danger" onClick={onRemove} title="Remove monitor" aria-label="Remove monitor">
            <Trash2 size={17} />
          </button>
        </div>
      </header>

      {!["idle", "sending", "sent"].includes(sending) && (
        <div className="banner danger">
          <TriangleAlert size={18} />
          <span>Couldn't send the report: {sending}</span>
        </div>
      )}

      {state.status === "down" && last && (
        <div className="banner danger">
          <TriangleAlert size={18} />
          <div>
            <b>{check.kind === "fivem" ? "Server is down" : "Monitor is failing"}</b>
            <span className="muted"> · {last.detail}</span>
            {state.fivem && <span className="muted"> · showing the last data received</span>}
          </div>
        </div>
      )}

      <div className="stat-grid">
        <StatTile icon={TrendingUp} label="Uptime 24 h" value={pct(day.uptime)} detail={`${day.checks} checks`} tone="ok" />
        <StatTile icon={CalendarClock} label="Uptime 7 days" value={pct(week.uptime)} detail={`${week.checks} checks`} tone="accent" />
        <StatTile
          icon={Timer}
          label="Response"
          value={last?.latencyMs != null ? `${last.latencyMs} ms` : "–"}
          detail={day.avgLatencyMs !== null ? `avg ${Math.round(day.avgLatencyMs)} ms (24 h)` : undefined}
          tone="teal"
        />
        <StatTile
          icon={History}
          label="Outages 24 h"
          value={day.incidents.length}
          detail={day.incidents.length ? `${formatDuration(day.downtimeMs)} total` : "none"}
          tone={day.incidents.length ? "bad" : "purple"}
        />
      </div>

      <Card title={stripHours === 48 ? "Uptime, last 48 hours" : "Uptime, last 7 days"} icon={CalendarClock}>
        <UptimeBar slots={hourlySlots(report, stripHours, now)} />
        <div className="chart-footer">
          <span>{stripHours === 48 ? "48 h ago" : "7 days ago"}</span>
          <span className="chart-legend">
            <span><i className="ok" />100%</span>
            <span><i className="warn" />≥ 95%</span>
            <span><i className="bad" />&lt; 95%</span>
            <span><i className="empty" />not monitored</span>
          </span>
          <span>now</span>
        </div>
      </Card>

      {state.fivem && <FiveMPanel state={state} />}

      <div className="grid-2">
        <Card title="Response time" icon={Timer}>
          <AreaChart
            series={[{ label: "Response", values: latencies, color: "var(--teal)" }]}
            emptyText={state.status === "down" ? "No successful responses recently" : undefined}
            length={60}
            format={(v) => `${Math.round(v)} ms`}
            xLabels={["last 60 checks", "now"]}
            slotLabel={(n) => (n === 0 ? "latest check" : `${n} checks ago`)}
          />
        </Card>
        <Card title="Outages" icon={History}>
          {report.incidents.length === 0 ? (
            <p className="muted">No outages recorded{check.createdAt ? ` since ${new Date(check.createdAt).toLocaleDateString()}` : ""}.</p>
          ) : (
            <ul className="incident-list">
              {report.incidents.slice(0, 20).map((i) => (
                <li key={i.id} className={i.endedAt === null ? "ongoing" : ""}>
                  <span className="incident-dot" />
                  <div>
                    <b>
                      {i.endedAt === null ? "Ongoing · " : ""}
                      {i.approximate ? "≤ " : ""}
                      {formatDuration((i.endedAt ?? now) - i.startedAt)}
                    </b>
                    <span className="muted">
                      {new Date(i.startedAt).toLocaleString()} · {formatAgo(i.startedAt, now)}
                    </span>
                    <span className="incident-cause">{i.cause}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
