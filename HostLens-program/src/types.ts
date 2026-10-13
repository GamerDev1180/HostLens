// The agent's response types live in the agent itself so the two stay in sync.
import type { AgentInfo, MetricsResponse } from "../../agent/types";
import type { FiveMStatus } from "./fivem";

export type {
  AgentInfo,
  CpuMetrics,
  DiskMetrics,
  MemoryMetrics,
  MetricsResponse,
  NetworkInterfaceMetrics,
  NetworkMetrics,
  ProcessMetrics,
  ProcessesResponse,
  SwapMetrics,
} from "../../agent/types";

// An agent the user has subscribed to.
export interface Subscription {
  id: string;
  name: string;
  url: string;
  /** API token printed by the agent on startup. Missing for subscriptions saved before auth existed. */
  token?: string;
}

export type AgentStatus = "connecting" | "online" | "offline";

export interface InterfaceRate {
  name: string;
  /** Bytes/s; `null` until there are two samples. */
  rxRate: number | null;
  txRate: number | null;
}

// Live state derived from polling a subscription.
export interface AgentState {
  status: AgentStatus;
  error: string | null;
  /** When the agent was first seen offline in the current outage. */
  offlineSince: number | null;
  info: AgentInfo | null;
  metrics: MetricsResponse | null;
  /** Network throughput in bytes/s, from the delta between the last two samples. */
  netRxRate: number | null;
  netTxRate: number | null;
  interfaceRates: InterfaceRate[];
  cpuHistory: number[];
  memHistory: number[];
  /** Total network throughput history, bytes/s. */
  netRxHistory: number[];
  netTxHistory: number[];
  lastUpdated: number | null;
}

// Monitors (service checks) run by the desktop app itself, from Rust.
export type CheckKind = "http" | "tcp" | "fivem";

export interface ServiceCheck {
  id: string;
  name: string;
  kind: CheckKind;
  /** URL for HTTP, host:port for TCP, base URL (http://ip:30120) for FiveM. */
  target: string;
  /** FiveM servers added by cfx.re/join code: re-resolved if the address stops answering. */
  joinCode?: string;
  intervalSeconds: number;
  /** Missing on checks created before reports existed. */
  createdAt?: number;
}

export interface CheckResult {
  at: number;
  ok: boolean;
  latencyMs: number | null;
  /** "HTTP 200", "connected", "61/64 players", or the error. */
  detail: string;
  /** FiveM only. */
  players?: number;
}

export type CheckStatus = "pending" | "up" | "down";

export interface CheckState {
  status: CheckStatus;
  /** When the check first failed in the current outage. */
  downSince: number | null;
  /** Length of the outage that just ended; set on recovery, for alert messages. */
  lastDowntimeMs: number | null;
  history: CheckResult[];
  /** Latest FiveM data, kept while the server is down so the last state stays visible. */
  fivem: FiveMStatus | null;
}

/** Per-hour aggregate of a check's results, for uptime reports. */
export interface HourBucket {
  /** Start of the hour, ms since epoch. */
  hour: number;
  up: number;
  down: number;
  latencySum: number;
  latencyCount: number;
  /** FiveM: highest player count seen this hour. */
  peakPlayers?: number;
}

export interface Incident {
  id: string;
  startedAt: number;
  /** `null` while the outage is ongoing. */
  endedAt: number | null;
  cause: string;
  /** The app was closed when it ended, so `endedAt` is an upper bound. */
  approximate?: boolean;
}

/** Persisted history of a check, kept across restarts. */
export interface CheckReport {
  buckets: HourBucket[];
  incidents: Incident[];
  /** Time of the last result, to close outages that ended while the app was closed. */
  lastResultAt: number | null;
}

// Alerts
export type AlertRuleKind = "agentOffline" | "cpuHigh" | "memoryHigh" | "diskFull" | "checkDown";

export interface AlertRule {
  enabled: boolean;
  /** Percentage threshold; unused by agentOffline and checkDown. */
  threshold: number;
  /** How long the condition must hold before the alert fires. */
  forSeconds: number;
}

export interface AlertSettings {
  discordWebhookUrl: string;
  rules: Record<AlertRuleKind, AlertRule>;
}

export interface Alert {
  id: string;
  /** Identifies the rule + target, e.g. "diskFull:<agentId>:C:". */
  key: string;
  kind: AlertRuleKind;
  /** Agent or check name, plus the disk for diskFull. */
  target: string;
  message: string;
  startedAt: number;
  resolvedAt: number | null;
  acknowledged: boolean;
}
