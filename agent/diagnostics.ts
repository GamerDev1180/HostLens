import { execFile } from 'node:child_process';
import { promises as dns } from 'node:dns';
import { isIP, Socket } from 'node:net';
import { promisify } from 'node:util';
import { classify, reverseLookup } from './collectors/connections.ts';
import type {
    DiagnosticRequest,
    DiagnosticResult,
    DnsResult,
    PingResult,
    TcpResult,
    TraceHop,
    TracerouteResult,
} from './types.ts';

// Network tests run from the agent's machine, to tell whether a problem is
// local, DNS or somewhere along the route. Safety rules:
// - Names are resolved here, so only a validated IP literal ever reaches a
//   command line, and commands run without a shell.
// - No admin/root needed: Windows uses .NET's Ping class through PowerShell,
//   Linux the system ping/traceroute (which are set up for unprivileged use).

const run = promisify(execFile);

const MAX_HOPS = 20;
const PROBE_TIMEOUT_MS = 1000;
const TCP_TIMEOUT_MS = 5000;

/** Hostname (RFC 1123 letters, digits, dots, dashes) or an IP literal. */
export function validateTarget(target: unknown): string | null {
    if (typeof target !== 'string') return null;
    const t = target.trim();
    if (isIP(t)) return t;
    if (t.length > 253 || t.startsWith('-') || t.startsWith('.')) return null;
    return /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,62})?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,62})?)*\.?$/.test(t) ? t : null;
}

class DiagnosticError extends Error {}

/** Resolves a target to one IP, preferring IPv4 (what most tools try first). */
async function resolveOne(target: string): Promise<string> {
    if (isIP(target)) return target;
    try {
        const { address } = await dns.lookup(target, { family: 0, order: 'ipv4first' });
        return address;
    } catch (e) {
        throw new DiagnosticError(`can't resolve ${target}: ${(e as NodeJS.ErrnoException).code ?? 'DNS error'}`);
    }
}

const round = (n: number) => Math.round(n * 10) / 10;

export function summarizePing(target: string, address: string, samples: (number | null)[]) {
    const ok = samples.filter((s): s is number => s !== null);
    const jitter = ok.length > 1 ? ok.slice(1).reduce((sum, v, i) => sum + Math.abs(v - ok[i]!), 0) / (ok.length - 1) : null;
    return {
        type: 'ping' as const,
        target,
        address,
        sent: samples.length,
        received: ok.length,
        lossPercent: samples.length ? round(((samples.length - ok.length) / samples.length) * 100) : 0,
        samples,
        minMs: ok.length ? Math.min(...ok) : null,
        avgMs: ok.length ? round(ok.reduce((a, b) => a + b, 0) / ok.length) : null,
        maxMs: ok.length ? Math.max(...ok) : null,
        jitterMs: jitter === null ? null : round(jitter),
    };
}

// ── Windows: .NET Ping (output is the same in every UI language) ─────────

async function powershellJson<T>(script: string, timeoutMs: number): Promise<T> {
    const { stdout } = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
        timeout: timeoutMs,
        windowsHide: true,
    });
    return JSON.parse(stdout.trim() || '[]') as T;
}

async function windowsPing(ip: string, count: number): Promise<(number | null)[]> {
    // `ip` is validated by isIP, so it can't break out of the quotes.
    const script = `$p = [System.Net.NetworkInformation.Ping]::new(); $b = [byte[]]::new(32);
ConvertTo-Json -Compress -InputObject @(foreach ($i in 1..${count}) {
  $r = $p.Send('${ip}', ${PROBE_TIMEOUT_MS}, $b);
  if ($r.Status -eq 'Success') { [int]$r.RoundtripTime } else { $null };
  if ($i -lt ${count}) { Start-Sleep -Milliseconds 200 } })`;
    const result = await powershellJson<(number | null)[] | number | null>(script, (count + 5) * 2000);
    return Array.isArray(result) ? result : [result];
}

interface PsHop {
    Ttl: number;
    Status: string;
    Address: string | null;
    Ms: number;
}

async function windowsTrace(ip: string): Promise<{ hops: Omit<TraceHop, 'host' | 'scope'>[]; reached: boolean }> {
    // TTL-limited pings: each router on the way answers "TTL expired" with its address.
    // .NET reports 0 ms for those, so each probe is timed with a stopwatch.
    const script = `$p = [System.Net.NetworkInformation.Ping]::new(); $b = [byte[]]::new(32);
ConvertTo-Json -Compress -InputObject @(foreach ($ttl in 1..${MAX_HOPS}) {
  $o = [System.Net.NetworkInformation.PingOptions]::new($ttl, $true);
  $sw = [Diagnostics.Stopwatch]::StartNew(); $r = $p.Send('${ip}', ${PROBE_TIMEOUT_MS}, $b, $o); $sw.Stop();
  $a = if ($r.Status -eq 'TimedOut') { $null } else { [string]$r.Address };
  [pscustomobject]@{ Ttl = $ttl; Status = [string]$r.Status; Address = $a; Ms = [int]$sw.ElapsedMilliseconds };
  if ($r.Status -ne 'TtlExpired' -and $r.Status -ne 'TimedOut') { break } })`;
    const raw = await powershellJson<PsHop[]>(script, (MAX_HOPS + 5) * 2000);
    return parseWindowsTrace(raw);
}

