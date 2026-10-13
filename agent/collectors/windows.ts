import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import type { DiskMetrics, NetworkMetrics, SwapMetrics } from '../types.ts';
import { diskAt, isDisk, nodeMemory, swapFrom, type PlatformCollector, type RawProcess } from './common.ts';
import { runJson } from './powershell.ts';
import type { RawSockets } from './connections.ts';
import type { TcpState } from '../types.ts';

const run = promisify(execFile);

const DRIVE_LETTERS = Array.from({ length: 26 }, (_, i) => `${String.fromCharCode(65 + i)}:`);
const DRIVE_RESCAN_MS = 30_000;

// Probing all 26 letters on every poll is wasteful, so remember which ones
// exist and rescan occasionally to pick up new or removed drives.
let drives: { letters: string[]; at: number } | null = null;

async function disks(): Promise<DiskMetrics[]> {
    if (!drives || Date.now() - drives.at > DRIVE_RESCAN_MS) {
        const found = (await Promise.all(DRIVE_LETTERS.map((l) => diskAt(`${l}\\`, l)))).filter(isDisk);
        drives = { letters: found.map((d) => d.mount), at: Date.now() };
        return found;
    }
    return (await Promise.all(drives.letters.map((l) => diskAt(`${l}\\`, l)))).filter(isDisk);
}

// Page file size barely changes, so it's refreshed in the background at most
// this often and the last value is served in between.
const SWAP_REFRESH_MS = 10_000;
let swap: { value: SwapMetrics | null; at: number } | null = null;
let swapRefresh: Promise<void> | null = null;

function refreshSwap(): Promise<void> {
    swapRefresh ??= runJson<{ AllocatedBaseSize: number; CurrentUsage: number }[]>(
        'ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_PageFileUsage | Select-Object AllocatedBaseSize,CurrentUsage)',
    )
        .then((files) => {
            // Sizes are in MB; a machine can have several page files.
            const mb = 1024 * 1024;
            const total = (files ?? []).reduce((sum, f) => sum + f.AllocatedBaseSize * mb, 0);
            const used = (files ?? []).reduce((sum, f) => sum + f.CurrentUsage * mb, 0);
            swap = { value: swapFrom(total, total - used), at: Date.now() };
        })
        .finally(() => {
            swapRefresh = null;
        });
    return swapRefresh;
}

async function memory() {
    if (!swap) await refreshSwap();
    else if (Date.now() - swap.at > SWAP_REFRESH_MS) void refreshSwap();
    // os.freemem() is the OS's "available" physical memory on Windows.
    return nodeMemory(swap?.value ?? null);
}

/** Parses `netstat -e`: the first row with two numbers is the byte counters, whatever the UI language. */
export function parseNetstat(text: string): NetworkMetrics | null {
    for (const line of text.split(/\r?\n/)) {
        const match = /^\S.*?\s+(\d+)\s+(\d+)\s*$/.exec(line);
        if (match) return { receivedBytes: Number(match[1]), sentBytes: Number(match[2]), interfaces: [] };
    }
    return null;
}

// Get-NetAdapterStatistics has 64-bit, per-adapter counters. `netstat -e` is
// the fallback if PowerShell is unavailable, but its counters are 32-bit and
// wrap every 4 GiB.
async function network(): Promise<NetworkMetrics | null> {
    const adapters = await runJson<{ Name: string; ReceivedBytes: number; SentBytes: number }[]>(
        'ConvertTo-Json -Compress -InputObject @(Get-NetAdapterStatistics | Select-Object Name,ReceivedBytes,SentBytes)',
    );
    if (adapters?.length) {
        const interfaces = adapters.map((a) => ({ name: a.Name, receivedBytes: a.ReceivedBytes, sentBytes: a.SentBytes }));
        return {
            receivedBytes: interfaces.reduce((sum, i) => sum + i.receivedBytes, 0),
            sentBytes: interfaces.reduce((sum, i) => sum + i.sentBytes, 0),
            interfaces,
        };
    }
    try {
        const { stdout } = await run('netstat', ['-e'], { timeout: 2000, windowsHide: true });
        return parseNetstat(stdout);
    } catch {
        return null;
    }
}

