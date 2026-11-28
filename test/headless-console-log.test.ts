import { SESSION_MARKER } from '../src/session-marker.js';
import { test, expect } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, existsSync, readFileSync, rmSync, openSync, ftruncateSync, closeSync, statSync, readSync, appendFileSync, renameSync, writeFileSync, mkdirSync, rmdirSync, copyFileSync, truncateSync } from 'node:fs';
import { HEADLESS_LOG_MAX_BYTES } from '../src/headless.js';
import { type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectWhenAccepting } from './ipc-connect.js';
import { currentSession, parseErrorLog, rolledOverLive, type FrameScope } from '../src/bug-report.js';

const scope: FrameScope = { hostRoot: '/host', tracked: null, packageRoots: new Map(), realpath: (file) => file };

/** A sparse headless.log of `bytes` (its size, not its bytes), as earlier runs
 *  would leave; `tail` is text at its end, an earlier run's last lines. */
function sparseLog(dir: string, bytes: number, tail = ''): void {
  const fd = openSync(join(dir, 'headless.log'), 'w');
  ftruncateSync(fd, bytes - Buffer.byteLength(tail));
  closeSync(fd);
  if (tail) appendFileSync(join(dir, 'headless.log'), tail);
}

/** The last `bytes` of a file as text: a 64 MiB sparse log is mostly NUL, and only its end holds lines. */
function tailText(path: string, bytes: number): string {
  const size = statSync(path).size;
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(Math.min(bytes, size));
    readSync(fd, buf, 0, buf.length, Math.max(0, size - buf.length));
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** The burst numbers a text holds, scanned once. */
const burstNumbers = (text: string) => new Set([...text.matchAll(/\[probe\] burst (\d+) /g)].map((m) => Number(m[1])));

/** The pulse numbers a text holds. */
const pulseNumbers = (text: string) => [...text.matchAll(/\[probe\] pulse (\d+) /g)].map((m) => Number(m[1]));

/** Wait until the PULSE child has said `n` lines (about a KB each), under 10 s. */
async function pulsesPast(dir: string, n: number): Promise<number> {
  const deadline = performance.now() + 10_000;
  for (;;) {
    const said = existsSync(join(dir, 'pulses.txt')) ? Number(readFileSync(join(dir, 'pulses.txt'), 'utf8')) : 0;
    if (said >= n) return said;
    if (performance.now() >= deadline) throw new Error(`only ${said} pulses after 10 s`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const shutdown = (socket: Socket) => { socket.write('{"type":"shutdown"}\n'); };

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
    const read = (name: string) => (existsSync(join(dir, name)) ? tailText(join(dir, name), 2 * 1024 * 1024) : undefined);
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
    // Near the cap, then a burst of about 450 KB that crosses it close to its
    // end (so most of it is queued on the stream the rollover retires), then
    // the exit main().catch makes: endHeadlessLog, process.exit (R2-1, R2-4).
    sparseLog(dir, HEADLESS_LOG_MAX_BYTES - 400_000);
    const BURST = 4500;
    const { code, log, rolled } = await runChild(dir, { BURST: String(BURST) }, () => {});
    expect(code).toBe(1);
    expect(rolled).toBeDefined();
    // The new file opens with its marker and the notice, before the line that crossed.
    expect(log.split('\n').slice(0, 4).some((line) => /^--- session .* ---$/.test(line))).toBe(true);
    expect(rolledOverLive(currentSession(log))).toBe(true);
    const inRolled = burstNumbers(rolled!);
    const inLog = burstNumbers(log);
    const all = new Set(Array.from({ length: BURST }, (_, i) => i + 1));
    const lost = [...all].filter((n) => !inRolled.has(n) && !inLog.has(n));
    const twice = [...inRolled].filter((n) => inLog.has(n));
    expect({ lost: lost.length, twice: twice.length }).toEqual({ lost: 0, twice: 0 });
    expect(inRolled.size).toBeGreaterThan(BURST / 2);
    expect(inLog.size).toBeGreaterThan(0);
    // headless.log.1 holds the run's boot and early lines; /bug reads it back to its marker (R2-3).
    const both = `${currentSession(rolled!)}\n${currentSession(log)}`;
    expect(both).toContain('Failed to connect MCPL server "zz-boot"');
    expect(parseErrorLog(both, scope).tags.get('mcpl')).toBe(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 20000);

test("a start whose own first lines cross the cap puts this run's marker in headless.log.1 with the rest, not the previous run's", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'headless-console-')));
  try {
    // 100 bytes under the cap, with an earlier run's tagged lines at the end:
    // this start's marker and boot lines cross it before any await. The
    // stream must have its fd before the rename (R3-1), or the previous run's
    // lines are what /bug counts as this run's.
    const EARLIER = '--- session 2026-10-11T22:00:00.000Z ---';
    sparseLog(dir, HEADLESS_LOG_MAX_BYTES - 100, `\n${EARLIER}\n[gate] earlier run\n[inference-failed] earlier run\n`);
    const since = Date.now();
    const { code, log, rolled } = await runChild(dir, {}, async (socket) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      socket.write('{"type":"shutdown"}\n');
    });
    expect(code).toBe(0);
    // This run's marker went to the file that was moved aside (its first lines
    // crossed the cap right after it), so that file's last session is this
    // run's, and empty: the earlier run's lines are behind a marker /bug
    // won't read past. Before, the stream still opening at the rename
    // opened the new file, and the moved-aside file ended with the earlier
    // run's lines under no marker of ours.
    const rolledSession = currentSession(rolled!);
    // This run's marker: the format, not today's date (R4-1), not the earlier
    // run's, and stamped no earlier than this test started.
    const last = rolled!.trimEnd().split('\n').at(-1)!;
    expect(last).toMatch(SESSION_MARKER);
    expect(last).not.toBe(EARLIER);
    expect(Date.parse(last.slice('--- session '.length, -' ---'.length))).toBeGreaterThanOrEqual(since - 1000);
    expect(rolledSession.trim()).toBe('');
    expect(rolled!).toContain('[gate] earlier run');
    // The new file opens with one marker and the notice; the start, boot and live lines follow.
    const session = currentSession(log);
    expect(rolledOverLive(session)).toBe(true);
    expect(log.match(/^--- session .* ---$/gm)).toHaveLength(1);
    expect(session).toContain('headless start pid=');
    expect(session).toContain('Failed to connect MCPL server "zz-boot"');
    expect(session).toContain('[probe] zz-console-error line 1');
    // /bug's read of both counts this run alone: no gate, no inference-failed.
    const parsed = parseErrorLog(`${rolledSession}\n${session}`, scope);
    expect(parsed.tags.get('mcpl')).toBe(2);
    expect(parsed.tags.get('gate')).toBeUndefined();
    expect(parsed.tags.get('inference-failed')).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);

test('a headless.log moved aside by something other than the host is left where it went, and the path is opened anew within a MiB — no rollover (R4-4)', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'headless-console-')));
  try {
    const { code, log, rolled } = await runChild(dir, { PULSE: '100' }, async (socket) => {
      // An external rotator's move: mv headless.log headless.log.1 && touch headless.log.
      const moved = await pulsesPast(dir, 100);
      renameSync(join(dir, 'headless.log'), join(dir, 'headless.log.1'));
      writeFileSync(join(dir, 'headless.log'), '');
      // Within a MiB of lines (about 1,050 of these) the host notices and opens the path.
      await pulsesPast(dir, moved + 1500);
      shutdown(socket);
    });
    expect(code).toBe(0);
    // The rotator's file holds this run's boot and the lines up to the switch: the host didn't rename it back or over.
    expect(rolled).toBeDefined();
    expect(rolled!).toContain('headless start pid=');
    expect(pulseNumbers(rolled!).length).toBeGreaterThan(100);
    // The new file: one marker, the notice that the path was gone — not a rollover's — and the lines from the switch on, none lost or doubled.
    expect(log.match(/^--- session .* ---$/gm)).toHaveLength(1);
    expect(log).toContain('headless.log was gone (deleted, or moved by something other than the host) and was opened anew');
    expect(log).not.toMatch(/rolled over at \d+ bytes/);
    const inRolled = pulseNumbers(rolled!), inLog = pulseNumbers(log);
    expect(inLog[0]).toBe(inRolled.at(-1)! + 1);
    expect(inLog[0]).toBeLessThanOrEqual(pulseNumbers(rolled!).length + 1200);
    expect(rolledOverLive(currentSession(log))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 20000);

test("at the cap, the host moves aside only the file it is writing: a rotator's headless.log put there meanwhile isn't renamed over the rotated one (R4-4)", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'headless-console-')));
  try {
    sparseLog(dir, HEADLESS_LOG_MAX_BYTES - 400_000);
    const BURST = 4500;
    const { code, log, rolled } = await runChild(dir, { BURST: String(BURST) }, () => {
      // Before the burst crosses the cap, a rotator moves the log and leaves an empty one.
      renameSync(join(dir, 'headless.log'), join(dir, 'headless.log.1'));
      writeFileSync(join(dir, 'headless.log'), '');
    });
    expect(code).toBe(1);
    // Before: at the cap the host renamed the rotator's empty headless.log over
    // headless.log.1, and the 64 MiB it had been writing was gone.
    expect(statSync(join(dir, 'headless.log.1')).size).toBeGreaterThan(HEADLESS_LOG_MAX_BYTES - 400_000);
    expect(log).toContain('headless.log was gone (deleted, or moved by something other than the host) and was opened anew');
    expect(log).not.toMatch(/rolled over at \d+ bytes/);
    const inRolled = burstNumbers(rolled!), inLog = burstNumbers(log);
    const all = new Set(Array.from({ length: BURST }, (_, i) => i + 1));
    const lost = [...all].filter((n) => !inRolled.has(n) && !inLog.has(n));
    const twice = [...inRolled].filter((n) => inLog.has(n));
    expect({ lost: lost.length, twice: twice.length }).toEqual({ lost: 0, twice: 0 });
    expect(inLog.size).toBeGreaterThan(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 20000);

test("a headless.log truncated under the host (copytruncate) is counted from its real size within a MiB: no rollover until the file itself reaches the cap, so a rotator's copy at headless.log.1 is kept (R5-1)", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'headless-console-')));
  try {
    // 2 MB short of the cap. Before: the host's count ran on from here and
    // renamed its small file over the rotator's copy once 2 MB were written.
    sparseLog(dir, HEADLESS_LOG_MAX_BYTES - 2_000_000);
    const { code, log, rolled } = await runChild(dir, { PULSE: '100' }, async (socket) => {
      await pulsesPast(dir, 100);
      copyFileSync(join(dir, 'headless.log'), join(dir, 'headless.log.1'));
      truncateSync(join(dir, 'headless.log'), 0);
      // Well past the old count's cap, and past at least two MiB checks.
      await pulsesPast(dir, 100 + 4500);
      shutdown(socket);
    });
    expect(code).toBe(0);
    // The rotator's copy is untouched, and the host's file is the small one.
    expect(statSync(join(dir, 'headless.log.1')).size).toBeGreaterThan(HEADLESS_LOG_MAX_BYTES - 2_000_000);
    expect(rolled).toContain('headless start pid=');
    expect(statSync(join(dir, 'headless.log')).size).toBeLessThan(10 * 1024 * 1024);
    expect(log).not.toMatch(/rolled over at \d+ bytes/);
    expect(log).not.toContain('was gone');
    expect(pulseNumbers(log).at(-1)).toBeGreaterThanOrEqual(4600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 25000);

test('a reopen that fails is tried again a MiB on, apart from any rollover, and the file is back within about a MiB of the fix (R4-3)', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'headless-console-')));
  try {
    let fixedAt = 0;
    const { code, log } = await runChild(dir, { PULSE: '100' }, async (socket) => {
      // The log deleted and a directory put at its path: the host's open fails (EISDIR) until the directory goes.
      const deleted = await pulsesPast(dir, 100);
      rmSync(join(dir, 'headless.log'));
      mkdirSync(join(dir, 'headless.log'));
      // Past the first retry (a MiB after the delete was noticed), then the fix.
      await pulsesPast(dir, deleted + 2400);
      rmdirSync(join(dir, 'headless.log'));
      fixedAt = Number(readFileSync(join(dir, 'pulses.txt'), 'utf8'));
      await pulsesPast(dir, fixedAt + 1500);
      shutdown(socket);
    });
    expect(code).toBe(0);
    expect(existsSync(join(dir, 'headless.log.1'))).toBe(false);
    expect(log.match(/^--- session .* ---$/gm)).toHaveLength(1);
    expect(log).toContain('headless.log was gone (deleted, or moved by something other than the host) and was opened anew');
    const inLog = pulseNumbers(log);
    // Opened within about a MiB of lines after the directory went: not at the next cap crossing.
    expect(inLog[0]).toBeGreaterThan(fixedAt - 1200);
    expect(inLog[0]).toBeLessThanOrEqual(fixedAt + 1200);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 25000);

