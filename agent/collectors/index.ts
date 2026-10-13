import os from 'node:os';
import type { PlatformCollector } from './common.ts';
import { diskAt, nodeMemory } from './common.ts';
import { linux } from './linux.ts';
import { windows } from './windows.ts';

// Best-effort fallback for platforms without a dedicated module (e.g. macOS):
// only what Node can report portably.
const generic: PlatformCollector = {
    osName: async () => os.version(),
    memory: async () => nodeMemory(),
    disks: async () => {
        const root = await diskAt('/', '/');
        return root ? [root] : [];
    },
    network: async () => null,
    processes: async () => null,
    sockets: async () => null,
};

export const platform: PlatformCollector =
    process.platform === 'win32' ? windows : process.platform === 'linux' ? linux : generic;

export { sampleCpu } from './cpu.ts';
export { sampleProcesses } from './processes.ts';
export { buildConnections } from './connections.ts';
export { sampleGpus } from './gpu.ts';
