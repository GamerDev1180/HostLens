import { describe, expect, it } from 'vitest';
import { buildConnections, classify } from '../collectors/connections.ts';
import {
    decodeHexAddress,
    parseMeminfo,
    parseMounts,
    parseNetDev,
    parseOsRelease,
    parseProcNet,
    parseProcStat,
} from '../collectors/linux.ts';
import { parseNetstat, parseSockets } from '../collectors/windows.ts';
import { PairingCodes } from '../devices.ts';
import { agentUrls, localOnly, pairingLink } from '../pairing.ts';

// Platform parsers tested against captured file/command output, so the Linux
// collectors are covered even when the tests run on Windows and vice versa.

describe('linux parsers', () => {
    it('reads PRETTY_NAME from /etc/os-release', () => {
        expect(parseOsRelease('NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\nID=ubuntu\n')).toBe('Ubuntu 24.04.1 LTS');
        expect(parseOsRelease('NAME=Alpine\n')).toBeNull();
    });

    it('computes memory and swap from /proc/meminfo', () => {
        const meminfo = [
            'MemTotal:       16000000 kB',
            'MemFree:         1000000 kB',
            'MemAvailable:    4000000 kB',
            'SwapTotal:       2000000 kB',
            'SwapFree:        1500000 kB',
        ].join('\n');
        expect(parseMeminfo(meminfo)).toEqual({
            totalBytes: 16000000 * 1024,
            usedBytes: 12000000 * 1024,
            usagePercent: 75,
            swap: { totalBytes: 2000000 * 1024, usedBytes: 500000 * 1024, usagePercent: 25 },
        });
    });

    it('reports no swap when none is configured', () => {
        const meminfo = 'MemTotal: 1000 kB\nMemAvailable: 500 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n';
        expect(parseMeminfo(meminfo)?.swap).toBeNull();
    });

    it('returns null for meminfo without MemAvailable', () => {
        expect(parseMeminfo('MemTotal: 1000 kB\nMemFree: 500 kB\n')).toBeNull();
    });

    it('keeps real filesystems from /proc/mounts, once per device', () => {
        const mounts = [
            'sysfs /sys sysfs rw,nosuid 0 0',
            'proc /proc proc rw 0 0',
            'tmpfs /run tmpfs rw 0 0',
            '/dev/nvme0n1p2 / ext4 rw,relatime 0 0',
            '/dev/nvme0n1p1 /boot/efi vfat rw 0 0',
            '/dev/loop3 /snap/core/123 squashfs ro 0 0',
            '/dev/nvme0n1p2 /var/lib/docker ext4 rw 0 0',
            'nas:/export /mnt/nas nfs4 rw 0 0',
            '//server/share /mnt/my\\040share cifs rw 0 0',
        ].join('\n');
        expect(parseMounts(mounts)).toEqual(['/', '/boot/efi', '/mnt/nas', '/mnt/my share']);
    });

    it('sums /proc/net/dev counters, skipping loopback', () => {
        const dev = [
            'Inter-|   Receive                                                |  Transmit',
            ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
            '    lo:  500000    1000    0    0    0     0          0         0   500000    1000    0    0    0     0       0          0',
            '  eth0: 1000000    2000    0    0    0     0          0         0   300000    1500    0    0    0     0       0          0',
            ' wlan0:   20000     100    0    0    0     0          0         0     4000      50    0    0    0     0       0          0',
        ].join('\n');
        expect(parseNetDev(dev)).toEqual({
            receivedBytes: 1020000,
            sentBytes: 304000,
            interfaces: [
                { name: 'eth0', receivedBytes: 1000000, sentBytes: 300000 },
                { name: 'wlan0', receivedBytes: 20000, sentBytes: 4000 },
            ],
        });
    });

    it('parses /proc/<pid>/stat, including names with spaces and parentheses', () => {
        const stat = '1234 (Web Content (x)) S 1 1234 1234 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 30 0 5000 900000000 2048 18446744073709551615';
        expect(parseProcStat(stat, 100, 4096)).toEqual({
            pid: 1234,
            name: 'Web Content (x)',
            cpuMs: 3000, // (250 + 50) ticks at 100 Hz
            memoryBytes: 2048 * 4096,
        });
        expect(parseProcStat('garbage', 100, 4096)).toBeNull();
    });
});

describe('linux sockets', () => {
    it('decodes /proc/net hex addresses', () => {
        expect(decodeHexAddress('0100007F')).toBe('127.0.0.1');
        expect(decodeHexAddress('0101A8C0')).toBe('192.168.1.1');
        expect(decodeHexAddress('00000000000000000000000001000000')).toBe('::1');
        expect(decodeHexAddress('00000000000000000000000000000000')).toBe('::');
        expect(decodeHexAddress('0000000000000000FFFF00000100007F')).toBe('127.0.0.1');
        expect(decodeHexAddress('B80D0120000000000000000001000000')).toBe('2001:db8::1');
    });

    it('parses /proc/net/tcp', () => {
        const text = [
            '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
            '   0: 0100007F:0CEA 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41231 1 0000000000000000 100 0 0 10 0',
            '   1: 0F02000A:D2F4 2275C1A2:01BB 01 00000000:00000000 02:000A7F2F 00000000  1000        0 55120 2 0000000000000000 20 4 30 10 -1',
        ].join('\n');
        expect(parseProcNet(text)).toEqual([
            { localAddress: '127.0.0.1', localPort: 3306, remoteAddress: '0.0.0.0', remotePort: 0, state: '0A', inode: '41231' },
            { localAddress: '10.0.2.15', localPort: 54004, remoteAddress: '162.193.117.34', remotePort: 443, state: '01', inode: '55120' },
        ]);
    });
});

