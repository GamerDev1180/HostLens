# Future ideas

Ideas that are planned but **not built yet**. New ideas go here first instead of straight into the code, so the current version can be finished and released.

## Agent

- **Separate metric endpoints**: `/api/v1/metrics/cpu`, `/memory`, `/disk`, `/network`, `/system` (process count, OS info). Only worth adding once a client needs one metric without the rest; `/api/v1/metrics` covers everything today.
- **GPU metrics**: `/api/v1/metrics/gpu` (utilization, temperature, memory). Depends on vendor tools (`nvidia-smi`, ROCm) and often on admin rights; must degrade to `null`.
- **Temperatures**: `/api/v1/metrics/temperatures`. Linux has `/sys/class/hwmon`; Windows mostly needs admin rights or vendor drivers.
- **macOS collector**: today macOS gets the generic fallback (no network, swap or processes).
- **Install as a service**: run on login (Windows Task Scheduler / systemd user unit) instead of starting it by hand.

## Central server (multi-machine)

From the original design: a central Hono API that agents **push** to, which works for servers behind NAT or firewalls, where the desktop app can't reach the agent.

- Servers: `GET/POST /api/v1/servers`, `GET/PATCH/DELETE /api/v1/servers/:id`, `POST /api/v1/servers/:id/rotate-key`.
- Ingestion and history: `POST /api/v1/servers/:id/metrics`, `GET …/metrics/latest`, `GET …/metrics/history?from=&to=&interval=`, `GET /api/v1/overview`.
- Agent management: `POST /api/v1/agents/enroll` with a short-lived, single-use enrollment token, then a separate per-agent credential; `POST /api/v1/agents/heartbeat`; agents poll for updates.
- Storage: SQLite with Drizzle ORM for long-term history.
- Server-side checks and alerts, so they keep running when the desktop app is closed. Today they only run while the app is open.
- Deployment with Docker Compose, plus installation and troubleshooting docs.

## Android (next)

The phone runs **only the HostLens app**: it connects to agents on PCs and servers, and no agent or API runs on the phone. Already in place: the phone layout (bottom tab bar, list/detail navigation, 48 h uptime strip), QR pairing (the barcode-scanner plugin is registered for Android/iOS only, with its camera permission in `capabilities/mobile.json`), and per-device tokens. Remaining:

- `pnpm tauri android init`, then a debug APK. An Android SDK is installed on the dev machine; still needed are the NDK, `JAVA_HOME`, and `rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android`.
- Background monitoring: Android pauses a backgrounded app, so monitors and alerts stop while it's not open. Options are an Android foreground service, or a small always-on "monitor" process on a PC/server (or the central server below) that runs checks and pushes alerts.
- Push notifications for alerts (Tauri's notification plugin while the app runs).
- Reaching agents from the phone: agents listen on 127.0.0.1 by default, so for a phone either start them with `HOSTLENS_HOST=0.0.0.0` on a trusted LAN, or use a VPN such as Tailscale (the pairing QR already lists Tailscale addresses).
- Open `hostlens://pair?...` links directly in the app (deep-link plugin), so a pairing link sent in chat opens HostLens.

## Desktop app

- Per-host and per-monitor alert rules (today rules apply to everything).
- FiveM-specific alerts: player count drops sharply, or the server is full for a long time.
- More notification destinations (email, Slack, ntfy) alongside Discord.
- Longer host-metric history than 60 s (monitors already keep 7 days of hourly reports).
- Scheduled reports (e.g. a daily FiveM uptime summary to Discord) instead of only the manual **Report** button.
- Tests: unit tests for the hooks (alert engine, `reports.ts`), Playwright end-to-end tests against the browser preview.
- Network monitor: bytes per connection/process (needs ETW on Windows, admin rights; `ss -ti` / eBPF on Linux), country of remote addresses (would need an offline GeoIP database), and alerts for new listening ports.
- HTTPS (or certificate pinning in the pairing QR) for agents used across untrusted networks; today traffic is plain HTTP and relies on LAN/VPN.

## Roadmap (from the diagnostics review)

Done: Windows/Linux CI and a release workflow, NVIDIA GPU metrics, network diagnostics (ping, traceroute, DNS, TCP, connectivity check). Next, roughly in order:

- **Diagnostics export**: a ZIP with system info, recent metrics/reports, alert history and a config summary, with tokens and webhook URLs removed.
- **Incident timeline**: one chronological feed of host disconnects, monitor outages, resource alerts and recoveries.
- **Disk performance**: read/write throughput and latency; longer CPU/RAM/network history to compare with earlier hours or days (baselines).
- **GPU**: AMD/Intel (Linux sysfs, Windows performance counters), GPU temperature alerts.
- **Smarter alerts**: cooldowns, maintenance windows, grouping related incidents, baseline-based alerts.
- **FiveM performance mode**: player/resource trends; optional server-side data where the owner allows it.
- **Background agent**: optional Windows service and tray icon (pause, open dashboard).
- **Contributor tooling**: structured agent logs, settings import/export (secrets removed), signed auto-updates.

## Release v0.1.0

- Screenshots in the README.
- `CONTRIBUTING.md` and some good-first-issues.
- Publish a GitHub release with built binaries.
