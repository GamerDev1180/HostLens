import { promises as dns } from 'node:dns';
import type { ConnectionMetrics, ConnectionScope, ConnectionsResponse, ListeningPort, TcpState } from '../types.ts';

// Shared part of the connections view: platform modules list raw sockets
// (see RawSockets); this classifies addresses, adds reverse-DNS names and
// splits listening sockets from connections.

export interface RawTcp {
    localAddress: string;
    localPort: number;
    remoteAddress: string;
    remotePort: number;
    state: TcpState;
    pid: number | null;
    processName: string | null;
}

export interface RawUdp {
    address: string;
    port: number;
    pid: number | null;
    processName: string | null;
}

export interface RawSockets {
    tcp: RawTcp[];
    udp: RawUdp[];
}

/** "::ffff:1.2.3.4" → "1.2.3.4"; lowercases IPv6. */
export const normalizeIp = (ip: string) => ip.replace(/^::ffff:(?=\d+\.)/i, '').toLowerCase();

export function classify(address: string): ConnectionScope {
    const ip = normalizeIp(address);
    if (ip === '::1' || ip.startsWith('127.') || ip === '0.0.0.0' || ip === '::') return 'loopback';
    if (
        /^(10|127)\./.test(ip) ||
        /^192\.168\./.test(ip) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
        /^169\.254\./.test(ip) ||
        // CGNAT / Tailscale
        /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip) ||
        // IPv6 link-local and unique-local
        /^fe[89ab][0-9a-f]:/.test(ip) ||
        /^f[cd][0-9a-f]{2}:/.test(ip)
    ) {
        return 'lan';
    }
    return 'internet';
}

const isWildcard = (ip: string) => ip === '0.0.0.0' || ip === '::' || ip === '*';

// Reverse DNS is slow and the answers rarely change, so names are cached and
// looked up in the background: a response never waits for DNS, and a name
// shows up on the next poll once it's known.
const DNS_TTL_MS = 30 * 60_000;
const DNS_TIMEOUT_MS = 2000;
const MAX_LOOKUPS_IN_FLIGHT = 16;
const dnsCache = new Map<string, { name: string | null; at: number }>();
const pending = new Map<string, Promise<string | null>>();

function lookup(ip: string): Promise<string | null> {
    const existing = pending.get(ip);
    if (existing) return existing;
    let timer: NodeJS.Timeout | undefined;
    const promise = Promise.race([
        dns.reverse(ip),
        new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('timeout')), DNS_TIMEOUT_MS);
        }),
    ])
        .then(
            (names) => names[0] ?? null,
            () => null,
        )
        .then((name) => {
            dnsCache.set(ip, { name, at: Date.now() });
            return name;
        })
        .finally(() => {
            clearTimeout(timer);
            pending.delete(ip);
        });
    pending.set(ip, promise);
    return promise;
}

/** Cached name, starting a background lookup when unknown or stale. Never waits. */
function cachedName(ip: string): string | null {
    const hit = dnsCache.get(ip);
    if (hit && Date.now() - hit.at < DNS_TTL_MS) return hit.name;
    if (pending.size < MAX_LOOKUPS_IN_FLIGHT) void lookup(ip);
    return hit?.name ?? null;
}

/** Reverse-DNS name of an address, waiting for the lookup (at most ~2 s). Shares the cache. */
export async function reverseLookup(ip: string): Promise<string | null> {
    const hit = dnsCache.get(ip);
    if (hit && Date.now() - hit.at < DNS_TTL_MS) return hit.name;
    return lookup(ip);
}

export function buildConnections(raw: RawSockets): ConnectionsResponse {
    const connections: ConnectionMetrics[] = [];
    const listening: ListeningPort[] = [];

    for (const s of raw.tcp) {
        const local = normalizeIp(s.localAddress);
        if (s.state === 'listen') {
            listening.push({
                protocol: 'tcp',
                address: local,
                port: s.localPort,
                pid: s.pid,
                processName: s.processName,
                exposed: classify(local) !== 'loopback' || isWildcard(local),
            });
            continue;
        }
        const remote = normalizeIp(s.remoteAddress);
        const scope = classify(remote);
        connections.push({
            protocol: 'tcp',
            localAddress: local,
            localPort: s.localPort,
            remoteAddress: remote,
            remotePort: s.remotePort,
            state: s.state,
            pid: s.pid,
            processName: s.processName,
            scope,
            remoteHost: scope === 'loopback' ? null : cachedName(remote),
        });
    }

    for (const s of raw.udp) {
        const local = normalizeIp(s.address);
        listening.push({
            protocol: 'udp',
            address: local,
            port: s.port,
            pid: s.pid,
            processName: s.processName,
            exposed: classify(local) !== 'loopback' || isWildcard(local),
        });
    }

    listening.sort((a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol));
    return { timestamp: new Date().toISOString(), connections, listening };
}
