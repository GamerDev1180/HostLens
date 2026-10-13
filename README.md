# HostLens

HostLens is a lightweight host monitoring tool. It consists of:

- an **agent** that runs on each machine you want to watch and exposes live system metrics (CPU, memory, swap, disks, network, processes, uptime) over an authenticated HTTP API, and
- a **desktop program** (Tauri + React) that subscribes to one or more agents, keeps the history for its charts, monitors FiveM servers, websites and ports with uptime reports, and sends alerts to Discord.

Ideas that are planned but not built yet are in [FUTURE.md](FUTURE.md).

> **Status:** early development. The agent, the desktop program's hosts and FiveM/HTTP/TCP monitors, uptime reports and Discord alerts work. An Android build is next.

## Project structure

```
HostLens/
├── agent/
│   ├── index.ts          # Startup: config, listen, banner
│   ├── app.ts            # Hono app and routes (createApp, used by the tests)
│   ├── types.ts          # API response types (shared with the program)
│   ├── config.ts         # Environment config and API token handling
│   ├── security.ts       # Origin check and bearer-token middleware
│   ├── collectors/       # Metric collection
│   │   ├── cpu.ts        # CPU usage (same on every OS)
│   │   ├── processes.ts  # Per-process CPU % from two snapshots (same on every OS)
│   │   ├── common.ts     # Shared helpers and the PlatformCollector interface
│   │   ├── windows.ts    # Windows memory, page file, drives, network, processes
│   │   ├── powershell.ts # Long-lived PowerShell session used by windows.ts
│   │   ├── linux.ts      # Linux memory, swap, mounts, network, processes (/proc, /etc)
│   │   └── index.ts      # Picks the module for the current OS
│   └── test/             # Vitest: API contract and parser tests
├── HostLens-program/     # Tauri desktop app that subscribes to agents
│   ├── src/
│   │   ├── types.ts      # Program types; re-exports the agent's API types
│   │   ├── useAgents.ts  # Agent subscriptions, polling, throughput, history
│   │   ├── useChecks.ts  # Service checks (HTTP, TCP, FiveM)
│   │   ├── useAlerts.ts  # Alert rules, history and Discord notifications
│   │   ├── fivem.ts      # FiveM server response parsing (in progress)
│   │   ├── reports.ts    # Hourly uptime buckets and incidents per check (in progress)
│   │   └── components/   # Sidebar, AgentDetail, ChecksView, AlertsView, …
│   └── src-tauri/        # Rust backend: agent requests, service checks, webhooks
├── FUTURE.md             # Planned, not-yet-built ideas
└── README.md
```

## Agent

