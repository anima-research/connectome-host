import { test, expect } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RESTART_EXIT_CODE, readMark } from '../src/update/contract.js';

type Mode = 'update' | 'token-held-after-turn' | 'script-starts-in-quiesce' | 'switch-starts-in-quiesce' |
  'operator-starts-in-quiesce' | 'credential-starts-in-quiesce' | 'stop-in-quiesce';

async function runFixture(mode: Mode) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'headless-self-update-')));
  const child = spawn(process.execPath, [join(import.meta.dir, 'mock-headless-self-update-child.ts'), mode], {
    cwd: dir, env: { ...process.env, DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  try {
    let output = '';
    child.stdout!.on('data', (c) => { output += c; });
    child.stderr!.on('data', (c) => { output += c; });
    const result = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    return { dir, result, output };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

for (const [mode, what] of [
  ['update', 'once the turn that armed it has ended'],
  ['token-held-after-turn', 'once a turn token held after that turn has gone too'],
  ['script-starts-in-quiesce', 'once a background script that starts during its quiesce has ended'],
  ['switch-starts-in-quiesce', 'once a session switch that starts during its quiesce has ended'],
  ['operator-starts-in-quiesce', 'once an operator\'s work that starts during its quiesce has ended'],
  ['credential-starts-in-quiesce', 'once a credential action that starts during its quiesce has ended'],
] as const) {
  test(`an agent's own update restart writes the switch to the installed release and exits 75, with every agent idle, ${what}`, async () => {
    const { dir, result, output } = await runFixture(mode);
    expect(JSON.parse(readFileSync(join(dir, 'armed'), 'utf-8'))).toMatchObject({ done: true });
    expect({ code: result.code, signal: result.signal, output: result.code === RESTART_EXIT_CODE ? '' : output })
      .toEqual({ code: RESTART_EXIT_CODE, signal: null, output: '' });
    expect(readFileSync(join(dir, 'stopped'), 'utf-8')).toBe('idle');
    expect(readMark(join(dir, 'install'))).toMatchObject({ to: '0.15.0', why: 'update' });
    expect(existsSync(join(dir, 'install', 'armed-dropped.json'))).toBe(false);
    expect(existsSync(join(dir, 'seen-turn'))).toBe(true);
    expect(existsSync(join(dir, 'quiesced-while-busy'))).toBe(false);
    expect(existsSync(join(dir, 'seen-token'))).toBe(mode === 'token-held-after-turn');
    if (mode.endsWith('-starts-in-quiesce')) {
      expect(readFileSync(join(dir, 'blocked'), 'utf-8')).toContain('so the switch\'s quiesce ended');
    }
    if (mode === 'script-starts-in-quiesce') expect(readFileSync(join(dir, 'started'), 'utf-8')).toBe('script');
    if (mode === 'switch-starts-in-quiesce') expect(readFileSync(join(dir, 'started'), 'utf-8')).toBe('switch');
    if (mode === 'operator-starts-in-quiesce') expect(readFileSync(join(dir, 'started'), 'utf-8')).toBe('operator');
    if (mode === 'credential-starts-in-quiesce') expect(readFileSync(join(dir, 'started'), 'utf-8')).toBe('credential');
  }, 20_000);
}

test('a stop that begins during an armed update\'s quiesce ends the host as that stop does, writes no switch, and keeps the dropped arm for the next start', async () => {
  const { dir, result, output } = await runFixture('stop-in-quiesce');
  expect(readFileSync(join(dir, 'started'), 'utf-8')).toBe('stop');
  expect({ code: result.code, signal: result.signal, output: result.code === 0 ? '' : output })
    .toEqual({ code: 0, signal: null, output: '' });
  expect(readMark(join(dir, 'install'))).toBeNull();
  expect(JSON.parse(readFileSync(join(dir, 'install', 'armed-dropped.json'), 'utf-8')))
    .toMatchObject({ to: '0.15.0', why: 'update', reason: 'the host stopped first (SIGTERM).' });
}, 20_000);