test('after an unopenable file comes back, the count starts at its size: a file near the cap rolls over at the cap, not a cap later (R5-3)', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'headless-console-')));
  try {
    // A near-cap file the host can't open at start (a directory stands at its
    // path, the file waits beside it), then can.
    sparseLog(dir, HEADLESS_LOG_MAX_BYTES - 1_500_000);
    renameSync(join(dir, 'headless.log'), join(dir, 'headless.log.aside'));
    mkdirSync(join(dir, 'headless.log'));
    const { code, log, rolled } = await runChild(dir, { PULSE: '100' }, async (socket) => {
      await pulsesPast(dir, 100);
      rmdirSync(join(dir, 'headless.log'));
      renameSync(join(dir, 'headless.log.aside'), join(dir, 'headless.log'));
      // Opened within a MiB; then 1.5 MB more crosses the cap by the file's size.
      await pulsesPast(dir, 100 + 1200 + 2500);
      shutdown(socket);
    });
    expect(code).toBe(0);
    // Rolled over once the file reached 64 MiB: the retired file is the big one.
    expect(rolled).toBeDefined();
    expect(statSync(join(dir, 'headless.log.1')).size).toBeGreaterThan(HEADLESS_LOG_MAX_BYTES - 1_500_000);
    expect(rolled!).toMatch(/headless\.log is open from here; the \d+ bytes of lines before this went to stderr/);
    expect(log).toMatch(/rolled over at \d+ bytes/);
    expect(statSync(join(dir, 'headless.log')).size).toBeLessThan(5 * 1024 * 1024);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);

