import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DeviceInfo } from './types.ts';

// Pairing: an authenticated client asks for a short-lived, single-use code
// (shown as a QR code); a new device trades that code for its own token.
// Only a hash of each device token is stored, so the file can't be used to
// impersonate a device, and one device can be revoked without the others.

interface StoredDevice {
    id: string;
    name: string;
    /** sha256 of the device token, hex. */
    tokenHash: string;
    createdAt: string;
    lastSeenAt: string | null;
}

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export class DeviceStore {
    private devices: StoredDevice[];
    private byHash = new Map<string, StoredDevice>();
    private saveTimer: NodeJS.Timeout | null = null;
    private readonly file: string | null;

    /** `file` null keeps devices in memory only (tests). */
    constructor(file: string | null) {
        this.file = file;
        this.devices = file ? DeviceStore.read(file) : [];
        for (const d of this.devices) this.byHash.set(d.tokenHash, d);
    }

    private static read(file: string): StoredDevice[] {
        try {
            const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
            return Array.isArray(parsed) ? (parsed as StoredDevice[]) : [];
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
            throw new Error(`Can't read ${file}: ${(e as Error).message}`);
        }
    }

    private save() {
        if (!this.file) return;
        mkdirSync(dirname(this.file), { recursive: true });
        // Write then rename, so a crash can't leave a half-written file.
        const tmp = `${this.file}.tmp`;
        writeFileSync(tmp, `${JSON.stringify(this.devices, null, 2)}\n`, { mode: 0o600 });
        renameSync(tmp, this.file);
    }

    /** Batches lastSeenAt updates instead of writing on every request. */
    private saveSoon() {
        this.saveTimer ??= setTimeout(() => {
            this.saveTimer = null;
            this.save();
        }, 30_000);
        this.saveTimer.unref();
    }

    get count() {
        return this.devices.length;
    }

    list(currentId?: string): DeviceInfo[] {
        return this.devices.map(({ tokenHash: _hash, ...d }) => ({ ...d, current: d.id === currentId }));
    }

    /** The device a token belongs to, or null. Device tokens are 256-bit random, so a map lookup is safe. */
    verify(token: string): StoredDevice | null {
        const device = this.byHash.get(hash(token)) ?? null;
        if (device) {
            device.lastSeenAt = new Date().toISOString();
            this.saveSoon();
        }
        return device;
    }

    add(name: string): { device: StoredDevice; token: string } {
        const token = randomBytes(32).toString('base64url');
        const device: StoredDevice = {
            id: randomUUID(),
            name: name.trim().slice(0, 80) || 'Unnamed device',
            tokenHash: hash(token),
            createdAt: new Date().toISOString(),
            lastSeenAt: null,
        };
        this.devices.push(device);
        this.byHash.set(device.tokenHash, device);
        this.save();
        return { device, token };
    }

    revoke(id: string): boolean {
        const device = this.devices.find((d) => d.id === id);
        if (!device) return false;
        this.devices = this.devices.filter((d) => d !== device);
        this.byHash.delete(device.tokenHash);
        this.save();
        return true;
    }
}

// Unambiguous characters only (no 0/O, 1/I/L), so a code can be typed from a screen.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
export const PAIRING_CODE_TTL_MS = 10 * 60_000;
/** Failed attempts allowed per window before pairing is locked, against guessing. */
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 5 * 60_000;

/** "ABCD-EFGH" or "abcdefgh" → "ABCDEFGH". */
export const normalizeCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');

export class PairingCodes {
    private codes = new Map<string, number>(); // code → expiry (ms)
    private failures: number[] = [];

    create(now = Date.now()): { code: string; expiresAt: number } {
        this.prune(now);
        let code = '';
        for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)];
        const expiresAt = now + PAIRING_CODE_TTL_MS;
        this.codes.set(code, expiresAt);
        return { code, expiresAt };
    }

    /**
     * Uses up a code. Returns "ok", "invalid" (unknown, used or expired), or
     * "locked" when too many wrong codes were tried recently.
     */
    consume(input: string, now = Date.now()): 'ok' | 'invalid' | 'locked' {
        this.prune(now);
        if (this.failures.length >= MAX_FAILURES) return 'locked';
        const code = normalizeCode(input);
        if (this.codes.has(code)) {
            this.codes.delete(code);
            return 'ok';
        }
        this.failures.push(now);
        return 'invalid';
    }

    private prune(now: number) {
        for (const [code, expiresAt] of this.codes) if (expiresAt <= now) this.codes.delete(code);
        this.failures = this.failures.filter((t) => now - t < FAILURE_WINDOW_MS);
    }
}
