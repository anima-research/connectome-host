import { test, expect } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SELF_RESTART_EXIT_CODE, SELF_RESTART_FILE } from '../src/self-restart.js';

type Mode = 'self-restart' | 'sigterm-first' | 'exit-when-idle' | 'held' | 'cancel-in-wait' | 'arm-after-idle' | 'late-arm-gap' | 'unseen-turn';

async function runFixture(mode: Mode, hold?: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'headless-self-restart-')));
  const child = spawn(process.execPath, [join(import.meta.dir, 'mock-headless-self-restart-child.ts'), mode, ...(hold ? [hold] : [])], {
    cwd: dir, env: { ...process.env, DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  try {
    let output = '';
    child.stdout!.on('data', (c) => { output += c; });
    child.stderr!.on('data', (c) => { output += c; });
    const closed = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    if (mode === 'sigterm-first') {
      const deadline = performance.now() + 5000;
      while (!existsSync(join(dir, 'armed'))) {
        if (child.exitCode !== null) throw new Error(`Child exited early: ${output}`);
        if (performance.now() >= deadline) throw new Error(`Never armed: ${output}`);
        await new Promise((r) => setTimeout(r, 10));
      }
      child.kill('SIGTERM');
    }
    const result = await closed;
    return { dir, result, output };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

function expectSelfRestart(dir: string, result: { code: number | null; signal: string | null }, output: string) {
  expect({ code: result.code, signal: result.signal, output: result.code === SELF_RESTART_EXIT_CODE ? '' : output })
    .toEqual({ code: SELF_RESTART_EXIT_CODE, signal: null, output: '' });
  // The stop came after the turn ended and with nothing in flight.
  expect(readFileSync(join(dir, 'stopped'), 'utf-8')).toBe('idle');
  const request = JSON.parse(readFileSync(join(dir, SELF_RESTART_FILE), 'utf-8'));
  expect(request).toMatchObject({ reason: 'fixture restart', requestedBy: 'fixture', exitReason: 'self-restart', exitCode: SELF_RESTART_EXIT_CODE });
  expect(typeof request.exitedAt).toBe('string');
}

test('an armed self-restart exits 75 once the turn has ended, and records the exit', async () => {
  const { dir, result, output } = await runFixture('self-restart');
  expectSelfRestart(dir, result, output);
  expect(readFileSync(join(dir, 'headless.log'), 'utf-8')).toContain('shutdown: self-restart');
  expect(existsSync(join(dir, 'ipc.sock'))).toBe(false);
}, 15_000);

test('another shutdown that comes first exits as it would, and the request records it', async () => {
  const { dir, result } = await runFixture('sigterm-first');
  expect(result.code).toBe(0);
  const request = JSON.parse(readFileSync(join(dir, SELF_RESTART_FILE), 'utf-8'));
  expect(request).toMatchObject({ exitReason: 'SIGTERM', exitCode: 0 });
}, 15_000);

test('under --exit-when-idle, an armed self-restart still exits 75', async () => {
  const { dir, result, output } = await runFixture('exit-when-idle');
  expectSelfRestart(dir, result, output);
}, 15_000);

for (const [hold, what] of [
  ['turn', 'a turn the framework still counts alive'],
  ['gated', 'a gated wake'],
  ['script', 'a running background script'],
  ['queue', 'an event not yet taken off the queue'],
  ['subagent-active', 'a subagent run holding a slot'],
  ['subagent-queued', 'a queued subagent run'],
  ['wake-gap', "a subagent's end, with its wake a loop pass behind,"],
] as const) {
  test(`${what} holds the restart back, though every agent reads idle`, async () => {
    const { dir, result, output } = await runFixture('held', hold);
    expectSelfRestart(dir, result, output);
  }, 15_000);
}

test('under --exit-when-idle, a restart cancelled while it waits gives the exit back: the host exits 0', async () => {
  const { dir, result, output } = await runFixture('cancel-in-wait');
  expect({ code: result.code, signal: result.signal, output: result.code === 0 ? '' : output }).toEqual({ code: 0, signal: null, output: '' });
  expect(readFileSync(join(dir, 'headless.log'), 'utf-8')).toContain('shutdown: exit-when-idle');
  expect(existsSync(join(dir, SELF_RESTART_FILE))).toBe(false);
}, 15_000);

test('a restart armed after the host has gone quiet still goes', async () => {
  const { dir, result, output } = await runFixture('arm-after-idle');
  expectSelfRestart(dir, result, output);
}, 15_000);

test('a restart armed while already quiet waits out its own confirm, so work that starts just after holds it', async () => {
  const { dir, result, output } = await runFixture('late-arm-gap');
  expectSelfRestart(dir, result, output);
}, 15_000);

test('a restart armed in a turn the host never saw start still goes', async () => {
  const { dir, result, output } = await runFixture('unseen-turn');
  expectSelfRestart(dir, result, output);
}, 15_000);
