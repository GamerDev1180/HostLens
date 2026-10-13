import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import { shutdown } from '../collectors/powershell.ts';
import { DeviceStore, PairingCodes } from '../devices.ts';
import type {
    AgentInfo,
    ConnectionsResponse,
    DeviceInfo,
    MetricsResponse,
    PairingCodeResponse,
    PairResponse,
    ProcessesResponse,
} from '../types.ts';

// These tests run against the real collectors of whatever OS runs them, so they
// check the response contract (shape, units, ranges), not specific values.

const TOKEN = 'test-token';
const config = { token: TOKEN, allowedOrigins: ['http://allowed.example'], host: '127.0.0.1', port: 47821 };
const app = createApp(config);
const auth = { Authorization: `Bearer ${TOKEN}` };

const get = (path: string, headers: Record<string, string> = auth) => app.request(path, { headers });

const isPercent = (n: unknown) => typeof n === 'number' && n >= 0 && n <= 100;
const isBytes = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0;

afterAll(() => shutdown());

describe('security', () => {
    it('serves /health without a token', async () => {
        const res = await get('/health', {});
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ status: 'ok', agentVersion: expect.any(String) });
    });

    it.each(['/api/v1/info', '/api/v1/metrics', '/api/v1/metrics/processes', '/api/v1/metrics/connections', '/api/v1/devices'])('rejects %s without a token', async (path) => {
        const res = await get(path, {});
        expect(res.status).toBe(401);
        expect(res.headers.get('WWW-Authenticate')).toBe('Bearer');
        expect(await res.json()).toEqual({ error: 'unauthorized' });
    });

    it('rejects a wrong token', async () => {
        expect((await get('/api/v1/info', { Authorization: 'Bearer nope' })).status).toBe(401);
    });

    it('rejects unknown browser origins, even with a valid token', async () => {
        const res = await get('/api/v1/info', { ...auth, Origin: 'https://evil.example' });
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'origin not allowed' });
    });

    it('allows configured origins with CORS headers and preflight', async () => {
        const res = await get('/api/v1/info', { ...auth, Origin: 'http://allowed.example' });
        expect(res.status).toBe(200);
        expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://allowed.example');

        const preflight = await app.request('/api/v1/info', {
            method: 'OPTIONS',
            headers: { Origin: 'http://allowed.example', 'Access-Control-Request-Method': 'GET' },
        });
        expect(preflight.status).toBe(204);
    });

    it('returns JSON 404s', async () => {
        const res = await get('/nope');
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'not found' });
    });
});

describe('GET /api/v1/info', () => {
    it('describes the host', async () => {
        const res = await get('/api/v1/info');
        expect(res.status).toBe(200);
        const info = (await res.json()) as AgentInfo;
        expect(info).toEqual({
            hostname: expect.any(String),
            platform: process.platform,
            osName: expect.any(String),
            osRelease: expect.any(String),
            arch: expect.any(String),
            cpuModel: expect.any(String),
            logicalCores: expect.any(Number),
            totalMemoryBytes: expect.any(Number),
            bootTime: expect.any(String),
            agentVersion: expect.any(String),
        });
        expect(info.logicalCores).toBeGreaterThan(0);
        expect(Number.isNaN(Date.parse(info.bootTime))).toBe(false);
    });
});

describe('GET /api/v1/metrics', () => {
    it('returns a snapshot in the documented format', { timeout: 15_000 }, async () => {
        const res = await get('/api/v1/metrics');
        expect(res.status).toBe(200);
        const m = (await res.json()) as MetricsResponse;

        expect(Number.isNaN(Date.parse(m.timestamp))).toBe(false);
        expect(m.uptimeSeconds).toBeGreaterThan(0);

        expect(isPercent(m.cpu.usagePercent)).toBe(true);
        expect(m.cpu.perCorePercent).toHaveLength(m.cpu.logicalCores);
        expect(m.cpu.perCorePercent.every(isPercent)).toBe(true);
        if (process.platform === 'win32') expect(m.cpu.loadAverage).toBeNull();
        else expect(m.cpu.loadAverage).toHaveLength(3);

        expect(m.memory.totalBytes).toBeGreaterThan(0);
        expect(m.memory.usedBytes).toBeLessThanOrEqual(m.memory.totalBytes);
        expect(isPercent(m.memory.usagePercent)).toBe(true);
        if (m.memory.swap) {
            expect(isBytes(m.memory.swap.totalBytes)).toBe(true);
            expect(isPercent(m.memory.swap.usagePercent)).toBe(true);
        }

        expect(Array.isArray(m.disk)).toBe(true);
        for (const d of m.disk) {
            expect(d.mount).toEqual(expect.any(String));
            expect(d.totalBytes).toBeGreaterThan(0);
            expect(d.usedBytes + d.freeBytes).toBeLessThanOrEqual(d.totalBytes);
            expect(isPercent(d.usagePercent)).toBe(true);
        }

        if (m.network) {
            expect(isBytes(m.network.receivedBytes)).toBe(true);
            expect(isBytes(m.network.sentBytes)).toBe(true);
            for (const i of m.network.interfaces) {
                expect(i.name).toEqual(expect.any(String));
                expect(isBytes(i.receivedBytes) && isBytes(i.sentBytes)).toBe(true);
            }
        }
    });
});