The agent is a [Hono](https://hono.dev/) app served with `@hono/node-server`. It runs as a normal user (no administrator/root needed), reads metrics on request and stores nothing: history is the desktop program's job.

The API response is the same on every OS; collection that differs between Windows and Linux lives in separate modules under `agent/collectors/`. Other platforms (e.g. macOS) fall back to what Node reports portably. Metrics that can't be read are returned empty (`disk: []`, `network: null`) rather than failing the request.

### Requirements

- Node.js 22.18+ (runs TypeScript directly via built-in type stripping), or any recent Node.js with [`tsx`](https://github.com/privatenumber/tsx)
- [pnpm](https://pnpm.io/) (the project pins `pnpm@10.22.0`)

### Getting started

```sh
cd agent
pnpm install
pnpm start           # or: node index.ts / npx tsx index.ts
pnpm test            # API contract + parser tests
```

The first time it starts (while no device is paired yet) the agent prints a **pairing QR code**:

```
HostLens agent 1.3.0 listening on http://127.0.0.1:47821
Master token: stored in C:\Users\you\AppData\Roaming\HostLens\agent-token

  Scan with the HostLens app to pair a device:
  █▀▀▀▀▀█ ▀▄█▀ ▄ █▀▀▀▀▀█
  …
  Code: G7KA-MTBH   (works once, expires in 10 min)
  Address: http://192.168.1.21:47821, http://100.88.1.21:47821
```

Scan it with the app on a phone, or paste the code into **Add host** on the desktop. To pair more devices later:

```sh
pnpm pair            # new single-use pairing QR code
pnpm devices         # list paired devices
pnpm revoke <id>     # remove a device; its token stops working
```

An already-paired app can also show a pairing QR code for another device (**Pair device** on the host page). Phones can only reach the agent if it listens on the network: start it with `HOSTLENS_HOST=0.0.0.0` (or use a VPN such as Tailscale).

### Pairing

1. An authenticated client (the CLI with the master token, or a paired app) asks for a pairing code: 8 characters, **single use, valid for 10 minutes**.
2. The QR code encodes `hostlens://pair?url=…&url=…&code=…&name=…`, listing every address the agent can be reached on (LAN first, then VPN ranges such as Tailscale).
3. The new device sends the code to `POST /api/v1/pair` and gets **its own token**, returned exactly once. The agent stores only a SHA-256 hash of it in `devices.json`, next to the master token.
4. After 10 wrong codes within 5 minutes, pairing is locked for the rest of that window.

### Security

- **Local only by default.** The agent binds to `127.0.0.1`. Set `HOSTLENS_HOST=0.0.0.0` (or a specific interface) only if you want other machines to reach it; traffic is plain HTTP, so do this only on a trusted network.
- **Token required.** Every `/api/*` request (except pairing itself) needs `Authorization: Bearer <token>`: a paired device's token, or the **master token**. The master token is generated on first run and saved to a per-user file (`%APPDATA%\HostLens\agent-token` on Windows, `~/.config/hostlens/agent-token` elsewhere, readable only by you); it's never printed. Delete the file to rotate it. Device tokens are revocable one by one.
- **Browser origins rejected.** Any request carrying an `Origin` header is refused with `403` unless that origin is listed in `HOSTLENS_ALLOWED_ORIGINS`, so web pages can't probe the agent. The desktop program calls the agent from Rust, which sends no `Origin`.

### Configuration

| Variable                   | Default                     | Description                                                    |
| -------------------------- | --------------------------- | -------------------------------------------------------------- |
| `HOSTLENS_HOST`            | `127.0.0.1`                 | Interface to bind                                              |
| `HOSTLENS_PORT`            | `47821`                     | Port to listen on                                              |
| `HOSTLENS_TOKEN`           | *(generated)*               | Use this API token instead of the generated one                |
| `HOSTLENS_TOKEN_FILE`      | per-user config dir         | Where the generated token is stored                            |
| `HOSTLENS_DEVICES_FILE`    | per-user config dir         | Where paired devices (token hashes) are stored                 |
| `HOSTLENS_ALLOWED_ORIGINS` | *(none)*                    | Comma-separated browser origins allowed to call the API (CORS) |

### Endpoints

All responses are JSON. Errors have the shape `{ "error": "<message>" }` (`400` invalid request, `401` bad/missing token or wrong pairing code, `403` origin not allowed, `404` unknown route, `429` too many wrong pairing codes, `501` not supported on this OS).

| Method | Route                         | Auth | Purpose                                         |
| ------ | ----------------------------- | ---- | ----------------------------------------------- |
| GET    | `/health`                     | no   | Check the agent is running                      |
| GET    | `/api/v1/info`                | yes  | OS, hostname, architecture, agent version       |
| GET    | `/api/v1/metrics`             | yes  | Current system metrics                          |
| GET    | `/api/v1/metrics/processes`   | yes  | Top processes by CPU or memory                  |
| GET    | `/api/v1/metrics/connections` | yes  | TCP connections and listening ports             |
| POST   | `/api/v1/pairing-codes`       | yes  | Create a single-use pairing code (and QR link)  |
| POST   | `/api/v1/pair`                | code | Trade a pairing code for a device token         |
| GET    | `/api/v1/devices`             | yes  | List paired devices                             |
| DELETE | `/api/v1/devices/:id`         | yes  | Remove a device (its token stops working)       |
| POST   | `/api/v1/diagnostics`         | yes  | Run a ping, traceroute, DNS or TCP test         |

The response types are defined in [`agent/types.ts`](agent/types.ts).

#### `GET /health`

```json
{ "status": "ok", "agentVersion": "1.1.0" }
```

#### `GET /api/v1/info`

| Field              | Type     | Description                                              |
| ------------------ | -------- | -------------------------------------------------------- |
| `hostname`         | `string` | Machine hostname                                         |
| `platform`         | `string` | `win32`, `linux`, `darwin`, …                            |
| `osName`           | `string` | Human-readable OS, e.g. `Windows 11 Pro`, `Ubuntu 24.04.1 LTS` |
| `osRelease`        | `string` | Kernel / OS release                                      |
| `arch`             | `string` | CPU architecture, e.g. `x64`, `arm64`                    |
| `cpuModel`         | `string` | CPU model name                                           |
| `logicalCores`     | `number` | Number of logical cores                                  |
| `totalMemoryBytes` | `number` | Installed memory, in bytes                               |
| `bootTime`         | `string` | ISO timestamp of the last boot                           |
| `agentVersion`     | `string` | Agent version                                            |

```json
{
  "hostname": "my-pc",
  "platform": "win32",
  "osName": "Windows 11 Pro",
  "osRelease": "10.0.26300",
  "arch": "x64",
  "cpuModel": "Intel(R) Core(TM) i5-10400F CPU @ 2.90GHz",
  "logicalCores": 12,
  "totalMemoryBytes": 17042837504,
  "bootTime": "2026-10-06T16:35:18.753Z",
  "agentVersion": "1.1.0"
}
```

#### `GET /api/v1/metrics`

| Field                    | Type             | Description                                                                                     |
| ------------------------ | ---------------- | ----------------------------------------------------------------------------------------------- |
| `timestamp`              | `string`         | ISO timestamp of the sample                                                                     |
| `cpu.usagePercent`       | `number`         | Overall CPU usage, 0–100, since the previous sample (at least 250 ms window)                    |
| `cpu.logicalCores`       | `number`         | Number of logical cores                                                                         |
| `cpu.perCorePercent`     | `number[]`       | Usage per logical core, 0–100                                                                   |
| `cpu.loadAverage`        | `number[] \| null` | 1, 5 and 15 minute load averages; `null` on Windows                                           |
| `memory.totalBytes`      | `number`         | Total physical memory                                                                           |
| `memory.usedBytes`       | `number`         | Memory in use (total − available; excludes reclaimable cache)                                   |
| `memory.usagePercent`    | `number`         | `usedBytes / totalBytes`, 0–100                                                                 |
| `memory.swap`            | `object \| null` | Swap (Linux) or page file (Windows): `totalBytes`, `usedBytes`, `usagePercent`; `null` if none   |
| `disk[]`                 | `array`          | One entry per drive (Windows) or real mounted filesystem (Linux); empty if unavailable          |
| `disk[].mount`           | `string`         | Drive letter (`C:`) or mount point (`/home`)                                                    |
| `disk[].totalBytes`      | `number`         | Filesystem size                                                                                 |
| `disk[].usedBytes`       | `number`         | Space in use                                                                                    |
| `disk[].freeBytes`       | `number`         | Space available to unprivileged users                                                           |
| `disk[].usagePercent`    | `number`         | Used share of usable space, 0–100 (same as `df`)                                                |
| `network`                | `object \| null` | `null` where counters aren't available                                                          |
| `network.receivedBytes`  | `number`         | Bytes received since boot, all non-loopback interfaces                                          |
| `network.sentBytes`      | `number`         | Bytes sent since boot, all non-loopback interfaces                                              |
| `network.interfaces[]`   | `array`          | Per interface: `name`, `receivedBytes`, `sentBytes` (empty if only totals are available)        |
| `gpus[]`                 | `array`          | NVIDIA GPUs (via `nvidia-smi`): `index`, `name`, `vendor`, `utilizationPercent`, `memoryTotalBytes`, `memoryUsedBytes`, `temperatureC`, `powerDrawW`, `powerLimitW`, `fanPercent`, `coreClockMhz`, `memoryClockMhz`, `driverVersion`; any field is `null` if not reported. Empty without a supported GPU. Refreshed in the background at most every 2 s. Missing before agent 1.3 |
| `uptimeSeconds`          | `number`         | System uptime, in seconds                                                                       |

```json
{
  "timestamp": "2026-10-13T19:07:18.231Z",
  "cpu": {
    "usagePercent": 24.5,
    "logicalCores": 12,
    "perCorePercent": [21.3, 30.1, 18.7, 27.9, 22.4, 26.0, 19.8, 31.2, 23.5, 25.1, 20.6, 28.4],
    "loadAverage": null
  },
  "memory": {
    "totalBytes": 17179869184,
    "usedBytes": 9663676416,
    "usagePercent": 56.25,
    "swap": { "totalBytes": 17042505728, "usedBytes": 594542592, "usagePercent": 3.49 }
  },
  "disk": [
    {
      "mount": "C:",
      "totalBytes": 1000000000000,
      "usedBytes": 450000000000,
      "freeBytes": 550000000000,
      "usagePercent": 45
    }
  ],
  "network": {
    "receivedBytes": 124000000,
    "sentBytes": 48000000,
    "interfaces": [
      { "name": "Ethernet", "receivedBytes": 120000000, "sentBytes": 47000000 },
      { "name": "Tailscale", "receivedBytes": 4000000, "sentBytes": 1000000 }
    ]
  },
  "uptimeSeconds": 86400
}
```

Network counters are cumulative, so compute throughput from the difference between two samples and discard negative deltas (counters reset on reboot or adapter restart). On Windows the counters, page file and process list come from a single long-lived PowerShell session (`Get-NetAdapterStatistics`, `Win32_PageFileUsage`, `Get-Process`; ~15–60 ms per query once warm). If PowerShell isn't available, network totals fall back to `netstat -e`, whose 32-bit counters wrap at 4 GiB.

#### `GET /api/v1/metrics/processes`

Query parameters: `sort` = `cpu` (default) or `memory`; `limit` = 1–500 (default 10).

| Field                     | Type             | Description                                                                                       |
| ------------------------- | ---------------- | ------------------------------------------------------------------------------------------------- |
| `timestamp`               | `string`         | ISO timestamp of the sample                                                                       |
| `totalCount`              | `number`         | Processes running, before `limit`                                                                 |
| `processes[].pid`         | `number`         | Process ID                                                                                        |
| `processes[].name`        | `string`         | Process name                                                                                      |
| `processes[].cpuPercent`  | `number \| null` | Share of the whole machine's CPU since the previous sample, 0–100; `null` if not readable as a normal user |
| `processes[].memoryBytes` | `number`         | Resident memory (Linux RSS, Windows working set)                                                  |

```json
{
  "timestamp": "2026-10-13T19:17:54.546Z",
  "totalCount": 328,
  "processes": [
    { "pid": 27208, "name": "GitHubDesktop", "cpuPercent": 4.67, "memoryBytes": 145072128 },
    { "pid": 2764, "name": "Code", "cpuPercent": 0.78, "memoryBytes": 666566656 }
  ]
}
```

The first request takes ~0.5 s longer because the agent needs two snapshots to compute CPU %. Returns `501` on platforms without a process collector (e.g. macOS).

#### `GET /api/v1/metrics/connections`

Where the machine's traffic goes: every TCP connection with its owning process, plus the ports it listens on.

| Field                        | Type             | Description                                                                                         |
| ---------------------------- | ---------------- | --------------------------------------------------------------------------------------------------- |
| `connections[]`              | `array`          | TCP connections that aren't listening sockets                                                       |
| `connections[].localAddress` / `localPort`   | | This side of the connection                                                             |
| `connections[].remoteAddress` / `remotePort` | | The other side                                                                          |
| `connections[].state`        | `string`         | `established`, `time_wait`, `close_wait`, `syn_sent`, `syn_received`, `fin_wait`, `closing`, `last_ack`, `closed` |
| `connections[].pid` / `processName` | `number \| null` / `string \| null` | Owning process; `null` when owned by another user (Linux, without root) or the system |
| `connections[].scope`        | `string`         | `loopback` (this machine), `lan` (private ranges incl. Tailscale/CGNAT and IPv6 ULA/link-local) or `internet` |
| `connections[].remoteHost`   | `string \| null` | Reverse-DNS name of the remote address, looked up in the background and cached for 30 min, so it appears from the next poll on |
| `listening[]`                | `array`          | TCP listening sockets and bound UDP ports: `protocol`, `address`, `port`, `pid`, `processName`, `exposed` (bound to all/non-loopback interfaces) |

On Windows this comes from `Get-NetTCPConnection`/`Get-NetUDPEndpoint` (state names don't depend on the UI language; ~0.3–0.5 s per call). On Linux from `/proc/net/{tcp,tcp6,udp,udp6}`, with owners found via `/proc/<pid>/fd`. Per-connection byte counts aren't available without admin rights, so the app shows connection counts per destination and process, and total throughput from `/metrics`.

#### `POST /api/v1/diagnostics`

Runs one network test **from the agent's machine**, to tell whether a problem is local, DNS or along the route. Body:

| `type`       | Extra fields               | Result                                                                                              |
| ------------ | -------------------------- | --------------------------------------------------------------------------------------------------- |
| `ping`       | `count` 1–10 (default 5)   | `address`, `sent`, `received`, `lossPercent`, `samples` (ms per probe, `null` = lost), `minMs`, `avgMs`, `maxMs`, `jitterMs` |
| `traceroute` | –                          | `address`, `hops[]` (`ttl`, `address`, `host` from reverse DNS, `rttMs`, `scope`), `reached`         |
| `dns`        | –                          | `servers`, `resolver` (direct A/AAAA query) and `system` (OS lookup incl. hosts file): `addresses`, `durationMs`, `error` |
| `tcp`        | `port` 1–65535             | `address`, `connected`, `connectMs`, `error`                                                         |

Every body needs a `target`: a hostname or IP. Every result also has `type`, `target`, `startedAt` and `durationMs`.

- Names are resolved first; an unresolvable name returns `422` with the DNS error code. A refused or unreachable TCP port is a result (`connected: false`), not an error.
- No admin rights needed. On Windows, ping and traceroute use .NET's `Ping` class through PowerShell (TTL-limited probes for the route), so output doesn't depend on the UI language. On Linux they use `ping` and `traceroute` (or `tracepath`) with `LC_ALL=C`.
- Only a validated IP literal reaches a command line, and nothing runs through a shell.
- One test runs at a time per agent (`429` otherwise). A traceroute takes up to ~20 s on a bad route (20 hops, 1 s timeout each).

#### Pairing endpoints

- `POST /api/v1/pairing-codes` → `201 { code, expiresAt, urls, link, localOnly }`. `link` is what the QR code encodes. `localOnly` is true when the agent only listens on 127.0.0.1, so other devices can't reach it.
- `POST /api/v1/pair` with `{ "code": "G7KA-MTBH", "deviceName": "HostLens on Android" }` → `201 { deviceId, token, hostname, agentVersion }`. The code is case-insensitive and dashes are ignored. A used, expired or wrong code returns `401`.
- `GET /api/v1/devices` → `[{ id, name, createdAt, lastSeenAt, current }]`, where `current` marks the calling device.

## Desktop program

`HostLens-program/` is a [Tauri 2](https://tauri.app/) desktop app with a React + TypeScript frontend.

### Features

The interface follows the layout of [Reach](https://github.com/alexandrosnt/Reach): an icon rail, a searchable list panel and a detail view, dark by default (light and system themes in Settings), with Inter and JetBrains Mono bundled. On phone-width screens the rail becomes a bottom tab bar and list and detail take turns, ready for an Android build.

- **Overview:** greeting with a one-line health summary; tiles for hosts online, monitors up, FiveM players online and active alerts; a card per host (CPU/RAM/disk gauges and a CPU chart) and per monitor (players, response time, 24 h uptime and an hourly uptime strip); recent alerts.
- **Hosts** (agents): add by **pairing**. Scan the agent's QR code (phone), or paste its pairing link or type its code (desktop). The app gets its own revocable token. The master token can still be entered by hand. Each host is polled once per second. The host page has three tabs:
  - **Overview:** gauges (CPU, memory, swap/page file, fullest disk), uptime, live network rates and load average, interactive 60-second charts for CPU, memory and network (hover for values), a GPU card (load, VRAM, temperature, power, fan, clocks and a history chart, NVIDIA for now), per-interface rates, disks, system info, a top-10 process table (by CPU or memory, every 2 s) and a per-core heat grid.
  - **Network:** where the traffic goes. Shows connection counts (internet, local network, this machine) and open TCP ports reachable from other machines. *Top destinations* groups outgoing connections by domain (from reverse DNS) and incoming ones by service, e.g. "Clients of FiveM (:30120)". *By process* lists which programs hold connections. There's a searchable connection table (process, remote host, service, direction, state) and a list of listening ports. Polled every 3 s while the tab is open.
  - **Diagnostics:** a one-click **connectivity check** traces the route to 1.1.1.1, pings it and resolves google.com. It then says in plain words whether the problem is the local network (router not answering), the internet connection (and at which hop traffic stops), DNS, packet loss or high latency. Separate ping, traceroute, DNS and TCP-port tests show probe bars, hop lists with names and timing, and resolver results. All tests run on the host, not on the device running the app.
  - **Devices:** every device paired with that agent, with last-seen time and a remove button. **Pair device** in the header shows a single-use QR code for another device and confirms when it has paired.

  If an agent rejects the token (e.g. the device was removed), the page lets you enter a new one.
- **Monitors:**
  - **FiveM servers**, added by IP/host (port 30120 by default), `http://host:port`, or a `cfx.re/join/…` link or bare join code (looked up in the Cfx.re server list; looked up again every 10 min while the server is down, in case its address changed). Reads the server's public `dynamic.json` (up/down, name, player count), `players.json` (player list with ping; servers that anonymize it show the count only) and every 10 minutes `info.json` (icon, project name and description, tags, build, game build, resources, OneSync, locale, txAdmin version). The page shows the server card, a players gauge and chart, and a searchable player list.
  - **Websites/APIs** (HTTP(S), up if the response is below 400, following redirects) and **TCP ports**.
  - Every monitor has its own interval (10 s–5 min) and a **report**: 24 h and 7 d uptime, response time, outages, a 7-day hourly uptime strip (48 h on phones), a response-time chart and an outage log with durations and causes. Results are rolled up into hourly buckets and outages kept for 7 days, so reports survive restarts. An outage that ended while the app was closed is marked "≤" because its end time is only an upper bound. **Report** posts a summary to Discord.
- **Alerts:** rules for *monitor down*, *host offline*, *high CPU*, *high memory* and *disk nearly full*, each with an on/off switch, a threshold (where it applies) and how long the condition must hold. Defaults: a monitor down for 60 s; a host offline for 60 s; CPU or memory above 90 % for 120 s; a disk above 90 %, immediately. Alerts resolve automatically, can be acknowledged, and are kept in a history (last 200). Firing and recovery are posted to an optional **Discord webhook**; recoveries include how long the outage lasted, and FiveM messages include the player count.

Network requests are made from the Rust side (`src-tauri/src/lib.rs`), so nothing needs CORS headers:

- `agent_request`: call an allow-listed agent endpoint (method + path) with this device's token as a bearer header.
- `run_service_check`: run one HTTP or TCP check with a timeout.
- `fetch_fivem`: query a FiveM server's `dynamic.json`, plus `players.json` and (when asked) `info.json`.
- `resolve_cfx_join`: turn a `cfx.re/join` code into the server's address using the Cfx.re server list.
- `send_discord_webhook`: post a message (cut to 2000 characters); only Discord webhook URLs (`discord.com`, `discordapp.com`, `ptb.`/`canary.discord.com`) are accepted.

Settings, hosts, monitors, reports and alert history are stored in the webview's `localStorage`. Monitors and alerts only run while the app is open.

### Requirements

- Node.js and pnpm
- Rust toolchain and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS

### Running

```sh
cd HostLens-program
pnpm install
pnpm tauri dev      # development
pnpm tauri build    # production bundle
```

To add a host, start an agent first (see above), then use **Add host** and enter its URL and token. FiveM servers, websites and ports go under **Add monitor**. Discord and alert rules are in **Settings**.

### Working on the UI in a browser

`pnpm dev` and opening <http://localhost:1420> in a normal browser runs the UI without Tauri: `src/dev/browserPreview.ts` answers the Rust commands with simulated hosts, a FiveM server with players, a server that's down and a week of report history. It's only loaded in development outside Tauri and isn't part of production builds.

### Tests

```sh
cd agent && pnpm typecheck && pnpm test
cd HostLens-program && pnpm build          # typechecks the app and the agent API types
cd HostLens-program/src-tauri
cargo test                    # offline tests
cargo test -- --ignored       # also queries a live public FiveM server and the Cfx.re API
```

GitHub Actions runs the same checks for every push and same-repo pull request on **self-hosted runners** (`.github/workflows/ci.yml`): Windows by default, plus Linux when the repository variable `CI_PLATFORMS` is `["windows","linux"]`. Pull requests from forks don't run CI, so nobody else's code runs on those machines. Pushing a `v*` tag builds Windows and Linux installers plus an agent archive into a draft release (`release.yml`). See [CONTRIBUTING.md](CONTRIBUTING.md).
