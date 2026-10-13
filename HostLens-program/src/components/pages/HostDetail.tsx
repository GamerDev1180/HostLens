import { FormEvent, useState } from "react";
import {
  ArrowLeft,
  Cpu,
  HardDrive,
  Info,
  KeyRound,
  ListTree,
  MemoryStick,
  Network,
  QrCode,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import type { AgentState, Subscription } from "../../types";
import { formatBytes, formatPercent, formatRate, formatUptime } from "../../format";
import { HISTORY_LENGTH, useProcesses } from "../../useAgents";
import { AGENT_STATUS_LABEL, agentTone, peakDisk } from "../../status";
import { AreaChart } from "../ui/AreaChart";
import { Gauge, levelColor } from "../ui/Gauge";
import { Card, EmptyState, Meter, StatusPill } from "../ui/common";
import { PairDeviceModal } from "../forms/PairDeviceModal";
import { DevicesPanel } from "./DevicesPanel";
import { NetworkPanel } from "./NetworkPanel";

type Tab = "overview" | "network" | "devices";
const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "network", label: "Network" },
  { id: "devices", label: "Devices" },
];

interface Props {
  subscription: Subscription;
  state: AgentState;
  onSetToken: (token: string) => void;
  onRemove: () => void;
  onBack: () => void;
}

const secondsAgo = (n: number) => (n === 0 ? "now" : `${n} s ago`);
const percentLabel = (v: number) => `${Math.round(v)}%`;

function TokenForm({ onSave }: { onSave: (token: string) => void }) {
  const [token, setToken] = useState("");
  function submit(e: FormEvent) {
    e.preventDefault();
    if (token.trim()) onSave(token);
  }
  return (
    <form className="inline-form" onSubmit={submit}>
      <input
        className="mono"
        type="password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder="API token printed by the agent"
        autoComplete="off"
      />
      <button type="submit" className="button primary">
        <KeyRound size={15} /> Save token
      </button>
    </form>
  );
}