async function processes(): Promise<RawProcess[] | null> {
    // CPU time is null for processes an unprivileged user can't open (system services).
    const list = await runJson<{ Id: number; ProcessName: string; Cpu: number | null; WorkingSet64: number }[]>(
        "ConvertTo-Json -Compress -InputObject @(Get-Process | Select-Object Id,ProcessName,@{n='Cpu';e={$_.TotalProcessorTime.TotalMilliseconds}},WorkingSet64)",
    );
    if (!list) return null;
    return list
        .filter((p) => p.Id !== 0) // the "Idle" pseudo-process
        .map((p) => ({ pid: p.Id, name: p.ProcessName, cpuMs: p.Cpu ?? null, memoryBytes: p.WorkingSet64 }));
}

const TCP_STATES: Record<string, TcpState> = {
    Listen: 'listen',
    Established: 'established',
    SynSent: 'syn_sent',
    SynReceived: 'syn_received',
    FinWait1: 'fin_wait',
    FinWait2: 'fin_wait',
    CloseWait: 'close_wait',
    Closing: 'closing',
    LastAck: 'last_ack',
    TimeWait: 'time_wait',
};

interface PsSocket {
    LocalAddress: string;
    LocalPort: number;
    RemoteAddress?: string;
    RemotePort?: number;
    State?: string;
    Pid: number;
    Name: string | null;
}

// Get-NetTCPConnection reports state as an enum, so names are the same in
// every UI language (netstat's state column is translated). "Bound" sockets
// (allocated, not yet connected) are skipped as noise.
const SOCKETS_COMMAND = [
    '$p = @{}; foreach ($x in Get-Process) { $p[$x.Id] = $x.ProcessName }',
    "$t = @(Get-NetTCPConnection | Where-Object { $_.State -ne 'Bound' } | Select-Object LocalAddress,LocalPort,RemoteAddress,RemotePort,@{n='State';e={[string]$_.State}},@{n='Pid';e={[int]$_.OwningProcess}},@{n='Name';e={$p[[int]$_.OwningProcess]}})",
    "$u = @(Get-NetUDPEndpoint | Select-Object LocalAddress,LocalPort,@{n='Pid';e={[int]$_.OwningProcess}},@{n='Name';e={$p[[int]$_.OwningProcess]}})",
    'ConvertTo-Json -Compress -Depth 3 -InputObject @{ tcp = $t; udp = $u }',
].join('; ');

/** PID 0 is the "Idle"/TIME_WAIT placeholder, not a real owner. */
const owner = (s: PsSocket) => (s.Pid > 0 ? { pid: s.Pid, processName: s.Name ?? null } : { pid: null, processName: null });

export function parseSockets(raw: { tcp?: PsSocket[] | null; udp?: PsSocket[] | null }): RawSockets {
    return {
        tcp: (raw.tcp ?? [])
            .filter((s) => s.State && s.State in TCP_STATES)
            .map((s) => ({
                localAddress: s.LocalAddress,
                localPort: s.LocalPort,
                remoteAddress: s.RemoteAddress ?? '',
                remotePort: s.RemotePort ?? 0,
                state: TCP_STATES[s.State!]!,
                ...owner(s),
            })),
        udp: (raw.udp ?? []).map((s) => ({ address: s.LocalAddress, port: s.LocalPort, ...owner(s) })),
    };
}

async function sockets(): Promise<RawSockets | null> {
    const raw = await runJson<{ tcp?: PsSocket[]; udp?: PsSocket[] }>(SOCKETS_COMMAND);
    return raw ? parseSockets(raw) : null;
}

export const windows: PlatformCollector = {
    // e.g. "Windows 11 Pro"
    osName: async () => os.version(),
    memory,
    disks,
    network,
    processes,
    sockets,
};
