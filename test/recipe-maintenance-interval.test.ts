import { describe, expect, spyOn, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectWhenAccepting } from './ipc-connect.js';
import { validateRecipe } from '../src/recipe.js';

const INDEX_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.ts');

const RECIPE = {
  name: 'Maintenance Interval Test',
  agent: { name: 'commander', systemPrompt: 'never asked to infer in this test' },
  modules: { subagents: false, lessons: false, retrieval: false, wake: false, workspace: false },
};

type HostEvent = Record<string, unknown>;

function eventsFrom(socket: Socket): (matches: (event: HostEvent) => boolean) => Promise<HostEvent> {
  const seen: HostEvent[] = [];
  const waiting: Array<{ matches: (event: HostEvent) => boolean; resolve: (event: HostEvent) => void }> = [];
  let buffered = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffered += chunk;
    let end: number;
    while ((end = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      let event: HostEvent;
      try { event = JSON.parse(line) as HostEvent; } catch { continue; }
      seen.push(event);
      for (const waiter of waiting.filter((w) => w.matches(event))) {
        waiting.splice(waiting.indexOf(waiter), 1);
        waiter.resolve(event);
      }
    }
  });
  return (matches) => {
    const found = seen.find(matches);
    return found ? Promise.resolve(found) : new Promise((resolve) => { waiting.push({ matches, resolve }); });
  };
}

async function intervalTheHostRuns(maintenanceIntervalMs: number): Promise<unknown> {
  const dir = mkdtempSync(join(tmpdir(), 'maintenance-interval-'));
  let host: ChildProcess | undefined;
  let gone: Promise<void> | undefined;
  let socket: Socket | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const recipePath = join(dir, 'recipe.json');
    writeFileSync(recipePath, JSON.stringify({ ...RECIPE, maintenanceIntervalMs }));
    const started = spawn(process.execPath, [INDEX_PATH, recipePath, '--headless'], {
      cwd: dir,
      env: { ...process.env, ANTHROPIC_API_KEY: 'sk-test-maintenance', DATA_DIR: dir },
      stdio: 'ignore',
    });
    host = started;
    gone = new Promise((resolve) => { started.once('exit', () => resolve()); });
    const failed = new Promise<never>((_, reject) => {
      started.once('error', reject);
      started.once('exit', (code) => reject(new Error(`the host exited (${code}) before it answered`)));
      deadline = setTimeout(() => reject(new Error('the host gave no answer within 40 s')), 40_000);
    });
    const answer = (async () => {
      socket = await connectWhenAccepting(join(dir, 'ipc.sock'), { timeoutMs: 20_000 });
      const next = eventsFrom(socket);
      await next((e) => e.type === 'lifecycle' && e.phase === 'ready');
      socket.write(JSON.stringify({ type: 'panel-request', op: 'context-maintenance', corrId: 'maintenance' }) + '\n');
      return next((e) => e.type === 'panel-response' && e.corrId === 'maintenance');
    })();
    const response = await Promise.race([answer, failed]);
    expect(response.ok).toBe(true);
    return (response.data as { intervalMs?: unknown }).intervalMs;
  } finally {
    clearTimeout(deadline);
    socket?.destroy();
    if (host?.pid !== undefined) {
      host.kill('SIGKILL');
      await gone;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('maintenanceIntervalMs', () => {
  test('the framework the host builds holds the recipe\'s 0, as its debug panel reports', async () => {
    expect(await intervalTheHostRuns(0)).toBe(0);
  }, 60_000);

  test('2147483647, the most a timer holds, loads', () => {
    expect(validateRecipe({ ...RECIPE, maintenanceIntervalMs: 2147483647 }).maintenanceIntervalMs).toBe(2147483647);
  });

  test('a recipe that sets it loads with no warning of a key the host doesn\'t read', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      validateRecipe({ ...RECIPE, maintenanceIntervalMs: 0 });
      expect(warn.mock.calls.flat().join('\n')).not.toContain('maintenanceIntervalMs');
    } finally {
      warn.mockRestore();
    }
  });

  for (const value of [-1, 1.5, '5000', null, 2147483648]) {
    test(`${JSON.stringify(value)} stops the load, naming the key`, () => {
      expect(() => validateRecipe({ ...RECIPE, maintenanceIntervalMs: value })).toThrow(
        `Recipe maintenanceIntervalMs is ${JSON.stringify(value)}; it must be a whole number of milliseconds from 0 to 2147483647.`,
      );
    });
  }
});