function ProcessTable({ subscription }: { subscription: Subscription }) {
  const [sort, setSort] = useState<"cpu" | "memory">("cpu");
  const { processes, error } = useProcesses(subscription, sort);
  // Agents before 1.1 don't have the endpoint.
  const unsupported = error?.includes("404") || error?.includes("501");

  return (
    <Card
      title="Top processes"
      icon={ListTree}
      actions={
        <span className="segmented small">
          {(["cpu", "memory"] as const).map((key) => (
            <button key={key} className={sort === key ? "selected" : ""} onClick={() => setSort(key)}>
              {key === "cpu" ? "CPU" : "Memory"}
            </button>
          ))}
        </span>
      }
    >
      {unsupported ? (
        <p className="muted">This agent doesn't report processes (update it to 1.1 or later).</p>
      ) : !processes ? (
        <p className="muted">{error ?? "Loading…"}</p>
      ) : (
        <>
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th className="num">PID</th>
                <th className="num">CPU</th>
                <th className="num">Memory</th>
              </tr>
            </thead>
            <tbody>
              {processes.processes.map((p) => (
                <tr key={p.pid}>
                  <td className="ellipsis" title={p.name}>
                    {p.name}
                  </td>
                  <td className="num muted mono">{p.pid}</td>
                  <td className="num">{formatPercent(p.cpuPercent)}</td>
                  <td className="num">{formatBytes(p.memoryBytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <span className="card-footnote">
            {processes.totalCount} processes · CPU is a share of the whole machine
          </span>
        </>
      )}
    </Card>
  );
}

export function HostDetail({ subscription, state, onSetToken, onRemove, onBack }: Props) {
  const { info, metrics } = state;
  const unauthorized = state.status === "offline" && state.error?.includes("401");
  // Fields may be missing when talking to an older agent.
  const cpu = metrics?.cpu;
  const memory = metrics?.memory;
  const disks = metrics?.disk ?? [];
  const perCore = cpu?.perCorePercent ?? [];
  const busiest = peakDisk(state);
  const [tab, setTab] = useState<Tab>("overview");
  const [pairing, setPairing] = useState(false);

  return (
    <div className="page">
      <header className="page-header">
        <button className="icon-button back-button" onClick={onBack} aria-label="Back">
          <ArrowLeft size={18} />
        </button>
        <div className="page-title">
          <h1>{subscription.name}</h1>
          <p className="mono muted">
            {subscription.url}
            {info && ` · ${[info.hostname, info.osName, info.arch].filter(Boolean).join(" · ")}`}
          </p>
        </div>
        <div className="page-actions">
          <StatusPill tone={agentTone(state)}>{AGENT_STATUS_LABEL[state.status]}</StatusPill>
          <button className="button ghost" onClick={() => setPairing(true)} title="Show a QR code to pair a phone">
            <QrCode size={15} /> Pair device
          </button>
          <button className="icon-button danger" onClick={onRemove} title="Remove host" aria-label="Remove host">
            <Trash2 size={17} />
          </button>
        </div>
      </header>

      {state.status === "offline" && (
        <div className="banner danger">
          <TriangleAlert size={18} />
          <div>
            <b>
              {unauthorized
                ? "The agent rejected the API token."
                : `Can't reach this host${metrics ? ", so the values below are the last ones received" : ""}.`}
            </b>
            <span className="muted"> {state.error}</span>
            {unauthorized && <TokenForm onSave={onSetToken} />}
          </div>
        </div>
      )}

      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? "selected" : ""}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {pairing && <PairDeviceModal subscription={subscription} onClose={() => setPairing(false)} />}

      {tab === "network" ? (
        state.status === "online" ? (
          <NetworkPanel subscription={subscription} state={state} />
        ) : (
          <EmptyState icon={Network} title="Host is not online">
            Connections are shown live while the agent is reachable.
          </EmptyState>
        )
      ) : tab === "devices" ? (
        <DevicesPanel subscription={subscription} onPair={() => setPairing(true)} />
      ) : !metrics ? (
        state.status === "connecting" && (
          <EmptyState icon={Cpu} title="Connecting…">
            Waiting for the first sample from {subscription.url}.
          </EmptyState>
        )
      ) : (
        <>
          <div className="gauge-row card">
            <Gauge value={cpu?.usagePercent ?? null} label="CPU" detail={`${cpu?.logicalCores ?? perCore.length} cores`} />
            <Gauge
              value={memory?.usagePercent ?? null}
              label="Memory"
              detail={memory ? `${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)}` : undefined}
            />
            <Gauge
              value={memory?.swap?.usagePercent ?? null}
              label={info?.platform === "win32" ? "Page file" : "Swap"}
              detail={memory?.swap ? `${formatBytes(memory.swap.usedBytes)} / ${formatBytes(memory.swap.totalBytes)}` : "none"}
            />
            <Gauge value={busiest} label="Fullest disk" detail={`${disks.length} disk${disks.length === 1 ? "" : "s"}`} />
            <div className="gauge-facts">
              <div>
                <span className="label">Uptime</span>
                <b>{formatUptime(metrics.uptimeSeconds)}</b>
              </div>
              <div>
                <span className="label">Network</span>
                <b className="rate">
                  <span className="rx">↓ {formatRate(state.netRxRate)}</span>
                  <span className="tx">↑ {formatRate(state.netTxRate)}</span>
                </b>
              </div>
              {cpu?.loadAverage && (
                <div>
                  <span className="label">Load average</span>
                  <b className="mono">{cpu.loadAverage.map((l) => l.toFixed(2)).join("  ")}</b>
                </div>
              )}
            </div>
          </div>

          <div className="grid-2">
            <Card title="CPU" icon={Cpu}>
              <AreaChart
                series={[{ label: "CPU", values: state.cpuHistory, color: "var(--accent)" }]}
                length={HISTORY_LENGTH}
                max={100}
                format={percentLabel}
                xLabels={["60 s ago", "now"]}
                slotLabel={secondsAgo}
              />
            </Card>
            <Card title="Memory" icon={MemoryStick}>
              <AreaChart
                series={[{ label: "Memory", values: state.memHistory, color: "var(--purple)" }]}
                length={HISTORY_LENGTH}
                max={100}
                format={percentLabel}
                xLabels={["60 s ago", "now"]}
                slotLabel={secondsAgo}
              />
            </Card>
          </div>

          {metrics.network && (
            <Card title="Network throughput" icon={Network}>
              <AreaChart
                series={[
                  { label: "Download", values: state.netRxHistory, color: "var(--teal)" },
                  { label: "Upload", values: state.netTxHistory, color: "var(--orange)" },
                ]}
                length={HISTORY_LENGTH}
                format={(v) => formatRate(v)}
                xLabels={["60 s ago", "now"]}
                slotLabel={secondsAgo}
                height={140}
              />
              {state.interfaceRates.length > 0 && (
                <div className="iface-list">
                  {state.interfaceRates.map((iface) => (
                    <div className="iface" key={iface.name}>
                      <span className="ellipsis" title={iface.name}>
                        {iface.name}
                      </span>
                      <span className="rx">↓ {formatRate(iface.rxRate)}</span>
                      <span className="tx">↑ {formatRate(iface.txRate)}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          )}

          <div className="grid-2">
            {disks.length > 0 && (
              <Card title="Disks" icon={HardDrive}>
                <div className="disk-list">
                  {disks.map((disk) => (
                    <div className="disk" key={disk.mount}>
                      <div className="disk-top">
                        <b className="mono ellipsis" title={disk.mount}>
                          {disk.mount}
                        </b>
                        <span className="muted">
                          {formatBytes(disk.freeBytes)} free of {formatBytes(disk.totalBytes)}
                        </span>
                      </div>
                      <Meter value={disk.usagePercent} color={levelColor(disk.usagePercent)} />
                    </div>
                  ))}
                </div>
              </Card>
            )}
            {info && (
              <Card title="System" icon={Info}>
                <dl className="facts">
                  <dt>Hostname</dt>
                  <dd className="mono">{info.hostname}</dd>
                  <dt>OS</dt>
                  <dd>
                    {info.osName} <span className="muted">({info.osRelease})</span>
                  </dd>
                  <dt>CPU</dt>
                  <dd>{info.cpuModel}</dd>
                  <dt>Memory</dt>
                  <dd>{formatBytes(info.totalMemoryBytes)}</dd>
                  <dt>Booted</dt>
                  <dd>{new Date(info.bootTime).toLocaleString()}</dd>
                  <dt>Agent</dt>
                  <dd>v{info.agentVersion}</dd>
                </dl>
              </Card>
            )}
          </div>

          <ProcessTable subscription={subscription} />

          {perCore.length > 0 && (
            <Card title={`Cores · ${info?.cpuModel ?? ""}`} icon={Cpu}>
              <div className="core-grid">
                {perCore.map((value, i) => (
                  <div
                    className="core-tile"
                    key={i}
                    title={`Core ${i}: ${formatPercent(value)}`}
                    style={{ "--level": `${Math.max(4, value)}%` } as React.CSSProperties}
                  >
                    <span className="muted">#{i}</span>
                    <b>{Math.round(value)}%</b>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