test("a start whose headless.log can't be opened runs with its lines on stderr, says so there once, and opens the file within a MiB once it can (R4-2)", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'headless-console-')));
  try {
    mkdirSync(join(dir, 'headless.log'));
    let fixedAt = 0;
    const { code, stderr, log } = await runChild(dir, { PULSE: '100' }, async (socket) => {
      // Up, ready and saying lines with no log file at all (before: the start threw).
      const said = await pulsesPast(dir, 100);
      rmdirSync(join(dir, 'headless.log'));
      fixedAt = said;
      await pulsesPast(dir, said + 1500);
      shutdown(socket);
    });
    expect(code).toBe(0);
    expect(stderr.match(/\[host\] headless\.log couldn't be opened \(/g)).toHaveLength(1);
    // Each console line once on stderr while the file is unopenable, not twice (R5-2).
    expect(stderr.split('[probe] pulse 1 ').length - 1).toBe(1);
    expect(stderr.split('[probe] pulse 50 ').length - 1).toBe(1);
    // The notice counts what went to stderr (R5-3).
    const opened = log.match(/headless\.log is open from here; the (\d+) bytes of lines before this went to stderr/);
    expect(opened).not.toBeNull();
    expect(Number(opened![1])).toBeGreaterThan(100 * 1000);
    expect(log.match(/^--- session .* ---$/gm)).toHaveLength(1);
    const inLog = pulseNumbers(log);
    expect(inLog[0]).toBeGreaterThan(fixedAt - 1200);
    expect(inLog[0]).toBeLessThanOrEqual(fixedAt + 1200);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 25000);