export function parseWindowsTrace(raw: PsHop[]) {
    const hops = raw.map((h) => ({
        ttl: h.Ttl,
        address: h.Address && h.Address !== '0.0.0.0' ? h.Address : null,
        rttMs: h.Address && h.Status !== 'TimedOut' ? h.Ms : null,
    }));
    return { hops, reached: raw.at(-1)?.Status === 'Success' };
}

// ── Linux: system ping / traceroute (forced to English output) ───────────

const C_LOCALE = { ...process.env, LC_ALL: 'C', LANG: 'C' };

/** Parses `ping -n -c N` output into one entry per probe (`null` = lost). */
export function parseLinuxPing(output: string, count: number): (number | null)[] {
    const samples: (number | null)[] = Array.from({ length: count }, () => null);
    for (const m of output.matchAll(/icmp_seq=(\d+).*?time[=<]([\d.]+)\s*ms/g)) {
        const seq = Number(m[1]);
        // iputils numbers probes from 1; some builds from 0.
        const index = seq >= 1 && seq <= count ? seq - 1 : seq;
        if (index >= 0 && index < count) samples[index] = Number(m[2]);
    }
    return samples;
}

/** Parses `traceroute -n -q 1` output. */
export function parseTraceroute(output: string): Omit<TraceHop, 'host' | 'scope'>[] {
    const hops: Omit<TraceHop, 'host' | 'scope'>[] = [];
    for (const line of output.split('\n')) {
        const m = /^\s*(\d+)\s+(?:(\S+)\s+([\d.]+)\s*ms|\*)/.exec(line);
        if (!m) continue;
        hops.push({ ttl: Number(m[1]), address: m[2] ?? null, rttMs: m[3] ? Number(m[3]) : null });
    }
    return hops;
}

/** Parses `tracepath -n` output (used when traceroute isn't installed). */
export function parseTracepath(output: string): Omit<TraceHop, 'host' | 'scope'>[] {
    const hops = new Map<number, Omit<TraceHop, 'host' | 'scope'>>();
    for (const line of output.split('\n')) {
        const m = /^\s*(\d+)\??:\s+(\S+)(?:\s+([\d.]+)ms)?/.exec(line);
        if (!m || m[2] === '[LOCALHOST]') continue;
        const ttl = Number(m[1]);
        const answered = m[2] !== 'no';
        const hop = { ttl, address: answered ? m[2]! : null, rttMs: answered && m[3] ? Number(m[3]) : null };
        // tracepath may print a hop more than once; keep the first answer.
        if (!hops.has(ttl) || (hops.get(ttl)!.address === null && hop.address)) hops.set(ttl, hop);
    }
    return [...hops.values()].sort((a, b) => a.ttl - b.ttl);
}

async function linuxPing(ip: string, count: number): Promise<(number | null)[]> {
    const args = ['-n', '-c', String(count), '-W', '1', '-i', '0.25', ...(isIP(ip) === 6 ? ['-6'] : []), ip];
    try {
        const { stdout } = await run('ping', args, { timeout: (count + 5) * 2000, env: C_LOCALE });
        return parseLinuxPing(stdout, count);
    } catch (e) {
        const err = e as NodeJS.ErrnoException & { stdout?: string };
        if (err.code === 'ENOENT') throw new DiagnosticError('ping is not installed on this machine');
        // Exit code 1 means no replies, which is a result, not an error.
        return parseLinuxPing(err.stdout ?? '', count);
    }
}

