import { useMemo, useState } from "react";
import { Cable, DoorOpen, Globe, Network, Search, ServerCog, Waypoints } from "lucide-react";
import type { ConnectionMetrics, ConnectionScope, ConnectionsResponse } from "../../../../agent/types";
import { isUnsupported } from "../../agentApi";
import { formatRate } from "../../format";
import { HISTORY_LENGTH, useAgentPoll } from "../../useAgents";
import type { AgentState, Subscription } from "../../types";
import { AreaChart } from "../ui/AreaChart";
import { Card, EmptyState, Meter, StatTile } from "../ui/common";

interface Props {
  subscription: Subscription;
  state: AgentState;
}

const POLL_MS = 3000;
const SCOPE_LABEL: Record<ConnectionScope, string> = { internet: "Internet", lan: "Local network", loopback: "This machine" };
const STATE_LABEL: Record<string, string> = {
  established: "Established",
  time_wait: "Time wait",
  close_wait: "Close wait",
  syn_sent: "Connecting",
  syn_received: "Connecting",
  fin_wait: "Closing",
  closing: "Closing",
  last_ack: "Closing",
  closed: "Closed",
};

/** Well-known ports, to make destinations readable. */
const PORT_NAMES: Record<number, string> = {
  22: "SSH", 53: "DNS", 80: "HTTP", 443: "HTTPS", 3306: "MySQL", 5432: "PostgreSQL", 6379: "Redis",
  27017: "MongoDB", 30120: "FiveM", 40120: "txAdmin", 25565: "Minecraft", 3389: "RDP", 445: "SMB",
  993: "IMAPS", 587: "SMTP", 5222: "XMPP", 8080: "HTTP alt", 47821: "HostLens",
};
const portLabel = (port: number) => PORT_NAMES[port] ?? String(port);

/** "ams15s32-in-x08.1e100.net" → "1e100.net": the part people recognise. */
function domainOf(host: string | null): string | null {
  if (!host) return null;
  const parts = host.replace(/\.$/, "").split(".");
  if (parts.length <= 2) return parts.join(".");
  // Keep three labels for short second-level domains like "co.uk".
  const tail = parts.slice(-2);
  return (tail[0]!.length <= 3 && tail[1]!.length === 2 ? parts.slice(-3) : tail).join(".");
}

/**
 * A connection whose local port is one we listen on was opened *to* us (e.g. a
 * player joining the FiveM server); the remote port is then just a random
 * client port, so the service is the local port.
 */
const isIncoming = (c: ConnectionMetrics, listeningPorts: Set<number>) => listeningPorts.has(c.localPort);

/** "HTTPS" for outgoing, "← FiveM" for incoming. */
const serviceLabel = (c: ConnectionMetrics, listeningPorts: Set<number>) =>
  isIncoming(c, listeningPorts) ? `← ${portLabel(c.localPort)}` : portLabel(c.remotePort);

interface Destination {
  key: string;
  label: string;
  addresses: Set<string>;
  hosts: Set<string>;
  services: Set<string>;
  processes: Set<string>;
  scope: ConnectionScope;
  incoming: number;
  count: number;
}

