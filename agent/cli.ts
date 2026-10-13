// Talks to the running agent with the master token:
//   node cli.ts pair            show a new single-use pairing QR code
//   node cli.ts devices         list paired devices
//   node cli.ts revoke <id>     remove a device (its token stops working)
import { isLoopback, loadConfig } from './config.ts';
import { printPairing } from './terminal.ts';
import type { DeviceInfo, ErrorResponse, PairingCodeResponse } from './types.ts';

const config = loadConfig();
// A wildcard bind is reachable on loopback too.
const host = config.host === '0.0.0.0' || config.host === '::' || isLoopback(config.host) ? '127.0.0.1' : config.host;
const base = `http://${host.includes(':') ? `[${host}]` : host}:${config.port}`;

async function call<T>(method: string, path: string): Promise<T> {
    let res: Response;
    try {
        res = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${config.token}` } });
    } catch {
        throw new Error(`Can't reach the agent at ${base}. Is it running (pnpm start)?`);
    }
    if (!res.ok) {
        const body = (await res.json().catch(() => ({ error: res.statusText }))) as ErrorResponse;
        throw new Error(`${res.status}: ${body.error}`);
    }
    return (res.status === 204 ? null : await res.json()) as T;
}

const [command, arg] = process.argv.slice(2);

try {
    if (command === 'pair') {
        await printPairing(await call<PairingCodeResponse>('POST', '/api/v1/pairing-codes'));
    } else if (command === 'devices') {
        const list = await call<DeviceInfo[]>('GET', '/api/v1/devices');
        if (!list.length) console.log('No paired devices. Run: pnpm pair');
        for (const d of list) {
            const seen = d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : 'never';
            console.log(`${d.id}  ${d.name}  (paired ${new Date(d.createdAt).toLocaleDateString()}, last seen ${seen})`);
        }
    } else if (command === 'revoke' && arg) {
        await call('DELETE', `/api/v1/devices/${encodeURIComponent(arg)}`);
        console.log('Device removed.');
    } else {
        console.log('Usage: node cli.ts pair | devices | revoke <device id>');
        process.exitCode = 1;
    }
} catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
}
