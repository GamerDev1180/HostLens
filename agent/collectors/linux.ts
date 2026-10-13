import { execFile } from 'node:child_process';
import { readdir, readFile, readlink } from 'node:fs/promises';
import os from 'node:os';
import { promisify } from 'node:util';
import type { DiskMetrics, MemoryMetrics, NetworkMetrics, TcpState } from '../types.ts';
import type { RawSockets } from './connections.ts';
import { diskAt, isDisk, memoryFrom, nodeMemory, swapFrom, type PlatformCollector, type RawProcess } from './common.ts';

// Linux exposes everything we need as text files under /proc and /etc,
// all readable by an unprivileged user. The parsers are pure functions so
// they can be tested against sample file contents on any OS.

const run = promisify(execFile);

export function parseOsRelease(text: string): string | null {
    const pretty = /^PRETTY_NAME=(.*)$/m.exec(text)?.[1];
    return pretty ? pretty.replace(/^["']|["']$/g, '') : null;
}

export function parseMeminfo(text: string): MemoryMetrics | null {
    // Values are in kB. MemAvailable (kernel 3.14+) accounts for reclaimable cache.
    const field = (name: string) => {
        const kb = new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(text)?.[1];
        return kb === undefined ? undefined : Number(kb) * 1024;
    };
    const total = field('MemTotal');
    const available = field('MemAvailable');
    if (total === undefined || available === undefined) return null;
    return memoryFrom(total, available, swapFrom(field('SwapTotal') ?? 0, field('SwapFree') ?? 0));
}

// Mount points in /proc/mounts escape spaces, tabs, newlines and backslashes as octal.
const unescapeMount = (s: string) =>
    s.replace(/\\([0-7]{3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)));

// Read-only images that are always 100% full and would only add noise.
const IGNORED_FS_TYPES = new Set(['squashfs', 'iso9660', 'erofs']);

/** Mount points of real filesystems, one per device. */
export function parseMounts(text: string): string[] {
    const seenDevices = new Set<string>();
    const targets: string[] = [];
    for (const line of text.split('\n')) {
        const [device, mountPoint, fsType] = line.split(' ');
        if (!device || !mountPoint || !fsType) continue;
        // Real block devices (/dev/sda1, /dev/mapper/…) and network shares (host:/path, //host/share);
        // this skips pseudo filesystems like proc, sysfs, tmpfs and cgroup.
        const isBlock = device.startsWith('/dev/');
        const isNetwork = device.includes(':/') || device.startsWith('//');
        if ((!isBlock && !isNetwork) || IGNORED_FS_TYPES.has(fsType)) continue;
        // Bind mounts and btrfs subvolumes show the same device several times.
        if (seenDevices.has(device)) continue;
        seenDevices.add(device);
        targets.push(unescapeMount(mountPoint));
    }
    return targets;
}

export function parseNetDev(text: string): NetworkMetrics {
    const interfaces = [];
    // Two header lines, then "iface: rx_bytes rx_packets … (8 rx fields) tx_bytes …".
    for (const line of text.split('\n').slice(2)) {
        const sep = line.indexOf(':');
        if (sep === -1) continue;
        const name = line.slice(0, sep).trim();
        if (name === 'lo') continue;
        const fields = line.slice(sep + 1).trim().split(/\s+/).map(Number);
        interfaces.push({ name, receivedBytes: fields[0] ?? 0, sentBytes: fields[8] ?? 0 });
    }
    return {
        receivedBytes: interfaces.reduce((sum, i) => sum + i.receivedBytes, 0),
        sentBytes: interfaces.reduce((sum, i) => sum + i.sentBytes, 0),
        interfaces,
    };
}

/**
 * Parses /proc/<pid>/stat. The command name is in parentheses and may itself
 * contain spaces or parentheses, so fields are counted from the last ')'.
 */
export function parseProcStat(text: string, clockTicks: number, pageSize: number): RawProcess | null {
    const open = text.indexOf('(');
    const close = text.lastIndexOf(')');
    if (open === -1 || close < open) return null;
    const pid = Number(text.slice(0, open));
    // After ')': state(3) ppid(4) … utime(14) stime(15) … rss(24); index 0 here is field 3.
    const rest = text.slice(close + 2).split(' ');
    const utime = Number(rest[11]);
    const stime = Number(rest[12]);
    const rss = Number(rest[21]);
    if (!Number.isFinite(pid) || !Number.isFinite(utime) || !Number.isFinite(stime)) return null;
    return {
        pid,
        name: text.slice(open + 1, close),
        cpuMs: ((utime + stime) / clockTicks) * 1000,
        memoryBytes: Number.isFinite(rss) ? rss * pageSize : 0,
    };
}

async function getconf(name: string, fallback: number): Promise<number> {
    try {
        const value = Number((await run('getconf', [name])).stdout.trim());
        return value > 0 ? value : fallback;
    } catch {
        return fallback;
    }
}

// Kernel constants needed to convert /proc/<pid>/stat units; read once.
let units: Promise<{ clockTicks: number; pageSize: number }> | null = null;

async function processes(): Promise<RawProcess[] | null> {
    units ??= Promise.all([getconf('CLK_TCK', 100), getconf('PAGESIZE', 4096)]).then(([clockTicks, pageSize]) => ({
        clockTicks,
        pageSize,
    }));
    const { clockTicks, pageSize } = await units;
    let entries: string[];
    try {
        entries = (await readdir('/proc')).filter((e) => /^\d+$/.test(e));
    } catch {
        return null;
    }
    const list = await Promise.all(
        entries.map((pid) =>
            readFile(`/proc/${pid}/stat`, 'utf8')
                .then((text) => parseProcStat(text, clockTicks, pageSize))
                // The process exited between readdir and readFile.
                .catch(() => null),
        ),
    );
    return list.filter((p): p is RawProcess => p !== null);
}

async function disks(): Promise<DiskMetrics[]> {
    let targets: string[];
    try {
        targets = parseMounts(await readFile('/proc/mounts', 'utf8'));
    } catch {
        targets = ['/'];
    }
    return (await Promise.all(targets.map((m) => diskAt(m, m)))).filter(isDisk);
}

const TCP_STATES: Record<string, TcpState> = {
    '01': 'established',
    '02': 'syn_sent',
    '03': 'syn_received',
    '04': 'fin_wait',
    '05': 'fin_wait',
    '06': 'time_wait',
    '07': 'closed',
    '08': 'close_wait',
    '09': 'last_ack',
    '0A': 'listen',
    '0B': 'closing',
};

/**
 * Addresses in /proc/net are hex in host byte order (little-endian on x86/ARM):
 * "0100007F" is 127.0.0.1; IPv6 is four such 32-bit words.
 */
export function decodeHexAddress(hex: string): string {
    const word = (w: string) => w.match(/../g)!.reverse().join('');
    if (hex.length === 8) {
        return word(hex)
            .match(/../g)!
            .map((b) => parseInt(b, 16))
            .join('.');
    }
    const bytes = hex.match(/.{8}/g)!.map(word).join('');
    const groups = bytes.match(/.{4}/g)!.map((g) => parseInt(g, 16));
    // IPv4-mapped (::ffff:a.b.c.d) is shown as plain IPv4.
    if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
        return [groups[6]! >> 8, groups[6]! & 255, groups[7]! >> 8, groups[7]! & 255].join('.');
    }
    return compressIpv6(groups);
}

/** RFC 5952 text form: the longest run of two or more zero groups becomes "::". */
function compressIpv6(groups: number[]): string {
    let best = { start: -1, length: 0 };
    for (let i = 0; i < groups.length; ) {
        if (groups[i] !== 0) {
            i++;
            continue;
        }
        let j = i;
        while (j < groups.length && groups[j] === 0) j++;
        if (j - i > best.length) best = { start: i, length: j - i };
        i = j;
    }
    const hex = groups.map((g) => g.toString(16));
    if (best.length < 2) return hex.join(':');
    return `${hex.slice(0, best.start).join(':')}::${hex.slice(best.start + best.length).join(':')}`;
}

export interface ProcNetEntry {
    localAddress: string;
    localPort: number;
    remoteAddress: string;
    remotePort: number;
    /** Hex state code ("0A" = listen). */
    state: string;
    inode: string;
}

/** Parses /proc/net/{tcp,tcp6,udp,udp6}. */
export function parseProcNet(text: string): ProcNetEntry[] {
    const entries: ProcNetEntry[] = [];
    for (const line of text.split('\n').slice(1)) {
        const f = line.trim().split(/\s+/);
        if (f.length < 10) continue;
        const [localHex, localPortHex] = f[1]!.split(':');
        const [remoteHex, remotePortHex] = f[2]!.split(':');
        if (!localHex || !remoteHex) continue;
        entries.push({
            localAddress: decodeHexAddress(localHex),
            localPort: parseInt(localPortHex ?? '0', 16),
            remoteAddress: decodeHexAddress(remoteHex),
            remotePort: parseInt(remotePortHex ?? '0', 16),
            state: f[3]!.toUpperCase(),
            inode: f[9]!,
        });
    }
    return entries;
}

/**
 * Maps socket inodes to their process by reading /proc/<pid>/fd links. As a
 * normal user only our own processes are readable; other sockets stay
 * without an owner rather than needing root.
 */
async function socketOwners(): Promise<Map<string, { pid: number; processName: string | null }>> {
    const owners = new Map<string, { pid: number; processName: string | null }>();
    const pids = (await readdir('/proc').catch(() => [] as string[])).filter((e) => /^\d+$/.test(e));
    await Promise.all(
        pids.map(async (pid) => {
            const fds = await readdir(`/proc/${pid}/fd`).catch(() => null);
            if (!fds) return;
            const links = await Promise.all(fds.map((fd) => readlink(`/proc/${pid}/fd/${fd}`).catch(() => '')));
            const inodes = links.map((l) => /^socket:\[(\d+)\]$/.exec(l)?.[1]).filter((i): i is string => !!i);
            if (!inodes.length) return;
            const name = (await readFile(`/proc/${pid}/comm`, 'utf8').catch(() => '')).trim() || null;
            for (const inode of inodes) owners.set(inode, { pid: Number(pid), processName: name });
        }),
    );
    return owners;
}

async function sockets(): Promise<RawSockets | null> {
    const read = (name: string) => readFile(`/proc/net/${name}`, 'utf8').then(parseProcNet, () => []);
    const [tcp4, tcp6, udp4, udp6, owners] = await Promise.all([
        read('tcp'),
        read('tcp6'),
        read('udp'),
        read('udp6'),
        socketOwners(),
    ]);
    if (!tcp4.length && !tcp6.length) return null;
    const owner = (inode: string) => owners.get(inode) ?? { pid: null, processName: null };
    return {
        tcp: [...tcp4, ...tcp6]
            .filter((e) => e.state in TCP_STATES)
            .map((e) => ({
                localAddress: e.localAddress,
                localPort: e.localPort,
                remoteAddress: e.remoteAddress,
                remotePort: e.remotePort,
                state: TCP_STATES[e.state]!,
                ...owner(e.inode),
            })),
        // A UDP socket without a remote end is a bound/listening port; connected ones are skipped.
        udp: [...udp4, ...udp6]
            .filter((e) => e.remotePort === 0)
            .map((e) => ({ address: e.localAddress, port: e.localPort, ...owner(e.inode) })),
    };
}

export const linux: PlatformCollector = {
    osName: async () => {
        const name = await readFile('/etc/os-release', 'utf8').then(parseOsRelease, () => null);
        return name ?? os.version();
    },
    memory: async () => {
        const memory = await readFile('/proc/meminfo', 'utf8').then(parseMeminfo, () => null);
        return memory ?? nodeMemory();
    },
    disks,
    network: () => readFile('/proc/net/dev', 'utf8').then(parseNetDev, () => null),
    processes,
    sockets,
};
