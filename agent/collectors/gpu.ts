import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GpuMetrics } from '../types.ts';

// NVIDIA GPUs via nvidia-smi, which ships with the driver on Windows and Linux
// and needs no admin rights. A call takes ~100 ms, so samples are refreshed in
// the background at most every REFRESH_MS and /metrics returns the latest one
// without waiting.

const run = promisify(execFile);

const REFRESH_MS = 2000;
/** When nvidia-smi is missing (no NVIDIA card or driver), look again this rarely. */
const RETRY_MISSING_MS = 5 * 60_000;

const FIELDS = [
    'index',
    'name',
    'utilization.gpu',
    'memory.total',
    'memory.used',
    'temperature.gpu',
    'power.draw',
    'power.limit',
    'fan.speed',
    'clocks.gr',
    'clocks.mem',
    'driver_version',
] as const;

const MIB = 1024 * 1024;

/** "[N/A]", "[Not Supported]" and empty values become null. */
function num(value: string | undefined): number | null {
    if (value === undefined) return null;
    const n = Number(value.trim());
    return value.trim() !== '' && Number.isFinite(n) ? n : null;
}

/** Parses `nvidia-smi --query-gpu=<FIELDS> --format=csv,noheader,nounits`. */
export function parseNvidiaSmi(csv: string): GpuMetrics[] {
    const gpus: GpuMetrics[] = [];
    for (const line of csv.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const f = line.split(',').map((v) => v.trim());
        if (f.length < FIELDS.length) continue;
        const total = num(f[3]);
        const used = num(f[4]);
        gpus.push({
            index: num(f[0]) ?? gpus.length,
            name: f[1] ?? 'NVIDIA GPU',
            vendor: 'nvidia',
            utilizationPercent: num(f[2]),
            memoryTotalBytes: total === null ? null : total * MIB,
            memoryUsedBytes: used === null ? null : used * MIB,
            temperatureC: num(f[5]),
            powerDrawW: num(f[6]),
            powerLimitW: num(f[7]),
            fanPercent: num(f[8]),
            coreClockMhz: num(f[9]),
            memoryClockMhz: num(f[10]),
            driverVersion: f[11] && !f[11].startsWith('[') ? f[11] : null,
        });
    }
    return gpus;
}

let latest: GpuMetrics[] = [];
let sampledAt = 0;
let missingSince: number | null = null;
let refreshing: Promise<void> | null = null;

function refresh(): Promise<void> {
    refreshing ??= run('nvidia-smi', [`--query-gpu=${FIELDS.join(',')}`, '--format=csv,noheader,nounits'], {
        timeout: 5000,
        windowsHide: true,
    })
        .then(
            ({ stdout }) => {
                latest = parseNvidiaSmi(stdout);
                missingSince = null;
            },
            (e: NodeJS.ErrnoException) => {
                latest = [];
                // Not installed: stop calling it every 2 s. Other failures (driver hiccup) retry normally.
                if (e.code === 'ENOENT') missingSince = Date.now();
            },
        )
        .finally(() => {
            sampledAt = Date.now();
            refreshing = null;
        });
    return refreshing;
}

/** Latest GPU sample; the first call waits for it, later calls never block. */
export async function sampleGpus(): Promise<GpuMetrics[]> {
    const now = Date.now();
    if (missingSince !== null && now - missingSince < RETRY_MISSING_MS) return [];
    if (sampledAt === 0) await refresh();
    else if (now - sampledAt > REFRESH_MS) void refresh();
    return latest;
}