describe('connections', () => {
    it('classifies addresses', () => {
        expect(classify('127.0.0.1')).toBe('loopback');
        expect(classify('::1')).toBe('loopback');
        expect(classify('192.168.1.20')).toBe('lan');
        expect(classify('172.20.0.5')).toBe('lan');
        expect(classify('100.101.102.103')).toBe('lan'); // Tailscale
        expect(classify('fe80::1')).toBe('lan');
        expect(classify('fd12:3456::1')).toBe('lan');
        expect(classify('::ffff:10.0.0.1')).toBe('lan');
        expect(classify('172.32.0.1')).toBe('internet');
        expect(classify('1.1.1.1')).toBe('internet');
        expect(classify('2606:4700::6810:84e5')).toBe('internet');
    });

    it('splits listening sockets from connections', () => {
        const res = buildConnections({
            tcp: [
                { localAddress: '0.0.0.0', localPort: 30120, remoteAddress: '0.0.0.0', remotePort: 0, state: 'listen', pid: 10, processName: 'FXServer' },
                { localAddress: '127.0.0.1', localPort: 3306, remoteAddress: '0.0.0.0', remotePort: 0, state: 'listen', pid: 11, processName: 'mysqld' },
                { localAddress: '192.168.1.5', localPort: 50000, remoteAddress: '127.0.0.1', remotePort: 3306, state: 'established', pid: 10, processName: 'FXServer' },
            ],
            udp: [{ address: '::', port: 30120, pid: 10, processName: 'FXServer' }],
        });
        expect(res.connections).toEqual([
            expect.objectContaining({ remoteAddress: '127.0.0.1', scope: 'loopback', remoteHost: null, state: 'established' }),
        ]);
        expect(res.listening.map((l) => [l.protocol, l.port, l.exposed])).toEqual([
            ['tcp', 3306, false],
            ['tcp', 30120, true],
            ['udp', 30120, true],
        ]);
    });

    it('maps Windows Get-NetTCPConnection output', () => {
        const res = parseSockets({
            tcp: [
                { LocalAddress: '0.0.0.0', LocalPort: 135, State: 'Listen', Pid: 1692, Name: 'svchost' },
                { LocalAddress: '10.0.0.2', LocalPort: 50123, RemoteAddress: '1.1.1.1', RemotePort: 443, State: 'TimeWait', Pid: 0, Name: 'Idle' },
                { LocalAddress: '10.0.0.2', LocalPort: 50124, RemoteAddress: '1.1.1.1', RemotePort: 443, State: 'DeleteTCB', Pid: 9, Name: 'x' },
            ],
            udp: null,
        });
        expect(res.tcp).toEqual([
            { localAddress: '0.0.0.0', localPort: 135, remoteAddress: '', remotePort: 0, state: 'listen', pid: 1692, processName: 'svchost' },
            { localAddress: '10.0.0.2', localPort: 50123, remoteAddress: '1.1.1.1', remotePort: 443, state: 'time_wait', pid: null, processName: null },
        ]);
        expect(res.udp).toEqual([]);
    });
});

describe('pairing', () => {
    const iface = (address: string, internal = false) => ({ address, internal, family: 'IPv4' as const, netmask: '', mac: '', cidr: null });

    it('picks reachable addresses, LAN first', () => {
        const interfaces = {
            lo: [iface('127.0.0.1', true)],
            tailscale0: [iface('100.88.1.2')],
            eth0: [iface('192.168.1.40')],
            weird: [iface('169.254.3.3')],
        };
        expect(agentUrls('0.0.0.0', 47821, interfaces)).toEqual(['http://192.168.1.40:47821', 'http://100.88.1.2:47821']);
        expect(agentUrls('127.0.0.1', 47821, interfaces)).toEqual(['http://127.0.0.1:47821']);
        expect(agentUrls('192.168.1.40', 9000, interfaces)).toEqual(['http://192.168.1.40:9000']);
        expect(localOnly(['http://127.0.0.1:47821'])).toBe(true);
        expect(localOnly(['http://192.168.1.40:47821'])).toBe(false);
    });

    it('builds a link with every address', () => {
        const link = pairingLink(['http://192.168.1.40:47821', 'http://100.88.1.2:47821'], 'ABCD2345', 'my-pc');
        const url = new URL(link);
        expect(url.protocol).toBe('hostlens:');
        expect(url.searchParams.getAll('url')).toEqual(['http://192.168.1.40:47821', 'http://100.88.1.2:47821']);
        expect(url.searchParams.get('code')).toBe('ABCD2345');
        expect(url.searchParams.get('name')).toBe('my-pc');
    });

    it('expires codes', () => {
        const codes = new PairingCodes();
        const { code } = codes.create(0);
        expect(codes.consume(code, 10 * 60_000 + 1)).toBe('invalid');
    });
});

describe('windows parsers', () => {
    it('reads byte counters from netstat -e in any language', () => {
        const english = 'Interface Statistics\r\n\r\n                           Received            Sent\r\n\r\nBytes                    1328527592      2269982372\r\nUnicast packets            30981047       281250881\r\n';
        const dutch = 'Interfacestatistieken\r\n\r\n                           Ontvangen      Verzonden\r\n\r\nBytes                         1000             2000\r\nUnicastpakketten                10               20\r\n';
        expect(parseNetstat(english)).toEqual({ receivedBytes: 1328527592, sentBytes: 2269982372, interfaces: [] });
        expect(parseNetstat(dutch)).toEqual({ receivedBytes: 1000, sentBytes: 2000, interfaces: [] });
        expect(parseNetstat('')).toBeNull();
    });
});
