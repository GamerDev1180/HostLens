import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { loadJson, saveJson } from "./storage";
import { parseFiveMAddress, parseStatus, type FiveMInfo, type FiveMRaw } from "./fivem";
import { emptyReport, recordResult } from "./reports";
import type { CheckKind, CheckReport, CheckResult, CheckState, ServiceCheck } from "./types";

const STORAGE_KEY = "hostlens.checks";
const REPORTS_KEY = "hostlens.checkReports";
const CHECK_HISTORY_LENGTH = 60;
/** A check times out after this share of its interval (capped by Rust at 60 s). */
const TIMEOUT_SHARE = 0.8;
/** info.json carries a ~50 KB icon and rarely changes. */
const FIVEM_INFO_REFRESH_MS = 10 * 60_000;
/** How often a join code is looked up again while its server is down (its address may have changed). */
const JOIN_RERESOLVE_MS = 10 * 60_000;

const emptyState = (): CheckState => ({
  status: "pending",
  downSince: null,
  lastDowntimeMs: null,
  history: [],
  fivem: null,
});

/** Returns an error message, or null if the target is valid for the kind. */
export function validateTarget(kind: CheckKind, target: string): string | null {
  if (kind === "fivem") {
    const address = parseFiveMAddress(target);
    return "error" in address ? address.error : null;
  }
  if (kind === "http") {
    try {
      const url = new URL(target);
      return url.protocol === "http:" || url.protocol === "https:"
        ? null
        : "URL must start with http:// or https://";
    } catch {
      return "Enter a full URL, e.g. https://example.com";
    }
  }
  const match = /^(.+):(\d{1,5})$/.exec(target);
  const port = match ? Number(match[2]) : 0;
  return match && port >= 1 && port <= 65535 ? null : "Enter host:port, e.g. db.example.com:5432";
}

interface CfxJoinInfo {
  baseUrl: string;
  hostname: string;
  projectName: string | null;
}

export const resolveJoinCode = (code: string) => invoke<CfxJoinInfo>("resolve_cfx_join", { code });

export function useChecks() {
  const [checks, setChecks] = useState<ServiceCheck[]>(() => loadJson(STORAGE_KEY, [], Array.isArray));
  const [states, setStates] = useState<Record<string, CheckState>>({});
  const [reports, setReports] = useState<Record<string, CheckReport>>(() =>
    loadJson(REPORTS_KEY, {}, (v) => typeof v === "object" && v !== null && !Array.isArray(v)),
  );
  const lastRun = useRef<Record<string, number>>({});
  const inFlight = useRef<Set<string>>(new Set());
  const fivemInfo = useRef<Record<string, { info: FiveMInfo | null; at: number }>>({});
  const lastResolve = useRef<Record<string, number>>({});

  useEffect(() => saveJson(STORAGE_KEY, checks), [checks]);
  useEffect(() => saveJson(REPORTS_KEY, reports), [reports]);

  /** Looks the join code up again if it's been a while; updates the check if the address moved. */
  const maybeReresolve = useCallback(async (check: ServiceCheck) => {
    if (!check.joinCode || Date.now() - (lastResolve.current[check.id] ?? 0) < JOIN_RERESOLVE_MS) return;
    lastResolve.current[check.id] = Date.now();
    try {
      const { baseUrl } = await resolveJoinCode(check.joinCode);
      if (baseUrl !== check.target) {
        setChecks((list) => list.map((c) => (c.id === check.id ? { ...c, target: baseUrl } : c)));
      }
    } catch {
      // Still unresolvable; the check stays down.
    }
  }, []);

  const runOnce = useCallback(
    async (check: ServiceCheck): Promise<{ result: CheckResult; fivem?: ReturnType<typeof parseStatus> }> => {
      const timeoutMs = Math.round(check.intervalSeconds * 1000 * TIMEOUT_SHARE);
      if (check.kind === "fivem") {
        const cached = fivemInfo.current[check.id];
        const includeInfo = !cached || Date.now() - cached.at > FIVEM_INFO_REFRESH_MS;
        const raw = await invoke<FiveMRaw>("fetch_fivem", { baseUrl: check.target, includeInfo, timeoutMs });
        const fivem = parseStatus(raw, cached?.info ?? null);
        if (includeInfo) fivemInfo.current[check.id] = { info: fivem.info, at: Date.now() };
        return {
          result: {
            at: Date.now(),
            ok: true,
            latencyMs: raw.latencyMs,
            detail: `${fivem.clients}/${fivem.maxClients} players`,
            players: fivem.clients,
          },
          fivem,
        };
      }
      const res = await invoke<Omit<CheckResult, "at">>("run_service_check", {
        kind: check.kind,
        target: check.target,
        timeoutMs,
      });
      return { result: { ...res, at: Date.now() } };
    },
    [],
  );

  const runCheck = useCallback(
    async (check: ServiceCheck) => {
      if (inFlight.current.has(check.id)) return;
      inFlight.current.add(check.id);
      lastRun.current[check.id] = Date.now();
      let outcome: Awaited<ReturnType<typeof runOnce>>;
      try {
        outcome = await runOnce(check);
      } catch (e) {
        outcome = { result: { at: Date.now(), ok: false, latencyMs: null, detail: String(e) } };
      } finally {
        inFlight.current.delete(check.id);
      }
      const { result, fivem } = outcome;
      if (!result.ok) void maybeReresolve(check);

      setStates((s) => {
        const old = s[check.id] ?? emptyState();
        return {
          ...s,
          [check.id]: {
            status: result.ok ? "up" : "down",
            downSince: result.ok ? null : (old.downSince ?? result.at),
            lastDowntimeMs: result.ok && old.downSince !== null ? result.at - old.downSince : old.lastDowntimeMs,
            history: [...old.history, result].slice(-CHECK_HISTORY_LENGTH),
            fivem: fivem ?? old.fivem,
          },
        };
      });
      setReports((r) => ({
        ...r,
        [check.id]: recordResult(r[check.id] ?? emptyReport(), result, result.detail),
      }));
    },
    [runOnce, maybeReresolve],
  );

  // One ticker runs every check that's due, so each keeps its own interval.
  useEffect(() => {
    const tick = () => {
      const now = Date.now();
      for (const check of checks) {
        const last = lastRun.current[check.id] ?? 0;
        if (now - last >= check.intervalSeconds * 1000) void runCheck(check);
      }
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [checks, runCheck]);

  const addCheck = useCallback((check: Omit<ServiceCheck, "id" | "createdAt">): ServiceCheck => {
    const created: ServiceCheck = { ...check, id: crypto.randomUUID(), createdAt: Date.now() };
    setChecks((list) => [...list, created]);
    return created;
  }, []);

  const updateCheck = useCallback((id: string, patch: Partial<Omit<ServiceCheck, "id">>) => {
    setChecks((list) => list.map((c) => (c.id === id ? { ...c, ...patch } : c)));
    // Run the edited check on the next tick.
    delete lastRun.current[id];
  }, []);

  const removeCheck = useCallback((id: string) => {
    setChecks((list) => list.filter((c) => c.id !== id));
    setStates(({ [id]: _removed, ...rest }) => rest);
    setReports(({ [id]: _removed, ...rest }) => rest);
    delete lastRun.current[id];
    delete fivemInfo.current[id];
  }, []);

  const getState = useCallback((id: string) => states[id] ?? emptyState(), [states]);
  const getReport = useCallback((id: string) => reports[id] ?? emptyReport(), [reports]);

  return { checks, getState, getReport, addCheck, updateCheck, removeCheck, runCheck };
}
