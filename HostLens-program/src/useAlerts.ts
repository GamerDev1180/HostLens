import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { formatDuration, formatPercent } from "./format";
import { loadJson, saveJson } from "./storage";
import type {
  AgentState,
  Alert,
  AlertRuleKind,
  AlertSettings,
  CheckState,
  ServiceCheck,
  Subscription,
} from "./types";

const SETTINGS_KEY = "hostlens.alertSettings";
const ALERTS_KEY = "hostlens.alerts";
const MAX_ALERTS = 200;
const EVALUATE_MS = 1000;

export const RULE_LABELS: Record<AlertRuleKind, string> = {
  agentOffline: "Agent offline",
  cpuHigh: "High CPU usage",
  memoryHigh: "High memory usage",
  diskFull: "Disk nearly full",
  checkDown: "Monitor down",
};

/** Rules whose threshold is a percentage the user can set. */
export const RULES_WITH_THRESHOLD: AlertRuleKind[] = ["cpuHigh", "memoryHigh", "diskFull"];

export const DEFAULT_SETTINGS: AlertSettings = {
  discordWebhookUrl: "",
  rules: {
    agentOffline: { enabled: true, threshold: 0, forSeconds: 60 },
    cpuHigh: { enabled: true, threshold: 90, forSeconds: 120 },
    memoryHigh: { enabled: true, threshold: 90, forSeconds: 120 },
    diskFull: { enabled: true, threshold: 90, forSeconds: 0 },
    checkDown: { enabled: true, threshold: 0, forSeconds: 60 },
  },
};

function loadSettings(): AlertSettings {
  const stored = loadJson<Partial<AlertSettings>>(SETTINGS_KEY, {}, (v) => typeof v === "object" && v !== null);
  // Merge so rules added in newer versions get their defaults.
  return {
    discordWebhookUrl: stored.discordWebhookUrl ?? "",
    rules: { ...DEFAULT_SETTINGS.rules, ...stored.rules },
  };
}

/**
 * One thing an alert rule watches. `active` is undefined when the state is
 * unknown (agent still connecting, check not run yet): existing alerts are
 * then left as they are rather than resolved.
 */
interface Condition {
  key: string;
  kind: AlertRuleKind;
  target: string;
  active: boolean | undefined;
  /** When the condition started, if the source tracks it (outages). */
  since?: number | null;
  firing: string;
  resolved: string;
}

function conditions(
  settings: AlertSettings,
  subscriptions: Subscription[],
  getAgent: (id: string) => AgentState,
  checks: ServiceCheck[],
  getCheck: (id: string) => CheckState,
): Condition[] {
  const { rules } = settings;
  const out: Condition[] = [];

  for (const sub of subscriptions) {
    const state = getAgent(sub.id);
    const known = state.status !== "connecting";
    const online = state.status === "online";
    const name = `"${sub.name}"`;

    if (rules.agentOffline.enabled) {
      out.push({
        key: `agentOffline:${sub.id}`,
        kind: "agentOffline",
        target: sub.name,
        active: known ? state.status === "offline" : undefined,
        since: state.offlineSince,
        firing: `🔴 Agent ${name} is offline${state.error ? ` (${state.error})` : ""}`,
        resolved: `✅ Agent ${name} is back online`,
      });
    }

    // Metric rules only judge fresh data; while offline the last values are stale.
    const metrics = online ? state.metrics : null;
    const cpu = metrics?.cpu?.usagePercent;
    if (rules.cpuHigh.enabled) {
      out.push({
        key: `cpuHigh:${sub.id}`,
        kind: "cpuHigh",
        target: sub.name,
        active: cpu === undefined ? undefined : cpu >= rules.cpuHigh.threshold,
        firing: `🔴 CPU on ${name} is at ${formatPercent(cpu)} (threshold ${rules.cpuHigh.threshold}%)`,
        resolved: `✅ CPU on ${name} is back to ${formatPercent(cpu)}`,
      });
    }
    const mem = metrics?.memory?.usagePercent;
    if (rules.memoryHigh.enabled) {
      out.push({
        key: `memoryHigh:${sub.id}`,
        kind: "memoryHigh",
        target: sub.name,
        active: mem === undefined ? undefined : mem >= rules.memoryHigh.threshold,
        firing: `🔴 Memory on ${name} is at ${formatPercent(mem)} (threshold ${rules.memoryHigh.threshold}%)`,
        resolved: `✅ Memory on ${name} is back to ${formatPercent(mem)}`,
      });
    }
    if (rules.diskFull.enabled) {
      for (const disk of metrics?.disk ?? []) {
        out.push({
          key: `diskFull:${sub.id}:${disk.mount}`,
          kind: "diskFull",
          target: `${sub.name} ${disk.mount}`,
          active: disk.usagePercent >= rules.diskFull.threshold,
          firing: `🔴 Disk ${disk.mount} on ${name} is ${formatPercent(disk.usagePercent)} full (threshold ${rules.diskFull.threshold}%)`,
          resolved: `✅ Disk ${disk.mount} on ${name} is down to ${formatPercent(disk.usagePercent)}`,
        });
      }
    }
    // Disks of an offline agent are unknown, not resolved: keep their alerts.
    if (rules.diskFull.enabled && !online) {
      out.push({ key: `diskFull:${sub.id}:`, kind: "diskFull", target: sub.name, active: undefined, firing: "", resolved: "" });
    }
  }

  if (rules.checkDown.enabled) {
    for (const check of checks) {
      const state = getCheck(check.id);
      const last = state.history[state.history.length - 1];
      const what = check.kind === "fivem" ? "FiveM server" : "Service";
      const where = check.joinCode ? `cfx.re/join/${check.joinCode}` : check.target;
      const downFor = state.lastDowntimeMs !== null ? ` after ${formatDuration(state.lastDowntimeMs)} down` : "";
      out.push({
        key: `checkDown:${check.id}`,
        kind: "checkDown",
        target: check.name,
        active: state.status === "pending" ? undefined : state.status === "down",
        since: state.downSince,
        firing: `🔴 ${what} "${check.name}" (${where}) is down${last ? `: ${last.detail}` : ""}`,
        resolved: `✅ ${what} "${check.name}" is back up${downFor}${last ? ` · ${last.detail}` : ""}${last?.latencyMs != null ? ` · ${last.latencyMs} ms` : ""}`,
      });
    }
  }
  return out;
}

