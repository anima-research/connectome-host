/**
 * A release on trial keeps the last lines it writes through console and
 * process.stdout/stderr.write, passed on unchanged, and writes them to the
 * install's trial log if it exits before its commit; the commit disarms it,
 * and a start that isn't a trial keeps nothing (src/update/trial-log.ts).
 * The release that falls back reads the log for its fallback alone. Each run
 * that arms is a process of its own, since arming wraps the process's console
 * and writes. /update's lines are in update-host-update.test.ts.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendJournal, installPaths, moveCurrent, readRecord, writeJsonAtomic } from '../src/update/contract.js';
import { TRIAL_LOG_CHARS, TRIAL_LOG_LINES, readTrialLog, type TrialLog } from '../src/update/trial-log.js';

const TRIAL_LOG = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'update', 'trial-log.ts');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An install whose `current` names 0.12.1, with 0.13.0 on trial under mark
 *  m1 when `trial`, as the launcher leaves it before it starts the trial. */
function install(trial = true): string {
  const root = mkdtempSync(join(tmpdir(), 'trial-log-'));
  dirs.push(root);
  for (const version of ['0.12.1', '0.13.0']) mkdirSync(join(root, 'releases', version), { recursive: true });
  moveCurrent(root, '0.12.1');
  if (trial) appendJournal(root, { at: '2026-10-24T01:00:00.000Z', step: 'trial-start', from: '0.12.1', to: '0.13.0', outcome: 'ok', mark: 'm1' });
  return root;
}

/** Run `body` in a process of its own, as release 0.13.0 of `root`, after
 *  arming the trial log. */
