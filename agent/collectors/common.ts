import { statfs } from 'node:fs/promises';
import os from 'node:os';
import type { DiskMetrics, MemoryMetrics, NetworkMetrics, SwapMetrics } from '../types.ts';
import type { RawSockets } from './connections.ts';

// What each platform module must provide. Metrics that are read the same way
// everywhere (CPU, uptime, hostname…) live outside these modules.
export interface PlatformCollector {
    osName(): Promise<string>;
    memory(): Promise<MemoryMetrics>;
    disks(): Promise<DiskMetrics[]>;
    /** `null` when the platform has no supported source of network counters. */
    network(): Promise<NetworkMetrics | null>;
    /** Every running process with its cumulative CPU time; `null` if unsupported. */
    processes(): Promise<RawProcess[] | null>;
    /** TCP sockets and UDP endpoints with their owning process; `null` if unsupported. */
    sockets(): Promise<RawSockets | null>;
}

export interface RawProcess {
    pid: number;
    name: string;
    /** CPU time used since the process started, in ms; `null` if it can't be read. */
    cpuMs: number | null;
    memoryBytes: number;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

function usage(totalBytes: number, freeBytes: number) {
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    return {
        totalBytes,
        usedBytes,
        usagePercent: totalBytes > 0 ? round2((usedBytes / totalBytes) * 100) : 0,
    };
}

export const memoryFrom = (totalBytes: number, availableBytes: number, swap: SwapMetrics | null): MemoryMetrics => ({
    ...usage(totalBytes, availableBytes),
    swap,
});

/** `null` when no swap is configured. */
export const swapFrom = (totalBytes: number, freeBytes: number): SwapMetrics | null =>
    totalBytes > 0 ? usage(totalBytes, freeBytes) : null;

export const nodeMemory = (swap: SwapMetrics | null = null) => memoryFrom(os.totalmem(), os.freemem(), swap);

const STATFS_TIMEOUT_MS = 1000;

/**
 * Size of the filesystem at `path`, or `null` if it can't be read (no media,
 * permission denied, unresponsive network share…).
 */
export async function diskAt(path: string, mount: string): Promise<DiskMetrics | null> {
    let timer: NodeJS.Timeout | undefined;
    try {
        const s = await Promise.race([
            statfs(path),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('statfs timed out')), STATFS_TIMEOUT_MS);
            }),
        ]);
        const totalBytes = s.blocks * s.bsize;
        if (totalBytes <= 0) return null;
        const usedBytes = (s.blocks - s.bfree) * s.bsize;
        const freeBytes = s.bavail * s.bsize;
        // Same formula as `df`: blocks reserved for root count as neither used nor free.
        const usable = usedBytes + freeBytes;
        return {
            mount,
            totalBytes,
            usedBytes,
            freeBytes,
            usagePercent: usable > 0 ? round2((usedBytes / usable) * 100) : 0,
        };
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

export const isDisk = (d: DiskMetrics | null): d is DiskMetrics => d !== null;
