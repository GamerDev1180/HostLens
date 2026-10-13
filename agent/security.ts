import { createHash, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { DeviceStore } from './devices.ts';
import type { ErrorResponse } from './types.ts';

// Browsers attach an Origin header to cross-origin requests; native clients
// (the desktop app's Rust side, curl) don't. Reject any browser origin that
// hasn't been explicitly allowed, so a web page can't probe the local agent.
export function originGuard(allowedOrigins: string[]): MiddlewareHandler {
    return async (c, next) => {
        const origin = c.req.header('origin');
        if (origin !== undefined && !allowedOrigins.includes(origin)) {
            return c.json<ErrorResponse>({ error: 'origin not allowed' }, 403);
        }
        await next();
    };
}

/** Who made the request: the master token, or a paired device. */
export type Caller = { kind: 'master' } | { kind: 'device'; id: string };

export type AuthEnv = { Variables: { caller: Caller } };

const digest = (value: string) => createHash('sha256').update(value).digest();

/**
 * Requires `Authorization: Bearer <token>` with the master token or a paired
 * device's token, and records the caller. Paths in `publicPaths` skip the check.
 */
export function requireToken(masterToken: string, devices: DeviceStore, publicPaths: string[] = []): MiddlewareHandler<AuthEnv> {
    const expected = digest(masterToken);
    return async (c, next) => {
        if (publicPaths.includes(c.req.path)) return next();
        const token = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization') ?? '')?.[1]?.trim();
        // Compare fixed-length digests so the check doesn't leak the master token through timing.
        if (token && timingSafeEqual(digest(token), expected)) {
            c.set('caller', { kind: 'master' });
            return next();
        }
        const device = token ? devices.verify(token) : null;
        if (device) {
            c.set('caller', { kind: 'device', id: device.id });
            return next();
        }
        c.header('WWW-Authenticate', 'Bearer');
        return c.json<ErrorResponse>({ error: 'unauthorized' }, 401);
    };
}
