import { useState } from "react";
import { Activity, Gamepad2, Globe, Network, Plus, Server } from "lucide-react";
import { useAgents } from "./useAgents";
import { useChecks } from "./useChecks";
import { useAlerts } from "./useAlerts";
import { useSettings } from "./useSettings";
import { formatPercent } from "./format";
import { agentTone, checkTone, KIND_LABEL } from "./status";
import { Rail, type Section } from "./components/layout/Rail";
import { ListPanel } from "./components/layout/ListPanel";
import { AddHostForm } from "./components/forms/AddHostForm";
import { AddMonitorForm } from "./components/forms/AddMonitorForm";
import { OverviewPage } from "./components/pages/OverviewPage";
import { HostDetail } from "./components/pages/HostDetail";
import { MonitorDetail } from "./components/pages/MonitorDetail";
import { AlertsPage } from "./components/pages/AlertsPage";
import { SettingsPage } from "./components/pages/SettingsPage";
import { EmptyState, Meter, StatusDot } from "./components/ui/common";
import "./App.css";

const KIND_ICON = { fivem: Gamepad2, http: Globe, tcp: Network };

const matches = (query: string, ...fields: (string | undefined)[]) =>
  !query || fields.some((f) => f?.toLowerCase().includes(query.toLowerCase()));

