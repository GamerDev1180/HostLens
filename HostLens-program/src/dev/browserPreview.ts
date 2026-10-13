// Dev-only: lets the UI run in a normal browser (`pnpm dev`, then open
// http://localhost:1420) by answering Tauri commands with simulated data.
// It's only loaded when not running inside Tauri, and never in production builds.
import { mockIPC } from "@tauri-apps/api/mocks";
import type {
  AgentInfo,
  ConnectionMetrics,
  ConnectionsResponse,
  DeviceInfo,
  ListeningPort,
  MetricsResponse,
  ProcessesResponse,
} from "../../../agent/types";

const GB = 1024 ** 3;
const DAY = 86_400_000;
const HOUR = 3_600_000;

interface DemoHost {
  info: AgentInfo;
  base: { cpu: number; mem: number };
  disks: { mount: string; total: number; used: number }[];
  offline?: boolean;
  rx: number;
  tx: number;
  cpu: number;
  mem: number;
}

const hosts: Record<string, DemoHost> = {
  "http://localhost:47821": {
    info: {
      hostname: "GAMING-PC",
      platform: "win32",
      osName: "Windows 11 Pro",
      osRelease: "10.0.26300",
      arch: "x64",
      cpuModel: "Intel(R) Core(TM) i5-10400F CPU @ 2.90GHz",
      logicalCores: 12,
      totalMemoryBytes: 16 * GB,
      bootTime: new Date(Date.now() - 7 * DAY).toISOString(),
      agentVersion: "1.1.0",
    },
    base: { cpu: 28, mem: 62 },
    disks: [
      { mount: "C:", total: 931 * GB, used: 512 * GB },
      { mount: "D:", total: 1863 * GB, used: 1402 * GB },
    ],
    rx: 110e9,
    tx: 36e9,
    cpu: 28,
    mem: 62,
  },
  "http://10.0.0.21:47821": {
    info: {
      hostname: "fivem-prod-01",
      platform: "linux",
      osName: "Ubuntu 24.04.1 LTS",
      osRelease: "6.8.0-45-generic",
      arch: "x64",
      cpuModel: "AMD EPYC 7763 64-Core Processor",
      logicalCores: 8,
      totalMemoryBytes: 32 * GB,
      bootTime: new Date(Date.now() - 41 * DAY).toISOString(),
      agentVersion: "1.1.0",
    },
    base: { cpu: 64, mem: 78 },
    disks: [
      { mount: "/", total: 240 * GB, used: 224 * GB },
      { mount: "/var/lib/docker", total: 500 * GB, used: 211 * GB },
    ],
    rx: 4.2e12,
    tx: 6.8e12,
    cpu: 64,
    mem: 78,
  },
  "http://192.168.1.50:47821": {
    info: {} as AgentInfo,
    base: { cpu: 0, mem: 0 },
    disks: [],
    offline: true,
    rx: 0,
    tx: 0,
    cpu: 0,
    mem: 0,
  },
};

const walk = (value: number, base: number, spread: number) =>
  Math.min(100, Math.max(1, value + (Math.random() - 0.5) * spread + (base - value) * 0.15));

