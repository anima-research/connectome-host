import { test, expect } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, existsSync, readFileSync, rmSync, openSync, ftruncateSync, closeSync, statSync } from 'node:fs';
import { HEADLESS_LOG_MAX_BYTES } from '../src/headless.js';
import { type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectWhenAccepting } from './ipc-connect.js';
import { currentSession, parseErrorLog, type FrameScope } from '../src/bug-report.js';

const scope: FrameScope = { hostRoot: '/host', tracked: null, packageRoots: new Map(), realpath: (file) => file };

test('a headless host writes its console.error and console.warn lines to headless.log, from boot, where /bug counts them, and still prints them for its supervisor', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'headless-console-')));
  // A headless.log at the cap from earlier runs (sparse: its size, not its
  // bytes) is moved aside at this start (R1-2).
  const fd = openSync(join(dir, 'headless.log'), 'w');
  ftruncateSync(fd, HEADLESS_LOG_MAX_BYTES);
  closeSync(fd);
  const child = spawn(process.execPath, [join(import.meta.dir, 'mock-headless-console-child.ts')], {
    cwd: dir, env: { ...process.env, DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'],
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
    await new Promise((resolve) => setTimeout(resolve, 300));
    socket.write('{"type":"shutdown"}\n');
    timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    const result = await closed;
    clearTimeout(timer);
    expect(result.code).toBe(0);
    expect(statSync(join(dir, 'headless.log.1')).size).toBe(HEADLESS_LOG_MAX_BYTES);
    const log = readFileSync(join(dir, 'headless.log'), 'utf8');
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
    const parsed = parseErrorLog(session, scope);
    expect(parsed.tags.get('mcpl')).toBe(2);
    // The supervisor (journald, or a fleet parent's startup.log) still gets each once.
    expect(stderr).toContain('[probe] zz-console-error line 1');
    expect(stderr).toContain('[probe] zz-console-warn line');
    expect(stderr.split('Failed to connect MCPL server "zz-boot"').length - 1).toBe(1);
    expect(stderr.split('[probe] zz-console-warn line').length - 1).toBe(1);
  } finally {
    clearTimeout(timer);
    socket?.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);