async function linuxTrace(ip: string, ipVersion: number): Promise<{ hops: Omit<TraceHop, 'host' | 'scope'>[]; reached: boolean }> {
    const reachedIn = (hops: Omit<TraceHop, 'host' | 'scope'>[]) => hops.some((h) => h.address === ip);
    const family = ipVersion === 6 ? ['-6'] : [];
    try {
        const { stdout } = await run('traceroute', [...family, '-n', '-q', '1', '-w', '1', '-m', String(MAX_HOPS), ip], {
            timeout: (MAX_HOPS + 5) * 2000,
            env: C_LOCALE,
        });
        const hops = parseTraceroute(stdout);
        return { hops, reached: reachedIn(hops) };
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    try {
        const { stdout } = await run('tracepath', ['-n', '-m', String(MAX_HOPS), ip], {
            timeout: (MAX_HOPS + 5) * 3000,
            env: C_LOCALE,
        });
        const hops = parseTracepath(stdout);
        return { hops, reached: reachedIn(hops) };
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new DiagnosticError('traceroute is not installed (e.g. apt install traceroute)');
        }
        throw e;
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────

async function ping(target: string, count: number): Promise<Omit<PingResult, 'startedAt' | 'durationMs'>> {
    const ip = await resolveOne(target);
    const samples = process.platform === 'win32' ? await windowsPing(ip, count) : await linuxPing(ip, count);
    return summarizePing(target, ip, samples);
}

async function traceroute(target: string): Promise<Omit<TracerouteResult, 'startedAt' | 'durationMs'>> {
    const ip = await resolveOne(target);
    const { hops, reached } = process.platform === 'win32' ? await windowsTrace(ip) : await linuxTrace(ip, isIP(ip));
    const named = await Promise.all(
        hops.map(async (h) => ({
            ...h,
            host: h.address ? await reverseLookup(h.address) : null,
            scope: h.address ? classify(h.address) : null,
        })),
    );
    return { type: 'traceroute', target, address: ip, hops: named, reached };
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T | null; error: string | null; durationMs: number }> {
    const start = performance.now();
    try {
        return { value: await fn(), error: null, durationMs: Math.round(performance.now() - start) };
    } catch (e) {
        const err = e as NodeJS.ErrnoException;
        return { value: null, error: err.code ?? err.message, durationMs: Math.round(performance.now() - start) };
    }
}

async function dnsTest(target: string): Promise<Omit<DnsResult, 'startedAt' | 'durationMs'>> {
    if (isIP(target)) throw new DiagnosticError('DNS lookup needs a name, not an IP address');
    const resolver = new dns.Resolver({ timeout: 3000, tries: 1 });
    const direct = await timed(async () => {
        // A and AAAA in parallel; only fail if both do.
        const [v4, v6] = await Promise.allSettled([resolver.resolve4(target), resolver.resolve6(target)]);
        if (v4.status === 'rejected' && v6.status === 'rejected') throw v4.reason;
        return [...(v4.status === 'fulfilled' ? v4.value : []), ...(v6.status === 'fulfilled' ? v6.value : [])];
    });
    const system = await timed(async () => (await dns.lookup(target, { all: true })).map((a) => a.address));
    return {
        type: 'dns',
        target,
        servers: resolver.getServers(),
        resolver: { addresses: direct.value ?? [], durationMs: direct.durationMs, error: direct.error },
        system: { addresses: system.value ?? [], durationMs: system.durationMs, error: system.error },
    };
}

async function tcpTest(target: string, port: number): Promise<Omit<TcpResult, 'startedAt' | 'durationMs'>> {
    let ip: string;
    try {
        ip = await resolveOne(target);
    } catch (e) {
        return { type: 'tcp', target, address: null, port, connected: false, connectMs: null, error: (e as Error).message };
    }
    return new Promise((resolve) => {
        const start = performance.now();
        const socket = new Socket();
        const done = (connected: boolean, error: string | null) => {
            socket.destroy();
            resolve({ type: 'tcp', target, address: ip, port, connected, connectMs: Math.round(performance.now() - start), error });
        };
        socket.setTimeout(TCP_TIMEOUT_MS);
        socket.once('connect', () => done(true, null));
        socket.once('timeout', () => done(false, 'timed out'));
        socket.once('error', (e: NodeJS.ErrnoException) =>
            done(false, e.code === 'ECONNREFUSED' ? 'connection refused (nothing listening on that port)' : (e.code ?? e.message)),
        );
        socket.connect(port, ip);
    });
}

/** Parses and validates a request body; returns an error message instead when invalid. */
export function parseRequest(body: unknown): DiagnosticRequest | string {
    const b = (body ?? {}) as Record<string, unknown>;
    const target = validateTarget(b.target);
    if (!target) return 'target must be a hostname or IP address';
    switch (b.type) {
        case 'ping': {
            const count = b.count === undefined ? 5 : Number(b.count);
            if (!Number.isInteger(count) || count < 1 || count > 10) return 'count must be 1–10';
            return { type: 'ping', target, count };
        }
        case 'traceroute':
        case 'dns':
            return { type: b.type, target };
        case 'tcp': {
            const port = Number(b.port);
            if (!Number.isInteger(port) || port < 1 || port > 65535) return 'port must be 1–65535';
            return { type: 'tcp', target, port };
        }
        default:
            return 'type must be ping, traceroute, dns or tcp';
    }
}

let running = false;

/**
 * Runs one test. Only one runs at a time per agent (they're slow and noisy);
 * returns "busy" instead of queueing.
 */
export async function runDiagnostic(req: DiagnosticRequest): Promise<DiagnosticResult | 'busy' | { failed: string }> {
    if (running) return 'busy';
    running = true;
    const startedAt = new Date();
    const start = performance.now();
    try {
        const result =
            req.type === 'ping'
                ? await ping(req.target, req.count ?? 5)
                : req.type === 'traceroute'
                  ? await traceroute(req.target)
                  : req.type === 'dns'
                    ? await dnsTest(req.target)
                    : await tcpTest(req.target, req.port);
        return { ...result, startedAt: startedAt.toISOString(), durationMs: Math.round(performance.now() - start) } as DiagnosticResult;
    } catch (e) {
        if (e instanceof DiagnosticError) return { failed: e.message };
        throw e;
    } finally {
        running = false;
    }
}
