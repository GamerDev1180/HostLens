import { invoke } from "@tauri-apps/api/core";
import type { Subscription } from "./types";

type Method = "GET" | "POST" | "DELETE";

/**
 * Calls an agent endpoint through the Rust `agent_request` command. Errors are
 * strings starting with the HTTP status ("401 unauthorized") or a network error.
 */
export function agentRequest<T>(
  url: string,
  method: Method,
  path: string,
  token: string | null,
  body?: unknown,
  /** Longer than the default 3 s, for slow calls like traceroute. */
  timeoutMs?: number,
): Promise<T> {
  return invoke<T>("agent_request", { url, method, path, token, body: body ?? null, timeoutMs: timeoutMs ?? null });
}

/** GET with a subscription's token. */
export const fetchAgent = <T>(sub: Subscription, path: string) =>
  agentRequest<T>(sub.url, "GET", path, sub.token ?? null);

/** True if an agent error means the endpoint doesn't exist on that (older) agent or OS. */
export const isUnsupported = (error: string | null) => !!error && /^(404|501)\b/.test(error);

/** True if the agent rejected our token (wrong, or this device was revoked). */
export const isUnauthorized = (error: string | null) => !!error && /^401\b/.test(error);
