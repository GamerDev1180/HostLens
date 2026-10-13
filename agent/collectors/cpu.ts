import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import type { CpuMetrics } from '../types.ts';

// os.cpus() works the same on every platform, so CPU usage is shared rather than
// per-platform. Its times are cumulative since boot, so usage is the delta
// between two snapshots: we keep only the previous snapshot, not a history.

interface Snapshot {
    at: number;
    cores: { busy: number; total: number }[];
}

/** Shortest window usage is computed over; faster polls reuse the last result. */
const MIN_WINDOW_MS = 250;

let previous: Snapshot | null = null;
let latest: Omit<CpuMetrics, 'loadAverage'> | null = null;

function snapshot(): Snapshot {
    return {
        at: Date.now(),
        cores: os.cpus().map(({ times: t }) => {
            const total = t.user + t.nice + t.sys + t.idle + t.irq;
            return { busy: total - t.idle, total };
        }),
    };
}

const percent = (busy: number, total: number) =>
    total > 0 ? Math.round(Math.min(100, Math.max(0, (busy / total) * 100)) * 100) / 100 : 0;

function loadAverage(): CpuMetrics['loadAverage'] {
    if (process.platform === 'win32') return null;
    const [one = 0, five = 0, fifteen = 0] = os.loadavg();
    return [one, five, fifteen];
}

export async function sampleCpu(): Promise<CpuMetrics> {
    previous ??= snapshot();

    const wait = previous.at + MIN_WINDOW_MS - Date.now();
    if (wait > 0) {
        if (latest) return { ...latest, loadAverage: loadAverage() };
        // First request: there's nothing to diff against yet.
        await delay(wait);
    }

    const current = snapshot();
    const prev = previous.cores.length === current.cores.length ? previous.cores : null;
    const deltas = current.cores.map((core, i) => ({
        busy: core.busy - (prev?.[i]?.busy ?? 0),
        total: core.total - (prev?.[i]?.total ?? 0),
    }));
    const sum = deltas.reduce((acc, d) => ({ busy: acc.busy + d.busy, total: acc.total + d.total }), {
        busy: 0,
        total: 0,
    });

    previous = current;
    latest = {
        usagePercent: percent(sum.busy, sum.total),
        logicalCores: current.cores.length,
        perCorePercent: deltas.map((d) => percent(d.busy, d.total)),
    };
    return { ...latest, loadAverage: loadAverage() };
}
