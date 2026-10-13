import { useCallback, useEffect, useRef, useState } from "react";
import { fetchAgent } from "./agentApi";
import type {
  AgentInfo,
  AgentState,
  InterfaceRate,
  MetricsResponse,
  ProcessesResponse,
  Subscription,
} from "./types";

const STORAGE_KEY = "hostlens.subscriptions";
const POLL_MS = 1000;
export const HISTORY_LENGTH = 60;
const PROCESS_POLL_MS = 2000;

const emptyState = (): AgentState => ({
  status: "connecting",
  error: null,
  offlineSince: null,
  info: null,
  metrics: null,
  netRxRate: null,
  netTxRate: null,
  interfaceRates: [],
  cpuHistory: [],
  memHistory: [],
  netRxHistory: [],
  netTxHistory: [],
  lastUpdated: null,
});

function loadSubscriptions(): Subscription[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function normalizeUrl(input: string): string {
  let url = input.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  return url;
}


const pushHistory = (history: number[], value: number | null) =>
  value === null ? history : [...history, value].slice(-HISTORY_LENGTH);

interface NetSample {
  at: number;
  rx: number;
  tx: number;
  interfaces: Map<string, { rx: number; tx: number }>;
}

// Counters are cumulative and can wrap or reset (reboot), so negative deltas are dropped.
function rate(prev: number, cur: number, seconds: number): number | null {
  const delta = cur - prev;
  return delta >= 0 && seconds > 0 ? delta / seconds : null;
}

export function useAgents() {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>(loadSubscriptions);
  const [states, setStates] = useState<Record<string, AgentState>>({});
  const prevNet = useRef<Record<string, NetSample>>({});
  const infoCache = useRef<Record<string, AgentInfo>>({});
  const inFlight = useRef<Set<string>>(new Set());

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(subscriptions));
    } catch {
      // Storage unavailable; subscriptions just won't persist.
    }
  }, [subscriptions]);

  useEffect(() => {
    let cancelled = false;

    async function poll(sub: Subscription) {
      if (inFlight.current.has(sub.id)) return;
      inFlight.current.add(sub.id);
      try {
        // Host info is static, so it's fetched once per connection.
        const info = (infoCache.current[sub.id] ??= await fetchAgent<AgentInfo>(sub, "/api/v1/info"));
        const metrics = await fetchAgent<MetricsResponse>(sub, "/api/v1/metrics");
        if (cancelled) return;

        let netRxRate: number | null = null;
        let netTxRate: number | null = null;
        let interfaceRates: InterfaceRate[] = [];
        const net = metrics.network ?? null;
        if (net) {
          const at = Date.parse(metrics.timestamp) || Date.now();
          const prev = prevNet.current[sub.id];
          const seconds = prev ? (at - prev.at) / 1000 : 0;
          if (prev) {
            netRxRate = rate(prev.rx, net.receivedBytes, seconds);
            netTxRate = rate(prev.tx, net.sentBytes, seconds);
          }
          const interfaces = net.interfaces ?? [];
          interfaceRates = interfaces.map((i) => {
            const before = prev?.interfaces.get(i.name);
            return {
              name: i.name,
              rxRate: before ? rate(before.rx, i.receivedBytes, seconds) : null,
              txRate: before ? rate(before.tx, i.sentBytes, seconds) : null,
            };
          });
          prevNet.current[sub.id] = {
            at,
            rx: net.receivedBytes,
            tx: net.sentBytes,
            interfaces: new Map(interfaces.map((i) => [i.name, { rx: i.receivedBytes, tx: i.sentBytes }])),
          };
        }

        setStates((s) => {
          const old = s[sub.id] ?? emptyState();
          return {
            ...s,
            [sub.id]: {
              status: "online",
              error: null,
              offlineSince: null,
              info,
              metrics,
              netRxRate,
              netTxRate,
              interfaceRates,
              cpuHistory: pushHistory(old.cpuHistory, metrics.cpu?.usagePercent ?? null),
              memHistory: pushHistory(old.memHistory, metrics.memory?.usagePercent ?? null),
              netRxHistory: pushHistory(old.netRxHistory, netRxRate),
              netTxHistory: pushHistory(old.netTxHistory, netTxRate),
              lastUpdated: Date.now(),
            },
          };
        });
      } catch (e) {
        if (cancelled) return;
        delete prevNet.current[sub.id];
        delete infoCache.current[sub.id];
        setStates((s) => {
          const old = s[sub.id] ?? emptyState();
          return {
            ...s,
            [sub.id]: {
              ...old,
              status: "offline",
              error: String(e),
              offlineSince: old.offlineSince ?? Date.now(),
            },
          };
        });
      } finally {
        inFlight.current.delete(sub.id);
      }
    }

    const tick = () => subscriptions.forEach(poll);
    tick();
    const timer = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [subscriptions]);

  const addSubscription = useCallback((name: string, url: string, token: string): Subscription => {
    const normalized = normalizeUrl(url);
    const sub: Subscription = {
      id: crypto.randomUUID(),
      name: name.trim() || normalized.replace(/^https?:\/\//i, ""),
      url: normalized,
      token: token.trim(),
    };
    setSubscriptions((subs) => [...subs, sub]);
    return sub;
  }, []);

  const setToken = useCallback((id: string, token: string) => {
    setSubscriptions((subs) => subs.map((s) => (s.id === id ? { ...s, token: token.trim() } : s)));
  }, []);

  const removeSubscription = useCallback((id: string) => {
    setSubscriptions((subs) => subs.filter((s) => s.id !== id));
    setStates(({ [id]: _removed, ...rest }) => rest);
    delete prevNet.current[id];
    delete infoCache.current[id];
  }, []);

  const getState = useCallback((id: string) => states[id] ?? emptyState(), [states]);

  return { subscriptions, getState, addSubscription, setToken, removeSubscription };
}

/**
 * Polls one agent endpoint while mounted (used for views that are only
 * needed while open, like processes and connections). `refresh` polls now.
 */
export function useAgentPoll<T>(sub: Subscription, path: string, intervalMs: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    async function poll() {
      if (inFlight) return;
      inFlight = true;
      try {
        const res = await fetchAgent<T>(sub, path);
        if (!cancelled) {
          setData(res);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        inFlight = false;
      }
    }
    poll();
    const timer = setInterval(poll, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sub, path, intervalMs, tick]);

  return { data, error, refresh: () => setTick((t) => t + 1) };
}

/** Top processes of the agent being viewed. */
export function useProcesses(sub: Subscription, sort: "cpu" | "memory") {
  const { data, error } = useAgentPoll<ProcessesResponse>(
    sub,
    `/api/v1/metrics/processes?sort=${sort}&limit=10`,
    PROCESS_POLL_MS,
  );
  return { processes: data, error };
}
