import os from 'node:os';
import { serve } from '@hono/node-server';
import { agentVersion, createApp } from './app.ts';
import { isLoopback, loadConfig } from './config.ts';
import { DeviceStore, PairingCodes } from './devices.ts';
import { agentUrls, localOnly, pairingLink } from './pairing.ts';
import { printPairing } from './terminal.ts';

const config = loadConfig();
const devices = new DeviceStore(config.devicesFile);
const pairing = new PairingCodes();
const app = createApp(config, { devices, pairing });

serve({ fetch: app.fetch, hostname: config.host, port: config.port }, async ({ address, port }) => {
    const shownHost = address.includes(':') ? `[${address}]` : address;
    console.log(`HostLens agent ${agentVersion} listening on http://${shownHost}:${port}`);
    // The master token is never printed; devices pair with single-use codes instead.
    console.log(`Master token: ${config.tokenSource === 'HOSTLENS_TOKEN' ? 'from HOSTLENS_TOKEN' : `stored in ${config.tokenSource}`}`);
    if (!isLoopback(config.host)) {
        console.warn(
            `Warning: bound to ${config.host}, so the API is reachable from other machines. ` +
                'Traffic is plain HTTP; only do this on a trusted network.',
        );
    }

    if (devices.count === 0) {
        // First run: show a pairing code right away so the app can connect.
        const { code, expiresAt } = pairing.create();
        const urls = agentUrls(config.host, config.port);
        await printPairing({
            code,
            expiresAt: new Date(expiresAt).toISOString(),
            urls,
            link: pairingLink(urls, code, os.hostname()),
            localOnly: localOnly(urls),
        });
    } else {
        console.log(`${devices.count} paired device${devices.count === 1 ? '' : 's'}. To pair another, run: pnpm pair`);
    }
});