export function useAlerts(
  subscriptions: Subscription[],
  getAgent: (id: string) => AgentState,
  checks: ServiceCheck[],
  getCheck: (id: string) => CheckState,
) {
  const [settings, setSettings] = useState<AlertSettings>(loadSettings);
  const [alerts, setAlerts] = useState<Alert[]>(() => loadJson(ALERTS_KEY, [], Array.isArray));
  const [notifyError, setNotifyError] = useState<string | null>(null);
  const alertsRef = useRef(alerts);
  /** When each metric condition (which has no `since` of its own) started holding. */
  const pendingSince = useRef<Record<string, number>>({});

  // The evaluator runs on a timer and reads the latest inputs through this ref.
  const inputs = useRef({ settings, subscriptions, getAgent, checks, getCheck });
  inputs.current = { settings, subscriptions, getAgent, checks, getCheck };

  useEffect(() => saveJson(SETTINGS_KEY, settings), [settings]);
  useEffect(() => saveJson(ALERTS_KEY, alerts), [alerts]);

  const updateAlerts = useCallback((fn: (list: Alert[]) => Alert[]) => {
    alertsRef.current = fn(alertsRef.current).slice(0, MAX_ALERTS);
    setAlerts(alertsRef.current);
  }, []);

  const notify = useCallback((webhookUrl: string, content: string) => {
    if (!webhookUrl) return Promise.resolve();
    return invoke("send_discord_webhook", { webhookUrl, content }).then(
      () => setNotifyError(null),
      (e) => {
        setNotifyError(String(e));
        throw e;
      },
    );
  }, []);

  useEffect(() => {
    const evaluate = () => {
      const { settings, subscriptions, getAgent, checks, getCheck } = inputs.current;
      const now = Date.now();
      const seen = new Set<string>();
      const fired: Alert[] = [];
      const resolved = new Map<string, number>();
      const active = new Map(
        alertsRef.current.filter((a) => a.resolvedAt === null).map((a) => [a.key, a]),
      );

      for (const c of conditions(settings, subscriptions, getAgent, checks, getCheck)) {
        seen.add(c.key);
        if (c.active === undefined) continue;
        if (!c.active) {
          delete pendingSince.current[c.key];
          if (active.has(c.key)) {
            resolved.set(c.key, now);
            notify(settings.discordWebhookUrl, c.resolved).catch(() => {});
          }
          continue;
        }
        const since = c.since ?? (pendingSince.current[c.key] ??= now);
        if (!active.has(c.key) && now - since >= settings.rules[c.kind].forSeconds * 1000) {
          fired.push({
            id: crypto.randomUUID(),
            key: c.key,
            kind: c.kind,
            target: c.target,
            message: c.firing,
            startedAt: now,
            resolvedAt: null,
            acknowledged: false,
          });
          notify(settings.discordWebhookUrl, c.firing).catch(() => {});
        }
      }

      // The agent/check was removed or the rule disabled: close quietly.
      const isOrphan = (key: string) =>
        !seen.has(key) && ![...seen].some((s) => s.endsWith(":") && key.startsWith(s));
      for (const key of active.keys()) {
        if (isOrphan(key)) resolved.set(key, now);
      }
      for (const key of Object.keys(pendingSince.current)) {
        if (!seen.has(key)) delete pendingSince.current[key];
      }

      if (fired.length || resolved.size) {
        updateAlerts((list) => [
          ...fired,
          ...list.map((a) =>
            a.resolvedAt === null && resolved.has(a.key) ? { ...a, resolvedAt: resolved.get(a.key)! } : a,
          ),
        ]);
      }
    };
    const timer = setInterval(evaluate, EVALUATE_MS);
    return () => clearInterval(timer);
  }, [notify, updateAlerts]);

  const acknowledge = useCallback(
    (id: string) => updateAlerts((list) => list.map((a) => (a.id === id ? { ...a, acknowledged: true } : a))),
    [updateAlerts],
  );

  const clearResolved = useCallback(
    () => updateAlerts((list) => list.filter((a) => a.resolvedAt === null)),
    [updateAlerts],
  );

  const sendTest = useCallback(
    (webhookUrl: string) =>
      notify(webhookUrl, "🔔 Test notification from HostLens: alerts will be posted here."),
    [notify],
  );

  /** Posts to the configured webhook; rejects if none is set or Discord refuses. */
  const sendToDiscord = useCallback(
    (content: string) =>
      settings.discordWebhookUrl
        ? notify(settings.discordWebhookUrl, content)
        : Promise.reject(new Error("Set a Discord webhook in Settings first")),
    [notify, settings.discordWebhookUrl],
  );

  const unacknowledged = alerts.filter((a) => a.resolvedAt === null && !a.acknowledged).length;

  return {
    alerts,
    unacknowledged,
    settings,
    setSettings,
    acknowledge,
    clearResolved,
    sendTest,
    sendToDiscord,
    notifyError,
  };
}
