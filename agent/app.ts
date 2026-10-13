import { readFileSync } from 'node:fs';
import os from 'node:os';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { buildConnections, platform, sampleCpu, sampleProcesses } from './collectors/index.ts';
import type { Config } from './config.ts';
import { DeviceStore, PairingCodes } from './devices.ts';
import { agentUrls, localOnly, pairingLink } from './pairing.ts';
import { originGuard, requireToken, type AuthEnv } from './security.ts';
import type {
    AgentInfo,
    ErrorResponse,
    HealthResponse,
    MetricsResponse,
    PairingCodeResponse,
    PairRequest,
    PairResponse,
    ProcessesResponse,
} from './types.ts';

export const agentVersion: string = (
    JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }
).version;

const PROCESS_LIMIT_DEFAULT = 10;
const PROCESS_LIMIT_MAX = 500;

const PAIR_PATH = '/api/v1/pair';

export interface AppDeps {
    devices: DeviceStore;
    pairing: PairingCodes;
}

export function createApp(
    config: Pick<Config, 'token' | 'allowedOrigins' | 'host' | 'port'>,
    deps: AppDeps = { devices: new DeviceStore(null), pairing: new PairingCodes() },
) {
    const { devices, pairing } = deps;
    // The OS name doesn't change while we're running; read it once.
    const osName = platform.osName().catch(() => os.version());

    const app = new Hono<AuthEnv>();

    app.use('*', originGuard(config.allowedOrigins));
    // Only reached by origins that passed the guard; answers preflights before auth.
    app.use(
        '*',
        cors({
            origin: config.allowedOrigins,
            allowMethods: ['GET', 'POST', 'DELETE'],
            allowHeaders: ['Authorization', 'Content-Type'],
        }),
    );
    // Pairing is how a new device gets a token, so it can't require one; the single-use code is the credential.
    app.use('/api/*', requireToken(config.token, devices, [PAIR_PATH]));

    // Liveness check; deliberately unauthenticated and free of host details.
    app.get('/health', (c) => c.json<HealthResponse>({ status: 'ok', agentVersion }));

    app.get('/api/v1/info', async (c) => {
        const cpus = os.cpus();
        const info: AgentInfo = {
            hostname: os.hostname(),
            platform: process.platform,
            osName: await osName,
            osRelease: os.release(),
            arch: os.arch(),
            cpuModel: cpus[0]?.model.trim() ?? 'unknown',
            logicalCores: cpus.length,
            totalMemoryBytes: os.totalmem(),
            bootTime: new Date(Date.now() - os.uptime() * 1000).toISOString(),
            agentVersion,
        };
        return c.json(info);
    });

    app.get('/api/v1/metrics', async (c) => {
        // A metric that can't be read degrades to an empty value instead of failing the whole response.
        const [cpu, memory, disk, network] = await Promise.all([
            sampleCpu(),
            platform.memory(),
            platform.disks().catch(() => []),
            platform.network().catch(() => null),
        ]);
        const metrics: MetricsResponse = {
            timestamp: new Date().toISOString(),
            cpu,
            memory,
            disk,
            network,
            uptimeSeconds: Math.floor(os.uptime()),
        };
        return c.json(metrics);
    });

    app.get('/api/v1/metrics/processes', async (c) => {
        const sort = c.req.query('sort') ?? 'cpu';
        const limit = Number(c.req.query('limit') ?? PROCESS_LIMIT_DEFAULT);
        if (sort !== 'cpu' && sort !== 'memory') {
            return c.json<ErrorResponse>({ error: 'sort must be "cpu" or "memory"' }, 400);
        }
        if (!Number.isInteger(limit) || limit < 1 || limit > PROCESS_LIMIT_MAX) {
            return c.json<ErrorResponse>({ error: `limit must be an integer from 1 to ${PROCESS_LIMIT_MAX}` }, 400);
        }

        const all = await sampleProcesses(platform.processes).catch(() => null);
        if (!all) return c.json<ErrorResponse>({ error: 'process list is not available on this platform' }, 501);

        const value = (p: (typeof all)[number]) => (sort === 'cpu' ? (p.cpuPercent ?? -1) : p.memoryBytes);
        const response: ProcessesResponse = {
            timestamp: new Date().toISOString(),
            totalCount: all.length,
            processes: [...all]
                // Ties (e.g. many idle processes at 0% CPU) are broken by memory.
                .sort((a, b) => value(b) - value(a) || b.memoryBytes - a.memoryBytes)
                .slice(0, limit),
        };
        return c.json(response);
    });

    app.get('/api/v1/metrics/connections', async (c) => {
        const raw = await platform.sockets().catch(() => null);
        if (!raw) return c.json<ErrorResponse>({ error: 'connection list is not available on this platform' }, 501);
        return c.json(buildConnections(raw));
    });

    // ── Pairing & devices ──────────────────────────────────────────

    /** Creates a single-use pairing code, shown as a QR code by the CLI or the app. */
    app.post('/api/v1/pairing-codes', (c) => {
        const { code, expiresAt } = pairing.create();
        const urls = agentUrls(config.host, config.port);
        const response: PairingCodeResponse = {
            code,
            expiresAt: new Date(expiresAt).toISOString(),
            urls,
            link: pairingLink(urls, code, os.hostname()),
            localOnly: localOnly(urls),
        };
        return c.json(response, 201);
    });

    app.post(PAIR_PATH, async (c) => {
        const body = (await c.req.json().catch(() => null)) as Partial<PairRequest> | null;
        if (typeof body?.code !== 'string' || typeof body.deviceName !== 'string') {
            return c.json<ErrorResponse>({ error: 'body must be { code, deviceName }' }, 400);
        }
        const result = pairing.consume(body.code);
        if (result === 'locked') {
            return c.json<ErrorResponse>({ error: 'too many wrong codes, try again in a few minutes' }, 429);
        }
        if (result === 'invalid') {
            return c.json<ErrorResponse>({ error: 'pairing code is wrong, expired or already used' }, 401);
        }
        const { device, token } = devices.add(body.deviceName);
        console.log(`Paired new device "${device.name}"`);
        return c.json<PairResponse>({ deviceId: device.id, token, hostname: os.hostname(), agentVersion }, 201);
    });

    app.get('/api/v1/devices', (c) => {
        const caller = c.get('caller');
        return c.json(devices.list(caller.kind === 'device' ? caller.id : undefined));
    });

    app.delete('/api/v1/devices/:id', (c) => {
        if (!devices.revoke(c.req.param('id'))) return c.json<ErrorResponse>({ error: 'no such device' }, 404);
        return c.body(null, 204);
    });

    app.notFound((c) => c.json<ErrorResponse>({ error: 'not found' }, 404));
    app.onError((err, c) => {
        console.error(err);
        return c.json<ErrorResponse>({ error: 'internal error' }, 500);
    });

    return app;
}
