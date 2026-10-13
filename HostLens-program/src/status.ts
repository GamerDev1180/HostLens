import type { Tone } from "./components/ui/common";
import type { AgentState, CheckKind, CheckState } from "./types";

export const agentTone = (s: AgentState): Tone =>
  s.status === "online" ? "ok" : s.status === "offline" ? "bad" : "warn";

export const AGENT_STATUS_LABEL = { connecting: "Connecting", online: "Online", offline: "Offline" };

export const checkTone = (s: CheckState): Tone =>
  s.status === "up" ? "ok" : s.status === "down" ? "bad" : "idle";

export const CHECK_STATUS_LABEL = { pending: "Pending", up: "Up", down: "Down" };

export const KIND_LABEL: Record<CheckKind, string> = { fivem: "FiveM", http: "HTTP", tcp: "TCP" };

/** Busiest disk's usage, for summaries. */
export const peakDisk = (s: AgentState) =>
  s.metrics?.disk?.length ? Math.max(...s.metrics.disk.map((d) => d.usagePercent)) : null;
