import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import type { ProcessMetrics } from '../types.ts';
import { round2, type RawProcess } from './common.ts';

// Like CPU usage, per-process CPU % is the delta between two snapshots of
// cumulative CPU time. Only the previous snapshot is kept.

interface Snapshot {
    at: number;
    /** Keyed by pid + name so a recycled pid isn't diffed against another process. */
    cpuMs: Map<string, number | null>;
}

const MIN_WINDOW_MS = 500;

let previous: Snapshot | null = null;
let latest: ProcessMetrics[] | null = null;

const key = (p: RawProcess) => `${p.pid}:${p.name}`;

function snapshot(at: number, processes: RawProcess[]): Snapshot {
    return { at, cpuMs: new Map(processes.map((p) => [key(p), p.cpuMs])) };
}

/** All processes with CPU % since the previous call; `null` if the platform can't list them. */
export async function sampleProcesses(list: () => Promise<RawProcess[] | null>): Promise<ProcessMetrics[] | null> {
    if (!previous) {
        // First request: take a baseline to diff against.
        const baseline = await list();
        if (!baseline) return null;
        previous = snapshot(Date.now(), baseline);
        await delay(MIN_WINDOW_MS);
    } else if (latest && Date.now() - previous.at < MIN_WINDOW_MS) {
        return latest;
    }

    const at = Date.now();
    const processes = await list();
    if (!processes) return null;

    const capacityMs = (at - previous.at) * os.availableParallelism();
    const before = previous.cpuMs;
    latest = processes.map((p) => {
        const prev = before.get(key(p));
        // A process that started since the last sample has used all its CPU time within the window.
        const delta = p.cpuMs === null ? null : p.cpuMs - (prev === undefined ? 0 : (prev ?? p.cpuMs));
        return {
            pid: p.pid,
            name: p.name,
            cpuPercent:
                delta === null || capacityMs <= 0 ? null : round2(Math.min(100, Math.max(0, (delta / capacityMs) * 100))),
            memoryBytes: p.memoryBytes,
        };
    });
    previous = snapshot(at, processes);
    return latest;
}
