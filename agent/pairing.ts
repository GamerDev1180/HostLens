import os from 'node:os';
import { isLoopback } from './config.ts';

// Which addresses a pairing QR code should point at. A phone can only use
// addresses it can route to, so the order is: home/office LAN first, then
// VPN/CGNAT ranges such as Tailscale (100.64.0.0/10), then anything else.

function rank(ip: string): number {
    if (/^(192\.168|10)\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 0;
    if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return 1;
    return 2;
}

/** URLs other devices can use to reach the agent, best first. */
export function agentUrls(
    host: string,
    port: number,
    interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string[] {
    const wildcard = host === '0.0.0.0' || host === '::';
    if (!wildcard) {
        const shown = host.includes(':') ? `[${host}]` : host;
        return [`http://${isLoopback(host) ? '127.0.0.1' : shown}:${port}`];
    }
    const ips = Object.values(interfaces)
        .flat()
        .filter((i): i is os.NetworkInterfaceInfo => !!i && !i.internal && i.family === 'IPv4')
        .map((i) => i.address)
        // Link-local addresses (no DHCP) can't be reached reliably.
        .filter((ip) => !ip.startsWith('169.254.'));
    const unique = [...new Set(ips)].sort((a, b) => rank(a) - rank(b));
    return unique.length ? unique.map((ip) => `http://${ip}:${port}`) : [`http://127.0.0.1:${port}`];
}

/** True when every URL is loopback, i.e. only this machine can pair. */
export const localOnly = (urls: string[]) => urls.every((u) => /\/\/(127\.|localhost|\[::1\])/.test(u));

/**
 * hostlens://pair?url=…&url=…&code=…&name=…
 * Several `url`s let the app try each until one answers (LAN at home, Tailscale away).
 */
export function pairingLink(urls: string[], code: string, name: string): string {
    const params = new URLSearchParams();
    for (const u of urls) params.append('url', u);
    params.set('code', code);
    params.set('name', name);
    return `hostlens://pair?${params}`;
}