function metrics(h: DemoHost): MetricsResponse {
  h.cpu = walk(h.cpu, h.base.cpu, 18);
  h.mem = walk(h.mem, h.base.mem, 2);
  h.rx += 2e6 + Math.random() * 9e6;
  h.tx += 1e6 + Math.random() * 4e6;
  const cores = h.info.logicalCores;
  const total = h.info.totalMemoryBytes;
  return {
    timestamp: new Date().toISOString(),
    cpu: {
      usagePercent: h.cpu,
      logicalCores: cores,
      perCorePercent: Array.from({ length: cores }, () => Math.min(100, Math.max(0, h.cpu + (Math.random() - 0.5) * 50))),
      loadAverage: h.info.platform === "win32" ? null : [h.cpu / 25, h.cpu / 28, h.cpu / 30],
    },
    memory: {
      totalBytes: total,
      usedBytes: (total * h.mem) / 100,
      usagePercent: h.mem,
      swap: { totalBytes: 16 * GB, usedBytes: 0.6 * GB, usagePercent: 3.75 },
    },
    disk: h.disks.map((d) => ({
      mount: d.mount,
      totalBytes: d.total,
      usedBytes: d.used,
      freeBytes: d.total - d.used,
      usagePercent: (d.used / d.total) * 100,
    })),
    network: {
      receivedBytes: h.rx,
      sentBytes: h.tx,
      interfaces: [
        { name: h.info.platform === "win32" ? "Ethernet" : "eth0", receivedBytes: h.rx * 0.97, sentBytes: h.tx * 0.97 },
        { name: "Tailscale", receivedBytes: h.rx * 0.03, sentBytes: h.tx * 0.03 },
      ],
    },
    uptimeSeconds: Math.floor((Date.now() - Date.parse(h.info.bootTime)) / 1000),
  };
}

const PROCESS_NAMES = ["FXServer", "node", "mariadb", "chrome", "Code", "explorer", "redis-server", "nginx", "Discord", "steam"];

function processes(sort: string, limit: number): ProcessesResponse {
  const list = PROCESS_NAMES.map((name, i) => ({
    pid: 1000 + i * 137,
    name,
    cpuPercent: Math.max(0, (name === "FXServer" ? 22 : 6 / (i + 1)) + (Math.random() - 0.5) * 3),
    memoryBytes: (name === "FXServer" ? 3.2 : 1.6 / (i + 1)) * GB,
  }));
  list.sort((a, b) => (sort === "memory" ? b.memoryBytes - a.memoryBytes : b.cpuPercent - a.cpuPercent));
  return { timestamp: new Date().toISOString(), totalCount: 287, processes: list.slice(0, limit) };
}

const FIRST = ["Jay", "Mila", "Tyler", "Noah", "Sven", "Luca", "Emma", "Max", "Zoe", "Finn", "Lars", "Iris"];
const LAST = ["Vance", "Bakker", "Rossi", "Kowalski", "de Vries", "Moreau", "Silva", "Novak"];
let players = 52;

function fivem(baseUrl: string) {
  if (baseUrl.includes("203.0.113.7")) throw "connection refused or unreachable";
  players = Math.round(Math.min(64, Math.max(30, players + (Math.random() - 0.45) * 4)));
  return {
    latencyMs: 30 + Math.round(Math.random() * 25),
    dynamic: {
      clients: players,
      gametype: "Roleplay",
      hostname: "^2Lowlands ^0RP ^8| ^0Serious Roleplay ^8| ^0Custom Jobs",
      mapname: "San Andreas",
      sv_maxclients: "64",
    },
    info: {
      server: "FXServer-master SERVER v1.0.0.35419 linux",
      resources: Array.from({ length: 214 }, (_, i) => `res${i}`),
      vars: {
        sv_projectName: "Lowlands RP",
        sv_projectDesc: "Serious roleplay · custom jobs · weekly events",
        tags: "roleplay, serious, economy, police, custom cars, esx",
        locale: "nl-NL",
        onesync_enabled: "true",
        sv_enforceGameBuild: "3258",
        "txAdmin-version": "8.1.1",
      },
    },
    players: Array.from({ length: players }, (_, i) => ({
      id: i + 1,
      name: `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]}`,
      ping: 20 + ((i * 37) % 140),
      identifiers: [],
    })),
  };
}

// Who the demo FiveM box talks to: players, Cfx.re, Discord, its database, a CDN.
const REMOTES: [string, string | null, number, string, ConnectionMetrics["scope"]][] = [
  ["162.159.135.234", "discord.com", 443, "node", "internet"],
  ["104.18.21.201", "frontend.cfx-services.net", 443, "FXServer", "internet"],
  ["185.199.110.133", "cdn-185-199-110-133.github.com", 443, "node", "internet"],
  ["142.250.179.142", "ams15s32-in-f14.1e100.net", 443, "chrome", "internet"],
  ["192.168.1.50", "nas.local", 445, "explorer", "lan"],
  ["100.88.1.2", "laptop.tailnet-1234.ts.net", 47821, "node", "lan"],
  ["127.0.0.1", null, 3306, "FXServer", "loopback"],
];

