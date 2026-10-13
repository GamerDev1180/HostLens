// Shapes of the agent's HTTP responses.
// This is the single source of truth for the API: HostLens-program imports these
// types directly, so changing them here surfaces any mismatch in the program.

// GET /health (no authentication required)
export interface HealthResponse {
    status: "ok";
    agentVersion: string;
}

// GET /api/v1/info
export interface AgentInfo {
    hostname: string;
    /** Node platform id, e.g. `win32`, `linux`, `darwin`. */
    platform: string;
    /** Human-readable OS name, e.g. `Windows 11 Pro` or `Ubuntu 24.04.1 LTS`. */
    osName: string;
    /** Kernel / OS release, e.g. `10.0.26300` or `6.8.0-45-generic`. */
    osRelease: string;
    arch: string;
    cpuModel: string;
    logicalCores: number;
    totalMemoryBytes: number;
    /** ISO timestamp of when the machine booted. */
    bootTime: string;
    agentVersion: string;
}

export interface CpuMetrics {
    /** Overall usage across all cores, 0–100. */
    usagePercent: number;
    logicalCores: number;
    /** Usage per logical core, 0–100, indexed by core. */
    perCorePercent: number[];
    /** 1, 5 and 15 minute load averages; `null` where the OS has no load average (Windows). */
    loadAverage: [number, number, number] | null;
}

export interface MemoryMetrics {
    totalBytes: number;
    /** Memory in use, excluding reclaimable caches where the OS reports them. */
    usedBytes: number;
    usagePercent: number;
    /** Swap (Linux) or page file (Windows); `null` if none is configured or it can't be read. */
    swap: SwapMetrics | null;
}

export interface SwapMetrics {
    totalBytes: number;
    usedBytes: number;
    usagePercent: number;
}

export interface DiskMetrics {
    /** Drive letter on Windows (`C:`), mount point elsewhere (`/`, `/home`). */
    mount: string;
    totalBytes: number;
    usedBytes: number;
    /** Space available to unprivileged users. */
    freeBytes: number;
    usagePercent: number;
}

export interface NetworkInterfaceMetrics {
    name: string;
    receivedBytes: number;
    sentBytes: number;
}

export interface NetworkMetrics {
    /**
     * Bytes received / sent, summed over all non-loopback interfaces.
     * Counters are cumulative and can reset (reboot, adapter restart), so compute
     * rates from the difference between two samples and discard negative deltas.
     */
    receivedBytes: number;
    sentBytes: number;
    /** Per-interface counters; empty if the platform only reports totals. */
    interfaces: NetworkInterfaceMetrics[];
}

// GET /api/v1/metrics
export interface MetricsResponse {
    /** ISO timestamp of when the sample was taken. */
    timestamp: string;
    cpu: CpuMetrics;
    memory: MemoryMetrics;
    /** Mounted filesystems; empty if they couldn't be read. */
    disk: DiskMetrics[];
    /** `null` if network counters aren't available on this platform. */
    network: NetworkMetrics | null;
    uptimeSeconds: number;
}

export interface ProcessMetrics {
    pid: number;
    name: string;
    /**
     * Share of the whole machine's CPU time since the previous sample, 0–100
     * (so one fully busy core on a 4-core machine is 25). `null` if the OS
     * doesn't let an unprivileged user read the process's CPU time.
     */
    cpuPercent: number | null;
    /** Resident memory (Linux RSS / Windows working set). */
    memoryBytes: number;
}

// GET /api/v1/metrics/processes?sort=cpu|memory&limit=1..500
export interface ProcessesResponse {
    timestamp: string;
    /** Number of processes running, before `limit` is applied. */
    totalCount: number;
    /** Top processes by `sort` (default `cpu`), at most `limit` (default 10). */
    processes: ProcessMetrics[];
}

export type ConnectionScope = 'loopback' | 'lan' | 'internet';

export type TcpState =
    | 'established'
    | 'listen'
    | 'syn_sent'
    | 'syn_received'
    | 'fin_wait'
    | 'close_wait'
    | 'closing'
    | 'last_ack'
    | 'time_wait'
    | 'closed';

export interface ConnectionMetrics {
    protocol: 'tcp';
    localAddress: string;
    localPort: number;
    remoteAddress: string;
    remotePort: number;
    state: TcpState;
    /** `null` when the OS doesn't reveal the owner to an unprivileged user. */
    pid: number | null;
    processName: string | null;
    /** Where the remote end is: this machine, a private network (incl. VPN ranges), or the internet. */
    scope: ConnectionScope;
    /** Reverse-DNS name of the remote address; `null` until looked up or if it has none. */
    remoteHost: string | null;
}

export interface ListeningPort {
    protocol: 'tcp' | 'udp';
    address: string;
    port: number;
    pid: number | null;
    processName: string | null;
    /** Bound to all or to non-loopback interfaces, so other machines may reach it. */
    exposed: boolean;
}

// GET /api/v1/metrics/connections
export interface ConnectionsResponse {
    timestamp: string;
    /** TCP connections other than listening sockets. */
    connections: ConnectionMetrics[];
    /** TCP listening sockets and bound UDP ports. */
    listening: ListeningPort[];
}

// A device paired with the agent (GET /api/v1/devices)
export interface DeviceInfo {
    id: string;
    name: string;
    createdAt: string;
    lastSeenAt: string | null;
    /** True for the device making the request. */
    current: boolean;
}

// POST /api/v1/pairing-codes
export interface PairingCodeResponse {
    /** 8 characters, single use. */
    code: string;
    expiresAt: string;
    /** Addresses the new device can try, best first. */
    urls: string[];
    /** hostlens://pair?url=…&code=…&name=…, what the QR code encodes. */
    link: string;
    /** Only 127.0.0.1 is listening, so devices on other machines can't connect. */
    localOnly: boolean;
}

// POST /api/v1/pair (no token needed)
export interface PairRequest {
    code: string;
    deviceName: string;
}

export interface PairResponse {
    deviceId: string;
    /** The device's own API token. Returned only here, once. */
    token: string;
    hostname: string;
    agentVersion: string;
}

// Body of every non-2xx response.
export interface ErrorResponse {
    error: string;
}
