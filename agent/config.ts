import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';

// Runtime configuration, all from environment variables:
//   HOSTLENS_HOST             interface to bind (default 127.0.0.1 — local only)
//   HOSTLENS_PORT             port to listen on (default 47821)
//   HOSTLENS_TOKEN            master API token; if unset, one is generated and stored in HOSTLENS_TOKEN_FILE
//   HOSTLENS_TOKEN_FILE       where the generated token is kept (default: per-user config dir)
//   HOSTLENS_DEVICES_FILE     where paired devices are kept (default: per-user config dir)
//   HOSTLENS_ALLOWED_ORIGINS  comma-separated browser origins allowed to call the API (default: none)

// Unregistered high port, so the agent doesn't clash with common dev servers on 8080.
export const DEFAULT_PORT = 47821;

export interface Config {
    host: string;
    port: number;
    /** Master token: full access, used by the CLI and for manual setup. Devices get their own tokens by pairing. */
    token: string;
    /** Where the token came from, for the startup message. */
    tokenSource: string;
    devicesFile: string;
    allowedOrigins: string[];
}

export function configDir(): string {
    if (process.platform === 'win32') {
        return join(process.env.APPDATA ?? join(os.homedir(), 'AppData', 'Roaming'), 'HostLens');
    }
    return join(process.env.XDG_CONFIG_HOME ?? join(os.homedir(), '.config'), 'hostlens');
}

function loadOrCreateToken(file: string): string {
    try {
        const existing = readFileSync(file, 'utf8').trim();
        if (existing) return existing;
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const token = randomBytes(32).toString('base64url');
    mkdirSync(dirname(file), { recursive: true });
    // Readable by the current user only (the mode is ignored on Windows, where
    // the per-user AppData directory already restricts access).
    writeFileSync(file, `${token}\n`, { mode: 0o600 });
    return token;
}

function parsePort(value: string | undefined): number {
    if (value === undefined) return DEFAULT_PORT;
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`HOSTLENS_PORT must be an integer between 1 and 65535, got "${value}"`);
    }
    return port;
}

export function loadConfig(): Config {
    const envToken = process.env.HOSTLENS_TOKEN?.trim();
    const tokenFile = process.env.HOSTLENS_TOKEN_FILE ?? join(configDir(), 'agent-token');

    return {
        host: process.env.HOSTLENS_HOST?.trim() || '127.0.0.1',
        port: parsePort(process.env.HOSTLENS_PORT),
        token: envToken || loadOrCreateToken(tokenFile),
        tokenSource: envToken ? 'HOSTLENS_TOKEN' : tokenFile,
        devicesFile: process.env.HOSTLENS_DEVICES_FILE ?? join(configDir(), 'devices.json'),
        allowedOrigins: (process.env.HOSTLENS_ALLOWED_ORIGINS ?? '')
            .split(',')
            .map((o) => o.trim())
            .filter(Boolean),
    };
}

export const isLoopback = (host: string) =>
    host === 'localhost' || host === '::1' || host.startsWith('127.');
