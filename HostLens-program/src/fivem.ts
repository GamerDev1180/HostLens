// FiveM (FXServer) servers publish their state over plain HTTP on the game
// port: dynamic.json (name, player count), info.json (convars, resources,
// build, icon) and players.json. Fields are loosely typed (numbers arrive as
// strings on some builds), so everything here is parsed defensively.

export const FIVEM_DEFAULT_PORT = 30120;

export interface FiveMPlayer {
  id: number;
  name: string;
  ping: number;
}

export interface FiveMInfo {
  /** e.g. "FXServer-master SERVER v1.0.0.35419 win32" */
  server: string | null;
  /** Build number parsed from `server`, e.g. 35419. */
  build: number | null;
  resources: number | null;
  projectName: string | null;
  projectDesc: string | null;
  tags: string[];
  locale: string | null;
  onesync: boolean | null;
  gameBuild: string | null;
  txAdminVersion: string | null;
  /** data: URL of the server icon. */
  icon: string | null;
}

export interface FiveMStatus {
  hostname: string;
  clients: number;
  maxClients: number;
  gametype: string;
  mapname: string;
  /** `null` if the server doesn't publish players.json. */
  players: FiveMPlayer[] | null;
  /** True when the server hides names (every player is "Player" with id 0). */
  playersAnonymized: boolean;
  /** Fetched less often than the rest; `null` until the first fetch succeeds. */
  info: FiveMInfo | null;
}

/** Raw response of the `fetch_fivem` Rust command. */
export interface FiveMRaw {
  latencyMs: number;
  dynamic: unknown;
  info: unknown | null;
  players: unknown | null;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === "string" ? v : typeof v === "number" ? String(v) : null);
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Removes FiveM (^1) and GTA (~r~) text colour codes. */
export const stripColors = (s: string) =>
  s.replace(/\^\d/g, "").replace(/~[a-zA-Z]~/g, "").replace(/\s+/g, " ").trim();

export function parseInfo(raw: unknown): FiveMInfo {
  const info = obj(raw);
  const vars = obj(info.vars);
  const server = str(info.server);
  const buildMatch = server ? /v\d+\.\d+\.\d+\.(\d+)/.exec(server) : null;
  const icon = str(info.icon);
  const onesync = str(vars.onesync_enabled);
  return {
    server,
    build: buildMatch ? Number(buildMatch[1]) : null,
    resources: Array.isArray(info.resources) ? info.resources.length : null,
    projectName: str(vars.sv_projectName) ? stripColors(str(vars.sv_projectName)!) : null,
    projectDesc: str(vars.sv_projectDesc) ? stripColors(str(vars.sv_projectDesc)!) : null,
    tags: (str(vars.tags) ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 12),
    locale: str(vars.locale),
    onesync: onesync === null ? null : onesync === "true",
    gameBuild: str(vars.sv_enforceGameBuild),
    txAdminVersion: str(vars["txAdmin-version"]),
    icon: icon ? `data:image/png;base64,${icon}` : null,
  };
}

export function parseStatus(raw: FiveMRaw, previousInfo: FiveMInfo | null): FiveMStatus {
  const dynamic = obj(raw.dynamic);
  const players = Array.isArray(raw.players)
    ? raw.players.map((p) => {
        const o = obj(p);
        return { id: num(o.id) ?? 0, name: stripColors(str(o.name) ?? "?"), ping: num(o.ping) ?? 0 };
      })
    : null;
  return {
    hostname: stripColors(str(dynamic.hostname) ?? ""),
    clients: num(dynamic.clients) ?? players?.length ?? 0,
    maxClients: num(dynamic.sv_maxclients) ?? 0,
    gametype: str(dynamic.gametype) ?? "",
    mapname: str(dynamic.mapname) ?? "",
    players,
    playersAnonymized: !!players?.length && players.every((p) => p.id === 0 && p.name === "Player"),
    info: raw.info ? parseInfo(raw.info) : previousInfo,
  };
}

/** Name to show: the project name if set, else the hostname. */
export const displayName = (s: FiveMStatus) => s.info?.projectName || s.hostname;

/** What the user typed for a FiveM server. */
export type FiveMAddress = { kind: "url"; baseUrl: string } | { kind: "join"; code: string };

/**
 * Accepts "1.2.3.4", "1.2.3.4:30120", "play.example.com:30120",
 * "http://host:port", "cfx.re/join/abc123" or a bare join code "abc123".
 */
export function parseFiveMAddress(input: string): FiveMAddress | { error: string } {
  const value = input.trim();
  const join = /^(?:https?:\/\/)?(?:www\.)?cfx\.re\/join\/([a-z0-9]+)\/?$/i.exec(value);
  if (join) return { kind: "join", code: join[1].toLowerCase() };
  // Join codes are 6 lowercase letters/digits; hostnames contain a dot.
  if (/^[a-z0-9]{6}$/i.test(value)) return { kind: "join", code: value.toLowerCase() };

  const withScheme = /^https?:\/\//i.test(value) ? value : `http://${value}`;
  try {
    const url = new URL(withScheme);
    if (!url.hostname) throw new Error();
    if (!url.port && !/^https?:\/\//i.test(value)) url.port = String(FIVEM_DEFAULT_PORT);
    return { kind: "url", baseUrl: `${url.protocol}//${url.host}` };
  } catch {
    return { error: "Enter an IP or host (port 30120 by default), or a cfx.re/join link" };
  }
}