describe('GET /api/v1/metrics/processes', () => {
    it.each([
        ['sort=disk', 'sort'],
        ['limit=0', 'limit'],
        ['limit=abc', 'limit'],
        ['limit=501', 'limit'],
    ])('rejects %s', async (query, field) => {
        const res = await get(`/api/v1/metrics/processes?${query}`);
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toContain(field);
    });

    it('returns the top processes, sorted and limited', { timeout: 15_000 }, async () => {
        const res = await get('/api/v1/metrics/processes?sort=memory&limit=5');
        if (res.status === 501) return; // platform without a process collector
        expect(res.status).toBe(200);
        const body = (await res.json()) as ProcessesResponse;

        expect(body.totalCount).toBeGreaterThan(0);
        expect(body.processes.length).toBe(Math.min(5, body.totalCount));
        for (const p of body.processes) {
            expect(p.pid).toEqual(expect.any(Number));
            expect(p.name).toEqual(expect.any(String));
            expect(p.cpuPercent === null || isPercent(p.cpuPercent)).toBe(true);
            expect(isBytes(p.memoryBytes)).toBe(true);
        }
        const memory = body.processes.map((p) => p.memoryBytes);
        expect(memory).toEqual([...memory].sort((a, b) => b - a));
    });
});

describe('GET /api/v1/metrics/connections', () => {
    it('lists connections and listening ports', { timeout: 15_000 }, async () => {
        const res = await get('/api/v1/metrics/connections');
        if (res.status === 501) return; // platform without a socket collector
        expect(res.status).toBe(200);
        const body = (await res.json()) as ConnectionsResponse;
        expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
        // The test runner itself has sockets open, so there's always something listed.
        expect(body.connections.length + body.listening.length).toBeGreaterThan(0);
        for (const c of body.connections) {
            expect(c.protocol).toBe('tcp');
            expect(c.state).not.toBe('listen');
            expect(['loopback', 'lan', 'internet']).toContain(c.scope);
            expect(c.remotePort).toEqual(expect.any(Number));
        }
        for (const l of body.listening) {
            expect(['tcp', 'udp']).toContain(l.protocol);
            expect(l.port).toBeGreaterThanOrEqual(0);
            expect(typeof l.exposed).toBe('boolean');
        }
    });
});

describe('pairing', () => {
    const post = (a: ReturnType<typeof createApp>, path: string, body?: unknown, headers: Record<string, string> = auth) =>
        a.request(path, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: body === undefined ? null : JSON.stringify(body),
        });

    it('pairs a device with a single-use code, then lets it in with its own token', async () => {
        const a = createApp(config, { devices: new DeviceStore(null), pairing: new PairingCodes() });

        const codeRes = await post(a, '/api/v1/pairing-codes');
        expect(codeRes.status).toBe(201);
        const pairing = (await codeRes.json()) as PairingCodeResponse;
        expect(pairing.code).toMatch(/^[A-Z2-9]{8}$/);
        expect(pairing.urls).toEqual(['http://127.0.0.1:47821']);
        expect(pairing.localOnly).toBe(true);
        expect(pairing.link).toContain(`code=${pairing.code}`);

        // No token needed to pair; the code is the credential. Dashes/lowercase are accepted.
        const formatted = `${pairing.code.slice(0, 4)}-${pairing.code.slice(4)}`.toLowerCase();
        const pairRes = await post(a, '/api/v1/pair', { code: formatted, deviceName: 'Test phone' }, {});
        expect(pairRes.status).toBe(201);
        const paired = (await pairRes.json()) as PairResponse;
        expect(paired.token).toEqual(expect.any(String));

        // The same code can't be used twice.
        expect((await post(a, '/api/v1/pair', { code: pairing.code, deviceName: 'Thief' }, {})).status).toBe(401);

        // The device token works and the device sees itself as current.
        const deviceAuth = { Authorization: `Bearer ${paired.token}` };
        const listRes = await a.request('/api/v1/devices', { headers: deviceAuth });
        expect(listRes.status).toBe(200);
        const list = (await listRes.json()) as DeviceInfo[];
        expect(list).toEqual([expect.objectContaining({ id: paired.deviceId, name: 'Test phone', current: true })]);

        // Revoking it locks it out.
        const del = await a.request(`/api/v1/devices/${paired.deviceId}`, { method: 'DELETE', headers: auth });
        expect(del.status).toBe(204);
        expect((await a.request('/api/v1/info', { headers: deviceAuth })).status).toBe(401);
    });

    it('rejects bad bodies and locks out after repeated wrong codes', async () => {
        const a = createApp(config, { devices: new DeviceStore(null), pairing: new PairingCodes() });
        expect((await post(a, '/api/v1/pair', { nope: 1 }, {})).status).toBe(400);
        const statuses = [];
        for (let i = 0; i < 11; i++) {
            statuses.push((await post(a, '/api/v1/pair', { code: 'WRONG000', deviceName: 'x' }, {})).status);
        }
        expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
        expect(statuses[10]).toBe(429);
    });

    it('requires auth to create pairing codes', async () => {
        expect((await post(app, '/api/v1/pairing-codes', undefined, {})).status).toBe(401);
    });
});