function App() {
  const agents = useAgents();
  const checks = useChecks();
  const alerts = useAlerts(agents.subscriptions, agents.getState, checks.checks, checks.getState);
  const { settings, setSettings } = useSettings();

  const [section, setSection] = useState<Section>("overview");
  const [hostId, setHostId] = useState<string | null>(null);
  const [monitorId, setMonitorId] = useState<string | null>(null);
  /** Phones show either the list or the detail; this says which. */
  const [detailOpen, setDetailOpen] = useState(false);
  const [modal, setModal] = useState<"host" | "monitor" | null>(null);
  const [query, setQuery] = useState("");

  // Fall back to the first item if the selected one was removed.
  const host = agents.subscriptions.find((s) => s.id === hostId) ?? agents.subscriptions[0];
  const monitor = checks.checks.find((c) => c.id === monitorId) ?? checks.checks[0];

  const go = (next: Section) => {
    setSection(next);
    setQuery("");
    setDetailOpen(false);
  };
  const openHost = (id: string) => {
    setSection("hosts");
    setHostId(id);
    setDetailOpen(true);
  };
  const openMonitor = (id: string) => {
    setSection("monitors");
    setMonitorId(id);
    setDetailOpen(true);
  };

  const monitorsDown = checks.checks.filter((c) => checks.getState(c.id).status === "down").length;
  const hostsOffline = agents.subscriptions.filter((s) => agents.getState(s.id).status === "offline").length;

  const hostList = agents.subscriptions.filter((s) => {
    const info = agents.getState(s.id).info;
    return matches(query, s.name, s.url, info?.hostname, info?.osName);
  });
  const monitorList = checks.checks.filter((c) =>
    matches(query, c.name, c.target, c.joinCode, KIND_LABEL[c.kind], checks.getState(c.id).fivem?.hostname),
  );

  let list = null;
  let main;
  if (section === "hosts") {
    list = (
      <ListPanel
        title="Hosts"
        count={agents.subscriptions.length}
        query={query}
        onQuery={setQuery}
        placeholder="Search name or address"
        onAdd={() => setModal("host")}
        addLabel="Add host"
      >
        {hostList.map((sub) => {
          const s = agents.getState(sub.id);
          return (
            <button
              key={sub.id}
              className={`list-item ${host?.id === sub.id ? "selected" : ""}`}
              onClick={() => openHost(sub.id)}
            >
              <StatusDot tone={agentTone(s)} />
              <span className="list-item-text">
                <b className="ellipsis">{sub.name}</b>
                <span className="mono ellipsis">{sub.url.replace(/^https?:\/\//, "")}</span>
              </span>
              {s.status === "online" && (
                <span className="list-item-meters">
                  <span title={`CPU ${formatPercent(s.metrics?.cpu?.usagePercent)}`}>
                    <small>CPU</small>
                    <Meter value={s.metrics?.cpu?.usagePercent ?? null} />
                  </span>
                  <span title={`RAM ${formatPercent(s.metrics?.memory?.usagePercent)}`}>
                    <small>RAM</small>
                    <Meter value={s.metrics?.memory?.usagePercent ?? null} color="var(--purple)" />
                  </span>
                </span>
              )}
            </button>
          );
        })}
        {hostList.length === 0 && <p className="list-empty">{query ? "No matches." : "No hosts yet."}</p>}
      </ListPanel>
    );
    main = host ? (
      <HostDetail
        key={host.id}
        subscription={host}
        state={agents.getState(host.id)}
        onSetToken={(token) => agents.setToken(host.id, token)}
        onRemove={() => agents.removeSubscription(host.id)}
        onBack={() => setDetailOpen(false)}
      />
    ) : (
      <EmptyState
        icon={Server}
        title="No hosts yet"
        action={
          <button className="button primary" onClick={() => setModal("host")}>
            <Plus size={15} /> Add host
          </button>
        }
      >
        Start the HostLens agent on a machine, then add its address (e.g. <code>http://localhost:47821</code>) and
        the token it prints.
      </EmptyState>
    );
  } else if (section === "monitors") {
    list = (
      <ListPanel
        title="Monitors"
        count={checks.checks.length}
        query={query}
        onQuery={setQuery}
        placeholder="Search name, address or type"
        onAdd={() => setModal("monitor")}
        addLabel="Add monitor"
      >
        {monitorList.map((c) => {
          const s = checks.getState(c.id);
          const last = s.history[s.history.length - 1];
          const Icon = KIND_ICON[c.kind];
          return (
            <button
              key={c.id}
              className={`list-item ${monitor?.id === c.id ? "selected" : ""}`}
              onClick={() => openMonitor(c.id)}
            >
              <span className={`kind-badge ${c.kind}`}>
                <Icon size={15} />
                <StatusDot tone={checkTone(s)} />
              </span>
              <span className="list-item-text">
                <b className="ellipsis">{c.name}</b>
                <span className="mono ellipsis">
                  {c.joinCode ? `cfx.re/join/${c.joinCode}` : c.target.replace(/^https?:\/\//, "")}
                </span>
              </span>
              <span className="list-item-side">
                {c.kind === "fivem" && s.fivem && s.status === "up" ? (
                  <b className="players">
                    {s.fivem.clients}
                    <small>/{s.fivem.maxClients}</small>
                  </b>
                ) : (
                  <b className={s.status === "down" ? "bad-text" : ""}>
                    {s.status === "down" ? "Down" : last?.latencyMs != null ? `${last.latencyMs} ms` : "–"}
                  </b>
                )}
                <small>{KIND_LABEL[c.kind]}</small>
              </span>
            </button>
          );
        })}
        {monitorList.length === 0 && <p className="list-empty">{query ? "No matches." : "No monitors yet."}</p>}
      </ListPanel>
    );
    main = monitor ? (
      <MonitorDetail
        key={monitor.id}
        check={monitor}
        state={checks.getState(monitor.id)}
        report={checks.getReport(monitor.id)}
        onRunNow={() => void checks.runCheck(monitor)}
        onRemove={() => checks.removeCheck(monitor.id)}
        onSendReport={alerts.sendToDiscord}
        onBack={() => setDetailOpen(false)}
      />
    ) : (
      <EmptyState
        icon={Activity}
        title="No monitors yet"
        action={
          <button className="button primary" onClick={() => setModal("monitor")}>
            <Plus size={15} /> Add monitor
          </button>
        }
      >
        Monitor a FiveM server, a website or a TCP port. You'll get a Discord message when it goes down and when it
        comes back.
      </EmptyState>
    );
  } else if (section === "alerts") {
    main = (
      <AlertsPage
        alerts={alerts.alerts}
        webhookConfigured={!!alerts.settings.discordWebhookUrl}
        onAcknowledge={alerts.acknowledge}
        onClearResolved={alerts.clearResolved}
        onOpenSettings={() => go("settings")}
      />
    );
  } else if (section === "settings") {
    main = (
      <SettingsPage
        appSettings={settings}
        onChangeAppSettings={setSettings}
        alertSettings={alerts.settings}
        onChangeAlertSettings={alerts.setSettings}
        notifyError={alerts.notifyError}
        onSendTest={alerts.sendTest}
      />
    );
  } else {
    main = (
      <OverviewPage
        subscriptions={agents.subscriptions}
        getAgent={agents.getState}
        checks={checks.checks}
        getCheck={checks.getState}
        getReport={checks.getReport}
        alerts={alerts.alerts}
        onOpenHost={openHost}
        onOpenMonitor={openMonitor}
        onOpenAlerts={() => go("alerts")}
        onAddHost={() => setModal("host")}
        onAddMonitor={() => setModal("monitor")}
      />
    );
  }

  return (
    <div className={`app ${list ? "has-list" : ""} ${detailOpen ? "detail-open" : ""}`}>
      <Rail
        section={section}
        onSelect={go}
        badges={{
          alerts: alerts.unacknowledged,
          monitors: monitorsDown,
          hosts: hostsOffline,
        }}
        alarms={{ alerts: true, monitors: true, hosts: true }}
      />
      {list}
      <main className="main">{main}</main>

      {modal === "host" && (
        <AddHostForm
          onClose={() => setModal(null)}
          onAdd={(name, url, token) => {
            const sub = agents.addSubscription(name, url, token);
            setModal(null);
            openHost(sub.id);
          }}
        />
      )}
      {modal === "monitor" && (
        <AddMonitorForm
          onClose={() => setModal(null)}
          onAdd={(check) => {
            const created = checks.addCheck(check);
            setModal(null);
            openMonitor(created.id);
          }}
        />
      )}
    </div>
  );
}

export default App;
