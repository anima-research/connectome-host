import { test, expect } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, existsSync, readFileSync, rmSync, openSync, ftruncateSync, closeSync, statSync } from 'node:fs';
import { HEADLESS_LOG_MAX_BYTES } from '../src/headless.js';
import { type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectWhenAccepting } from './ipc-connect.js';
import { currentSession, parseErrorLog, rolledOverLive, type FrameScope } from '../src/bug-report.js';

const scope: FrameScope = { hostRoot: '/host', tracked: null, packageRoots: new Map(), realpath: (file) => file };

/** A sparse headless.log of `bytes` (its size, not its bytes), as earlier runs would leave. */
function sparseLog(dir: string, bytes: number): void {
  const fd = openSync(join(dir, 'headless.log'), 'w');
  ftruncateSync(fd, bytes);
  closeSync(fd);
}

/** Run the mock child to a ready socket, then let `drive` end it; give back its exit code, stderr and the files. */
async function runChild(dir: string, env: Record<string, string>, drive: (socket: Socket) => Promise<void> | void) {
  const child = spawn(process.execPath, [join(import.meta.dir, 'mock-headless-console-child.ts')], {
    cwd: dir, env: { ...process.env, DATA_DIR: dir, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', stderr = '', socket: Socket | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  child.stdout!.on('data', (chunk) => { output += chunk; });
  child.stderr!.on('data', (chunk) => { output += chunk; stderr += chunk; });
  const closed = new Promise<{ code: number | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ code }));
  });
  try {
    const socketPath = join(dir, 'ipc.sock');
    const deadline = performance.now() + 5000;
    while (!existsSync(socketPath)) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Child failed at startup: ${output}`);
      if (performance.now() >= deadline) throw new Error(`Startup timed out: ${output}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    socket = await connectWhenAccepting(socketPath);
    await new Promise<void>((resolve, reject) => {
      let buffer = '';
      socket!.setEncoding('utf8');
      socket!.on('error', reject);
      socket!.on('data', (chunk: string) => {
        buffer += chunk;
        if (buffer.split('\n').some((line) => line.includes('"phase":"ready"'))) resolve();
      });
      timer = setTimeout(() => reject(new Error('No ready event')), 3000);
    });
    clearTimeout(timer);
    await drive(socket);
    timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    const result = await closed;
    clearTimeout(timer);
    const read = (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : undefined);
    return { code: result.code, stderr, log: read('headless.log') ?? '', rolled: read('headless.log.1') };
  } finally {
    clearTimeout(timer);
    socket?.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  }
}

test('a headless host writes its console.error and console.warn lines to headless.log, from boot, where /bug counts them, and still prints them for its supervisor', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'headless-console-')));
  try {
    // A headless.log at the cap from earlier runs is moved aside at this start (R1-2).
    sparseLog(dir, HEADLESS_LOG_MAX_BYTES);
    const { code, stderr, log } = await runChild(dir, {}, async (socket) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      socket.write('{"type":"shutdown"}\n');
    });
    expect(code).toBe(0);
    expect(statSync(join(dir, 'headless.log.1')).size).toBe(HEADLESS_LOG_MAX_BYTES);
    expect(log.length).toBeLessThan(64 * 1024);
    expect(log).toContain(`headless.log was over ${HEADLESS_LOG_MAX_BYTES} bytes and was moved to headless.log.1\n`);
    expect(log).toContain('[probe] zz-console-error line 1\n');
    expect(log).toContain('[probe] zz-console-warn line\n');
    // Said before runHeadless opened the log (R1-1): written after this run's
    // session marker and the runtime's start line, before what was said once
    // the host was up.
    const session = currentSession(log);
    expect(session).toContain('Failed to connect MCPL server "zz-boot": connection refused\n');
    const boot = session.indexOf('[mcpl] server "zz-boot": tools/list failed: not connected');
    expect(boot).toBeGreaterThan(session.indexOf('headless start pid='));
    expect(boot).toBeLessThan(session.indexOf('[probe] zz-console-error line 1'));
    // What #674 is about: /bug's parse of this run counts the tags, the boot line among them.
    expect(parseErrorLog(session, scope).tags.get('mcpl')).toBe(2);
    // The supervisor (journald, or a fleet parent's startup.log) still gets each once.
    expect(stderr).toContain('[probe] zz-console-error line 1');
    expect(stderr).toContain('[probe] zz-console-warn line');
    expect(stderr.split('Failed to connect MCPL server "zz-boot"').length - 1).toBe(1);
    expect(stderr.split('[probe] zz-console-warn line').length - 1).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);

test('a burst that crosses the cap rolls headless.log over live and an exit right after it loses no line; /bug reads both files', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'headless-console-')));
  try {
    // Near the cap, then a burst of about 400 KB that crosses it, then the
    // exit main().catch makes: endHeadlessLog, process.exit (R2-1, R2-4).
    sparseLog(dir, HEADLESS_LOG_MAX_BYTES - 200_000);
    const BURST = 4000;
    const { code, log, rolled } = await runChild(dir, { BURST: String(BURST) }, () => {});
    expect(code).toBe(1);
    expect(rolled).toBeDefined();
    // The new file opens with its marker and the notice, before the line that crossed.
    expect(log.split('\n').slice(0, 4).some((line) => /^--- session .* ---$/.test(line))).toBe(true);
    expect(rolledOverLive(currentSession(log))).toBe(true);
    const inRolled = (n: number) => rolled!.includes(`[probe] burst ${n} `);
    const inLog = (n: number) => log.includes(`[probe] burst ${n} `);
    let lost = 0, twice = 0, moved = 0;
    for (let n = 1; n <= BURST; n++) {
      if (!inRolled(n) && !inLog(n)) lost++;
      if (inRolled(n) && inLog(n)) twice++;
      if (inRolled(n)) moved++;
    }
    expect({ lost, twice }).toEqual({ lost: 0, twice: 0 });
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThan(BURST);
    // headless.log.1 holds the run's boot and early lines; /bug reads it back to its marker (R2-3).
    const both = `${currentSession(rolled!)}\n${currentSession(log)}`;
    expect(both).toContain('Failed to connect MCPL server "zz-boot"');
    expect(parseErrorLog(both, scope).tags.get('mcpl')).toBe(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 20000);
