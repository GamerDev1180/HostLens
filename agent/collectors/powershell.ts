import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// Some Windows metrics (64-bit adapter counters, page file, per-process CPU)
// are only reachable through PowerShell/CIM. Starting powershell.exe costs
// ~1 s, so we keep one session open and feed it commands over stdin; a warm
// query then takes 15–60 ms. Commands run one at a time.

const COMMAND_TIMEOUT_MS = 5000;

interface Job {
    command: string;
    resolve: (output: string) => void;
    reject: (error: Error) => void;
}

let child: ChildProcessWithoutNullStreams | null = null;
let buffer = '';
let current: (Job & { marker: string; timer: NodeJS.Timeout }) | null = null;
const queue: Job[] = [];

function start(): ChildProcessWithoutNullStreams {
    const ps = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'], {
        windowsHide: true,
    });
    ps.stdout.setEncoding('utf8');
    ps.stdout.on('data', (chunk: string) => {
        if (child !== ps) return;
        buffer += chunk;
        if (!current) return;
        const end = buffer.indexOf(current.marker);
        if (end === -1) return;
        const output = buffer.slice(0, end);
        buffer = '';
        finish((job) => job.resolve(output));
    });
    // Errors are swallowed per command (see `run`); anything left here is noise.
    ps.stderr.resume();
    // Ignore events from a session we've already replaced.
    ps.on('error', (err) => child === ps && stop(err));
    ps.on('exit', () => child === ps && stop(new Error('PowerShell exited')));
    ps.stdin.write(
        "$ErrorActionPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [Text.Encoding]::UTF8\n",
    );
    return ps;
}

function stop(error: Error) {
    child?.kill();
    child = null;
    buffer = '';
    finish((job) => job.reject(error));
}

function finish(settle: (job: Job) => void) {
    const job = current;
    current = null;
    if (job) {
        clearTimeout(job.timer);
        settle(job);
    }
    next();
}

function next() {
    if (current) return;
    const job = queue.shift();
    if (!job) return;
    try {
        child ??= start();
    } catch (err) {
        job.reject(err as Error);
        next();
        return;
    }
    const marker = `<<HL-${randomUUID()}>>`;
    const timer = setTimeout(() => stop(new Error('PowerShell command timed out')), COMMAND_TIMEOUT_MS);
    current = { ...job, marker, timer };
    // The marker is echoed after the command, so it also arrives when the command fails.
    child.stdin.write(`try { ${job.command} } catch {}; '${marker}'\n`);
}

/** Runs a command and returns its stdout. */
export function run(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
        queue.push({ command, resolve, reject });
        next();
    });
}

/** Runs a command that outputs `ConvertTo-Json` and parses it; `null` on empty output or failure. */
export async function runJson<T>(command: string): Promise<T | null> {
    try {
        const output = (await run(command)).trim();
        return output ? (JSON.parse(output) as T) : null;
    } catch {
        return null;
    }
}

/** Ends the session (used by tests so the process can exit). */
export function shutdown() {
    queue.splice(0).forEach((job) => job.reject(new Error('PowerShell session closed')));
    stop(new Error('PowerShell session closed'));
}