function run(root: string, body: string): { status: number | null; stdout: string; stderr: string } {
  const script = join(root, 'run.ts');
  writeFileSync(script, [
    `import { armTrialLog, disarmTrialLog } from ${JSON.stringify(TRIAL_LOG)};`,
    `armTrialLog({ root: ${JSON.stringify(root)}, release: '0.13.0' });`,
    body,
  ].join('\n'));
  const result = spawnSync(process.execPath, [script], { encoding: 'utf-8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const kept = (root: string) => readRecord<TrialLog>(installPaths(root).trialLog, 'trial log');

describe('a release on trial', () => {
  test('that ends before its commit keeps what it wrote, which still reaches its stdout and stderr, readable by this user alone', () => {
    const root = install();
    // A temporary file a crash left, readable by others, doesn't make the log so.
    writeFileSync(`${installPaths(root).trialLog}.tmp`, '', { mode: 0o644 });
    const { status, stdout, stderr } = run(root, [
      "console.log('one', 2);",
      "process.stdout.write('three ');",
      "process.stdout.write(new TextEncoder().encode('four\\nfive'));",
      // A console line after a write that left its line open starts its own.
      "console.error(new Error('six'));",
      "process.stderr.write('err-partial');",
      "throw new Error('Bun reports this itself');",
    ].join('\n'));
    expect(status).toBe(1);
    expect(stdout).toContain('one 2\nthree four\nfive');
    expect(stderr).toContain('err-partial');
    const log = kept(root)!;
    expect(log).toMatchObject({ v: 1, release: '0.13.0', mark: 'm1' });
    expect(log.lines.slice(0, 4)).toEqual(['one 2', 'three four', 'five', 'Error: six']);
    expect(log.lines.at(-1)).toBe('err-partial');
    // An error nothing caught is Bun's to report, past console: the service's log alone has it.
    expect(stderr).toContain('Bun reports this itself');
    expect(log.lines.join('\n')).not.toContain('Bun reports this itself');
    expect(statSync(installPaths(root).trialLog).mode & 0o777).toBe(0o600);
  });

  test("keeps each of console's five methods it wraps, a subarray's own bytes, and passes a write's encoding and callback on", () => {
    const root = install();
    const { status, stdout, stderr } = run(root, [
      "console.info('info');",
      "console.warn('warn');",
      "console.debug('debug');",
      "process.stdout.write(new TextEncoder().encode('[around]').subarray(1, 7));",
      // Bun can call the callback within the write, before it returns.
      'let calledBack = false;',
      "const returned = process.stdout.write('\\nwith a callback\\n', 'utf-8', () => { calledBack = true; });",
      "setTimeout(() => { process.stderr.write(JSON.stringify({ calledBack, returned }) + '\\n'); process.exit(1); }, 10);",
    ].join('\n'));
    expect(status).toBe(1);
    expect(stdout).toContain('around\nwith a callback\n');
    expect(stderr).toContain('{"calledBack":true,"returned":true}');
    // A wrapper that returned nothing would give undefined here.
    expect(kept(root)!.lines).toEqual(['info', 'warn', 'debug', 'around', 'with a callback', '{"calledBack":true,"returned":true}']);
  });

  test('keeps only its last lines, from the end of what it wrote, and writes them at process.exit too', () => {
    // The bounds the change promises: 40 lines, from at most 64 KiB.
    expect([TRIAL_LOG_LINES, TRIAL_LOG_CHARS]).toEqual([40, 64 * 1024]);
    const root = install();
    const { status } = run(root, [
      `for (let i = 0; i < ${TRIAL_LOG_LINES + 10}; i++) console.log('line ' + i);`,
      'process.exit(3);',
    ].join('\n'));
    expect(status).toBe(3);
    const lines = kept(root)!.lines;
    expect(lines).toHaveLength(TRIAL_LOG_LINES);
    expect(lines[0]).toBe('line 10');
    // A line longer than what's kept keeps its end, and what came after it.
    const long = install();
    run(long, [
      "console.log('before it');",
      `process.stdout.write('z'.repeat(${TRIAL_LOG_CHARS + 100}) + '\\nlast\\n');`,
      'process.exit(3);',
    ].join('\n'));
    const longLines = kept(long)!.lines;
    expect(longLines).toEqual([expect.stringMatching(/^z+$/), 'last']);
    expect(longLines[0]!.length).toBe(TRIAL_LOG_CHARS - '\nlast\n'.length);
  });

  test('keeps nothing once it commits, and still passes what it writes on, formatting and decoding nothing', () => {
    const root = install();
    const { status, stdout, stderr } = run(root, [
      'disarmTrialLog();',
      "console.log('after the commit');",
      "process.stdout.write('written after it\\n');",
      // Bun's console calls this once, and util's format would call it again;
      // Bun's write doesn't read `buffer` through the getter, and decoding would.
      'let inspected = 0;',
      "console.log({ [Symbol.for('nodejs.util.inspect.custom')]() { inspected++; return 'object'; } });",
      'let read = 0;',
      'class Counted extends Uint8Array { get buffer() { read++; return super.buffer; } }',
      "process.stdout.write(new Counted(new TextEncoder().encode('bytes\\n')));",
      "process.stderr.write(JSON.stringify({ inspected, read }) + '\\n');",
      'process.exit(1);',
    ].join('\n'));
    expect(status).toBe(1);
    expect(stdout).toContain('after the commit\nwritten after it\n');
    expect(stderr).toContain('{"inspected":1,"read":0}');
    expect(existsSync(installPaths(root).trialLog)).toBe(false);
  });
});

describe('a start that is no trial keeps nothing', () => {
  test('when no trial is under way', () => {
    const root = install(false);
    const { status, stdout } = run(root, "console.log('an ordinary start'); process.exit(1);");
    expect(status).toBe(1);
    expect(stdout).toContain('an ordinary start');
    expect(existsSync(installPaths(root).trialLog)).toBe(false);
  });

  test('when the trial under way is another release', () => {
    const root = install(false);
    appendJournal(root, { at: '2026-10-24T01:00:00.000Z', step: 'trial-start', from: '0.12.1', to: '0.14.0', outcome: 'ok', mark: 'm2' });
    const { status, stdout } = run(root, "console.log('not the release on trial'); process.exit(1);");
    expect(status).toBe(1);
    expect(stdout).toContain('not the release on trial');
    expect(existsSync(installPaths(root).trialLog)).toBe(false);
  });

  test("when current already names the release on trial, as after a commit whose journal line wasn't written", () => {
    const root = install();
    moveCurrent(root, '0.13.0');
    const { status, stdout } = run(root, "console.log('committed already'); process.exit(1);");
    expect(status).toBe(1);
    expect(stdout).toContain('committed already');
    expect(existsSync(installPaths(root).trialLog)).toBe(false);
  });

  test("when the journal can't be read, and the start goes on", () => {
    const root = install(false);
    writeFileSync(installPaths(root).journal, 'not json\n');
    const { status, stdout } = run(root, "console.log('the start goes on'); process.exit(7);");
    expect(status).toBe(7);
    expect(stdout).toContain('the start goes on');
    expect(existsSync(installPaths(root).trialLog)).toBe(false);
  });
});

test("a trial log that can't be written is said on stderr, and the exit goes on", () => {
  const root = install();
  mkdirSync(`${installPaths(root).trialLog}.tmp`);
  const { status, stderr } = run(root, "console.error('its last words'); process.exit(4);");
  expect(status).toBe(4);
  expect(stderr).toContain("[update] 0.13.0's last lines couldn't be kept for the release that falls back from it " +
    `(${installPaths(root).trialLog}): `);
  expect(existsSync(installPaths(root).trialLog)).toBe(false);
});

describe('the release that falls back', () => {
  const fallback = { v: 1, at: '2026-10-24T01:01:00.000Z', step: 'fallback', from: '0.13.0', to: '0.12.1', outcome: 'ok', reason: '0.13.0 ended before its commit', mark: 'm1' } as const;
  const logOf = (mark: string, release = '0.13.0'): TrialLog =>
    ({ v: 1, release, mark, lines: ['Fatal error: Error: no server'] });

  test('reads the trial log for its own fallback alone', () => {
    const root = install();
    expect(readTrialLog(root, fallback)).toBeNull();
    writeJsonAtomic(installPaths(root).trialLog, logOf('m1'));
    expect(readTrialLog(root, fallback)).toEqual(['Fatal error: Error: no server']);
    writeJsonAtomic(installPaths(root).trialLog, logOf('m0'));
    expect(readTrialLog(root, fallback)).toBeNull();
    writeJsonAtomic(installPaths(root).trialLog, logOf('m1', '0.14.0'));
    expect(readTrialLog(root, fallback)).toBeNull();
  });
});