function groupDestinations(connections: ConnectionMetrics[], listeningPorts: Set<number>): Destination[] {
  const groups = new Map<string, Destination>();
  for (const c of connections) {
    if (c.state !== "established" || c.scope === "loopback") continue;
    // Incoming connections (players, visitors) are grouped per service rather
    // than per client, which would flood the list; outgoing ones per domain.
    const incoming = isIncoming(c, listeningPorts);
    const key = incoming ? `in:${c.localPort}:${c.scope}` : (domainOf(c.remoteHost) ?? c.remoteAddress);
    let g = groups.get(key);
    if (!g) {
      const label = incoming
        ? `${c.scope === "lan" ? "LAN clients" : "Clients"} of ${portLabel(c.localPort)}${PORT_NAMES[c.localPort] ? ` (:${c.localPort})` : ""}`
        : key;
      g = { key, label, addresses: new Set(), hosts: new Set(), services: new Set(), processes: new Set(), scope: c.scope, incoming: 0, count: 0 };
      groups.set(key, g);
    }
    g.count++;
    g.addresses.add(c.remoteAddress);
    if (c.remoteHost) g.hosts.add(c.remoteHost);
    g.services.add(serviceLabel(c, listeningPorts));
    if (isIncoming(c, listeningPorts)) g.incoming++;
    if (c.processName) g.processes.add(c.processName);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

function groupProcesses(connections: ConnectionMetrics[]) {
  const groups = new Map<string, { name: string; count: number; internet: number; remotes: Set<string> }>();
  for (const c of connections) {
    if (c.state !== "established") continue;
    const name = c.processName ?? "Unknown (other user)";
    const g = groups.get(name) ?? { name, count: 0, internet: 0, remotes: new Set<string>() };
    g.count++;
    if (c.scope === "internet") g.internet++;
    if (c.scope !== "loopback") g.remotes.add(c.remoteAddress);
    groups.set(name, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

const secondsAgo = (n: number) => (n === 0 ? "now" : `${n} s ago`);

export function NetworkPanel({ subscription, state }: Props) {
  const { data, error } = useAgentPoll<ConnectionsResponse>(subscription, "/api/v1/metrics/connections", POLL_MS);
  const [scope, setScope] = useState<ConnectionScope | "all">("all");
  const [query, setQuery] = useState("");
  const [showUdp, setShowUdp] = useState(false);

  const connections = data?.connections ?? [];
  const established = connections.filter((c) => c.state === "established");
  const listeningPorts = useMemo(
    () => new Set((data?.listening ?? []).filter((l) => l.protocol === "tcp").map((l) => l.port)),
    [data],
  );
  const destinations = useMemo(() => groupDestinations(connections, listeningPorts), [connections, listeningPorts]);
  const processes = useMemo(() => groupProcesses(connections), [connections]);
  const listening = (data?.listening ?? []).filter((l) => showUdp || l.protocol === "tcp");
  const exposedTcp = (data?.listening ?? []).filter((l) => l.protocol === "tcp" && l.exposed);

  const q = query.trim().toLowerCase();
  const rows = connections
    .filter((c) => scope === "all" || c.scope === scope)
    .filter(
      (c) =>
        !q ||
        [c.processName, c.remoteAddress, c.remoteHost, String(c.remotePort), String(c.localPort), serviceLabel(c, listeningPorts)].some(
          (f) => f?.toLowerCase().includes(q),
        ),
    )
    .sort((a, b) => Number(b.state === "established") - Number(a.state === "established") || (a.processName ?? "~").localeCompare(b.processName ?? "~"));

  if (isUnsupported(error)) {
    return (
      <EmptyState icon={Network} title="Not available on this agent">
        Connection monitoring needs agent 1.2 or later on Windows or Linux.
      </EmptyState>
    );
  }

  const topCount = destinations[0]?.count ?? 1;
  const topProcess = processes[0]?.count ?? 1;

  return (
    <>
      <div className="stat-grid">
        <StatTile icon={Cable} label="Connections" value={established.length} detail={`${connections.length - established.length} opening or closing`} tone="accent" />
        <StatTile
          icon={Globe}
          label="Internet"
          value={established.filter((c) => c.scope === "internet").length}
          detail={`${new Set(established.filter((c) => c.scope === "internet").map((c) => c.remoteAddress)).size} remote addresses`}
          tone="purple"
        />
        <StatTile
          icon={Waypoints}
          label="Local network"
          value={established.filter((c) => c.scope === "lan").length}
          detail={`${established.filter((c) => c.scope === "loopback").length} on this machine`}
          tone="teal"
        />
        <StatTile
          icon={DoorOpen}
          label="Open TCP ports"
          value={exposedTcp.length}
          detail="reachable from other machines"
          tone={exposedTcp.length > 20 ? "warn" : "orange"}
        />
      </div>

      {state.metrics?.network && (
        <Card title="Throughput" icon={Network}>
          <AreaChart
            series={[
              { label: "Download", values: state.netRxHistory, color: "var(--teal)" },
              { label: "Upload", values: state.netTxHistory, color: "var(--orange)" },
            ]}
            length={HISTORY_LENGTH}
            format={(v) => formatRate(v)}
            xLabels={["60 s ago", "now"]}
            slotLabel={secondsAgo}
            height={110}
          />
        </Card>
      )}

      {error && !data && <p className="form-error">{error}</p>}
      {!data && !error && <p className="muted">Loading connections…</p>}

      {data && (
        <>
          <div className="grid-2">
            <Card title="Top destinations" icon={Globe}>
              {destinations.length === 0 ? (
                <p className="muted">No connections to other machines right now.</p>
              ) : (
                <ul className="rank-list">
                  {destinations.slice(0, 12).map((d) => (
                    <li key={d.key}>
                      <div className="rank-top">
                        <span className={`scope-dot ${d.scope}`} title={SCOPE_LABEL[d.scope]} />
                        <b className="ellipsis" title={[...d.hosts].join("\n") || [...d.addresses].join("\n")}>
                          {d.label}
                        </b>
                        {d.incoming > 0 && (
                          <span className="direction in" title="Connections opened to this machine">
                            {d.incoming === d.count ? "incoming" : `${d.incoming} incoming`}
                          </span>
                        )}
                        <span className="rank-count">{d.count}</span>
                      </div>
                      <Meter value={(d.count / topCount) * 100} color={d.scope === "lan" ? "var(--teal)" : "var(--purple)"} />
                      <span className="rank-meta ellipsis">
                        {[...d.processes].slice(0, 3).join(", ") || "unknown process"} ·{" "}
                        {[...d.services].slice(0, 4).join(", ")}
                        {d.addresses.size > 1 ? ` · ${d.addresses.size} addresses` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card title="By process" icon={ServerCog}>
              {processes.length === 0 ? (
                <p className="muted">No established connections.</p>
              ) : (
                <ul className="rank-list">
                  {processes.slice(0, 12).map((p) => (
                    <li key={p.name}>
                      <div className="rank-top">
                        <b className="ellipsis">{p.name}</b>
                        <span className="rank-count">{p.count}</span>
                      </div>
                      <Meter value={(p.count / topProcess) * 100} />
                      <span className="rank-meta">
                        {p.internet} to the internet · {p.remotes.size} remote address{p.remotes.size === 1 ? "" : "es"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <Card
            title={`Connections (${rows.length})`}
            icon={Cable}
            actions={
              <>
                <label className="search small">
                  <Search size={13} />
                  <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Process, address, port" />
                </label>
                <span className="segmented small">
                  {(["all", "internet", "lan", "loopback"] as const).map((s) => (
                    <button key={s} className={scope === s ? "selected" : ""} onClick={() => setScope(s)}>
                      {s === "all" ? "All" : s === "internet" ? "Internet" : s === "lan" ? "LAN" : "Local"}
                    </button>
                  ))}
                </span>
              </>
            }
          >
            <div className="table-scroll">
              <table className="table connections">
                <thead>
                  <tr>
                    <th>Process</th>
                    <th>Remote</th>
                    <th className="port-col">Service</th>
                    <th className="num">Local port</th>
                    <th className="state-col">State</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 300).map((c, i) => (
                    <tr key={`${c.localAddress}:${c.localPort}-${c.remoteAddress}:${c.remotePort}-${i}`}>
                      <td className="ellipsis" title={c.pid ? `PID ${c.pid}` : "Owned by another user"}>
                        {c.processName ?? <span className="muted">unknown</span>}
                      </td>
                      <td className="ellipsis" title={`${c.remoteAddress}${c.remoteHost ? `\n${c.remoteHost}` : ""}`}>
                        <span className={`scope-dot ${c.scope}`} />
                        {c.remoteHost ?? <span className="mono">{c.remoteAddress}</span>}
                      </td>
                      <td className="port-col mono" title={isIncoming(c, listeningPorts) ? "Incoming: opened to this machine" : `Outgoing to port ${c.remotePort}`}>
                        <span className={isIncoming(c, listeningPorts) ? "direction in" : ""}>{serviceLabel(c, listeningPorts)}</span>
                      </td>
                      <td className="num mono muted">{c.localPort}</td>
                      <td className={`state-col ${c.state === "established" ? "" : "muted"}`}>{STATE_LABEL[c.state] ?? c.state}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {rows.length > 300 && <span className="card-footnote">Showing 300 of {rows.length}; search to narrow down.</span>}
          </Card>

          <Card
            title={`Listening ports (${listening.length})`}
            icon={DoorOpen}
            actions={
              <label className="check-label">
                <input type="checkbox" checked={showUdp} onChange={(e) => setShowUdp(e.target.checked)} /> Include UDP
              </label>
            }
          >
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th className="port-col">Port</th>
                    <th>Process</th>
                    <th>Address</th>
                    <th className="state-col">Reachable</th>
                  </tr>
                </thead>
                <tbody>
                  {listening.map((l, i) => (
                    <tr key={`${l.protocol}-${l.address}-${l.port}-${i}`}>
                      <td className="port-col mono">
                        {l.port}
                        <small className="muted"> {l.protocol.toUpperCase()}</small>
                        {PORT_NAMES[l.port] && <small className="muted"> · {PORT_NAMES[l.port]}</small>}
                      </td>
                      <td className="ellipsis">{l.processName ?? <span className="muted">unknown</span>}</td>
                      <td className="mono muted ellipsis">{l.address}</td>
                      <td className="state-col">
                        {l.exposed ? <span className="tag warn">Network</span> : <span className="tag">This machine</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </>
  );
}
