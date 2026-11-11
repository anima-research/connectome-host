import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURE_OUTPUT_LIMIT, ownedFixtureChild } from './owned-fixture-child.js';

// Deliberate fake startup failure, no CM shim and no runHeadless invocation.
test('fixture readiness diagnoses early exit with a bounded stderr tail instead of eight seconds of ENOENT', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fixture-exit-'));
  const fixture = ownedFixtureChild(['--eval', `process.stderr.write('x'.repeat(100000) + 'missing native release sentinel\\n'); process.exit(7);`]);
  const start = performance.now();
  try {
    let diagnostic = '';
    try { await fixture.connect(join(dir, 'never-created')); } catch (error) { diagnostic = String(error); }
    expect(diagnostic).toContain('missing native release sentinel');
    expect(diagnostic).toContain('exit=7');
    expect(performance.now() - start).toBeLessThan(3_000);
    expect(Buffer.byteLength(fixture.stderr())).toBeLessThanOrEqual(FIXTURE_OUTPUT_LIMIT);
    expect(diagnostic.length).toBeLessThan(FIXTURE_OUTPUT_LIMIT + 2_000);
    expect(existsSync(join(dir, 'never-created'))).toBe(false);
    expect(await fixture.closed).toEqual({ code: 7, signal: null });
  } finally { await fixture.stop(true); rmSync(dir, { recursive: true, force: true }); }
});

test('fixture cleanup escalates only its own verified PID and reaps a TERM-ignoring child', async () => {
  const fixture = ownedFixtureChild(['--eval', `process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000);`]);
  try {
    const deadline = Date.now() + 2_000;
    while (!fixture.stdout().includes('ready')) {
      if (Date.now() > deadline) throw Error(fixture.diagnostics());
      await Bun.sleep(10);
    }
    await fixture.stop();
    expect(await fixture.closed).toEqual({ code: null, signal: 'SIGKILL' });
    await fixture.stop(true); // Already reaped is idempotent, never re-signalled.
  } finally { await fixture.stop(true); }
});

test('fixture command exit deadline reports bounded diagnostics then owned cleanup reaps it', async () => {
  const fixture = ownedFixtureChild(['--eval', `process.stderr.write('waiting sentinel'); setInterval(() => {}, 1000);`]);
  try {
    await expect(fixture.result(100)).rejects.toThrow('Fixture exit deadline');
    expect(fixture.stderr()).toContain('waiting sentinel');
  } finally { await fixture.stop(true); }
  expect((await fixture.closed).signal).toBe('SIGKILL');
});


test('bounded fixture stdout cannot silently truncate a CLI result', async () => {
  const fixture = ownedFixtureChild(['--eval', `process.stdout.write('x'.repeat(100000));`]);
  try {
    expect((await fixture.result()).code).toBe(0);
    expect(() => fixture.stdout()).toThrow('refusing truncated command output');
  } finally { await fixture.stop(true); }
});