function connections(): ConnectionsResponse {
  const list: ConnectionMetrics[] = [];
  REMOTES.forEach(([ip, host, port, proc, scope], i) => {
    const n = proc === "FXServer" && scope === "loopback" ? 6 : 1 + (i % 3);
    for (let k = 0; k < n; k++) {
      list.push({ protocol: "tcp", localAddress: "10.0.0.21", localPort: 50000 + i * 10 + k, remoteAddress: ip, remotePort: port, state: k === 2 ? "time_wait" : "established", pid: 1000 + i, processName: proc, scope, remoteHost: host });
    }
  });
  // FiveM players connect in on 30120 from all over.
  for (let i = 0; i < 18; i++) {
    const ip = `${80 + (i % 7)}.${(i * 37) % 255}.${(i * 91) % 255}.${10 + i}`;
    list.push({ protocol: "tcp", localAddress: "10.0.0.21", localPort: 30120, remoteAddress: ip, remotePort: 40000 + i * 13, state: "established", pid: 1000, processName: "FXServer", scope: "internet", remoteHost: i % 3 ? `${ip.replace(/\./g, "-")}.dynamic.ziggo.nl` : null });
  }
  const listening: ListeningPort[] = [
    { protocol: "tcp", address: "0.0.0.0", port: 30120, pid: 1000, processName: "FXServer", exposed: true },
    { protocol: "udp", address: "0.0.0.0", port: 30120, pid: 1000, processName: "FXServer", exposed: true },
    { protocol: "tcp", address: "0.0.0.0", port: 40120, pid: 1000, processName: "FXServer", exposed: true },
    { protocol: "tcp", address: "127.0.0.1", port: 3306, pid: 1100, processName: "mariadbd", exposed: false },
    { protocol: "tcp", address: "0.0.0.0", port: 22, pid: 700, processName: "sshd", exposed: true },
    { protocol: "tcp", address: "0.0.0.0", port: 47821, pid: 1200, processName: "node", exposed: true },
  ];
  return { timestamp: new Date().toISOString(), connections: list, listening };
}

const devices: DeviceInfo[] = [
  { id: "d1", name: "HostLens on Windows", createdAt: new Date(Date.now() - 9 * DAY).toISOString(), lastSeenAt: new Date().toISOString(), current: true },
  { id: "d2", name: "HostLens on Android", createdAt: new Date(Date.now() - 2 * DAY).toISOString(), lastSeenAt: new Date(Date.now() - 3 * HOUR).toISOString(), current: false },
];

function seedStorage() {
  if (localStorage.getItem("hostlens.subscriptions")) return;
  const now = Date.now();
  localStorage.setItem(
    "hostlens.subscriptions",
    JSON.stringify([
      { id: "h1", name: "Gaming PC", url: "http://localhost:47821", token: "demo" },
      { id: "h2", name: "FiveM box", url: "http://10.0.0.21:47821", token: "demo" },
      { id: "h3", name: "NAS", url: "http://192.168.1.50:47821", token: "demo" },
    ]),
  );
  localStorage.setItem(
    "hostlens.checks",
    JSON.stringify([
      { id: "c1", name: "Lowlands RP", kind: "fivem", target: "http://57.129.76.105:30120", joinCode: "lw7k3p", intervalSeconds: 10, createdAt: now - 7 * DAY },
      { id: "c2", name: "Dev server", kind: "fivem", target: "http://203.0.113.7:30120", intervalSeconds: 10, createdAt: now - 7 * DAY },
      { id: "c3", name: "Community website", kind: "http", target: "https://lowlandsrp.example", intervalSeconds: 30, createdAt: now - 7 * DAY },
      { id: "c4", name: "Database", kind: "tcp", target: "db.internal:3306", intervalSeconds: 30, createdAt: now - 3 * DAY },
    ]),
  );
  // A week of hourly history with a couple of rough hours, so reports have something to show.
  const report = (seed: number, bad: number[]) => {
    const current = Math.floor(now / HOUR) * HOUR;
    const buckets = Array.from({ length: 7 * 24 }, (_, i) => {
      const hour = current - (7 * 24 - 1 - i) * HOUR;
      const down = bad.includes(i) ? 4 + ((i * seed) % 20) : 0;
      return { hour, up: 360 - down, down, latencySum: (360 - down) * (38 + ((i * seed) % 15)), latencyCount: 360 - down, peakPlayers: 40 + ((i * 13 + seed) % 25) };
    });
    const incidents = bad
      .slice()
      .reverse()
      .map((i, n) => {
        const startedAt = current - (7 * 24 - 1 - i) * HOUR + 17 * 60_000;
        return { id: `i${seed}${n}`, startedAt, endedAt: startedAt + (3 + n * 4) * 60_000, cause: n % 2 ? "timed out" : "connection refused or unreachable" };
      });
    return { buckets, incidents, lastResultAt: now - 60_000 };
  };
  localStorage.setItem(
    "hostlens.checkReports",
    JSON.stringify({ c1: report(3, [30, 31, 97, 150]), c2: report(5, [160, 161, 162, 163, 164, 165, 166, 167]), c3: report(7, [12]) }),
  );
}

seedStorage();

mockIPC((cmd, payload) => {
  const args = (payload ?? {}) as Record<string, string & number & boolean>;
  switch (cmd) {
    case "agent_request": {
      const host = hosts[args.url];
      if (!host || host.offline) throw "connection refused or unreachable";
      const [path, query = ""] = String(args.path).split("?");
      const route = `${args.method} ${path}`;
      if (route === "GET /api/v1/info") return host.info;
      if (route === "GET /api/v1/metrics") return metrics(host);
      if (route === "GET /api/v1/metrics/processes") {
        const params = new URLSearchParams(query);
        return processes(params.get("sort") ?? "cpu", Number(params.get("limit") ?? 10));
      }
      if (route === "GET /api/v1/metrics/connections") return connections();
      if (route === "GET /api/v1/devices") return devices;
      if (route === "POST /api/v1/pairing-codes") {
        const urls = ["http://192.168.1.21:47821", "http://100.88.1.21:47821"];
        const params = new URLSearchParams();
        urls.forEach((u) => params.append("url", u));
        params.set("code", "K7QM3XPA");
        params.set("name", host.info.hostname);
        return { code: "K7QM3XPA", expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), urls, link: `hostlens://pair?${params}`, localOnly: false };
      }
      if (route === "POST /api/v1/pair") {
        return { deviceId: "d9", token: "demo-device-token", hostname: host.info.hostname, agentVersion: "1.2.0" };
      }
      if (args.method === "DELETE" && path.startsWith("/api/v1/devices/")) {
        const i = devices.findIndex((d) => d.id === path.split("/").pop());
        if (i >= 0) devices.splice(i, 1);
        return null;
      }
      throw "404 not found";
    }
    case "run_service_check":
      return { ok: true, latencyMs: 60 + Math.round(Math.random() * 90), detail: args.kind === "http" ? "HTTP 200" : "connected" };
    case "fetch_fivem":
      return fivem(args.baseUrl);
    case "resolve_cfx_join":
      return { baseUrl: "http://57.129.76.105:30120", hostname: "Demo server", projectName: "Demo RP" };
    case "send_discord_webhook":
      return null;
    default:
      throw `browser preview: no mock for ${cmd}`;
  }
});

console.info("[HostLens] Browser preview: Tauri commands are simulated.");
