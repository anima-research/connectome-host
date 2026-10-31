import { describe, expect, test } from 'bun:test';
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
  name: 'Inference Bounds Test',
  agent: { name: 'commander', provider: 'anthropic', model: 'claude-sonnet-4-5-20250929', systemPrompt: 'You are a test.' },
  modules: { subagents: false, lessons: false, retrieval: false, wake: false, workspace: false },
};

type HostEvent = Record<string, unknown>;

async function firstCutOfAStalledCall(inferenceBounds: unknown): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'inference-bounds-'));
  const stalled = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch: () => new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'text/event-stream' } }),
  });
  let host: ChildProcess | undefined;
  let gone: Promise<void> | undefined;
  let socket: Socket | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const recipePath = join(dir, 'recipe.json');
    writeFileSync(recipePath, JSON.stringify({ ...RECIPE, inferenceBounds }));
    const started = spawn(process.execPath, [INDEX_PATH, recipePath, '--headless'], {
      cwd: dir,
      env: { ...process.env, ANTHROPIC_API_KEY: 'sk-test-bounds', ANTHROPIC_BASE_URL: `http://127.0.0.1:${stalled.port}`, DATA_DIR: dir },
      stdio: 'ignore',
    });
    host = started;
    gone = new Promise((resolve) => { started.once('exit', () => resolve()); });
    const failed = new Promise<never>((_, reject) => {
      started.once('error', reject);
      started.once('exit', (code) => reject(new Error(`the host exited (${code}) before a call was cut`)));
      deadline = setTimeout(() => reject(new Error('no call was cut within 30 s')), 30_000);
    });
    const cut = (async () => {
      socket = await connectWhenAccepting(join(dir, 'ipc.sock'), { timeoutMs: 20_000 });
      socket.setEncoding('utf8');
      let buffered = '';
      let sent = false;
      return await new Promise<string>((resolveCut) => {
        socket!.on('data', (chunk: string) => {
          buffered += chunk;
          let end: number;
          while ((end = buffered.indexOf('\n')) >= 0) {
            const line = buffered.slice(0, end);
            buffered = buffered.slice(end + 1);
            let event: HostEvent;
            try { event = JSON.parse(line) as HostEvent; } catch { continue; }
            if (!sent && event.type === 'lifecycle' && event.phase === 'ready') {
              sent = true;
              socket!.write(JSON.stringify({ type: 'text', content: 'Say hello.', from: 'console' }) + '\n');
            }
            if (event.type === 'inference:failed') resolveCut(String(event.error));
          }
        });
      });
    })();
    return await Promise.race([cut, failed]);
  } finally {
    clearTimeout(deadline);
    socket?.destroy();
    if (host?.pid !== undefined) {
      host.kill('SIGKILL');
      await gone;
    }
    stalled.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('inferenceBounds', () => {
  test('the framework the host builds cuts a stalled call at the recipe\'s beforeContentMs, naming it', async () => {
    const error = await firstCutOfAStalledCall({ progressBounds: { beforeContentMs: 1000 } });
    expect(error).toContain('No content within 1s of the send');
    expect(error).toContain('inferenceBounds.progressBounds.beforeContentMs');
  }, 60_000);

  test('false and an object of bounds load as written', () => {
    expect(validateRecipe({ ...RECIPE, inferenceBounds: false }).inferenceBounds).toBe(false);
    const bounds = { progressBounds: { beforeContentMs: 90_000, betweenEventsMs: 200_000, thinkTokensPerSecond: 60 }, flatMinimumMs: 3_600_000 };
    expect(validateRecipe({ ...RECIPE, inferenceBounds: bounds }).inferenceBounds).toEqual(bounds);
  });

  const refused: Array<[string, unknown, string]> = [
    ['true', true, 'Recipe inferenceBounds must be false or an object, got true.'],
    ['an array', [], 'Recipe inferenceBounds must be false or an object, got [].'],
    ['a misspelt key', { progressbounds: {} }, 'Recipe inferenceBounds has unknown key "progressbounds"; it takes progressBounds and flatMinimumMs.'],
    ['progressBounds that isn\'t an object', { progressBounds: true }, 'Recipe inferenceBounds.progressBounds must be an object, got true.'],
    ['progressBounds of null', { progressBounds: null }, 'Recipe inferenceBounds.progressBounds must be an object, got null.'],
    ['a bound that isn\'t finite', { progressBounds: { thinkTokensPerSecond: Infinity } }, 'Recipe inferenceBounds.progressBounds.thinkTokensPerSecond must be a finite number above 0, got Infinity.'],
    ['a misspelt bound', { progressBounds: { beforeContentMS: 90_000 } }, 'Recipe inferenceBounds.progressBounds has unknown key "beforeContentMS"; it takes beforeContentMs, betweenEventsMs and thinkTokensPerSecond.'],
    ['a bound of 0', { progressBounds: { betweenEventsMs: 0 } }, 'Recipe inferenceBounds.progressBounds.betweenEventsMs must be a finite number above 0, got 0.'],
    ['a bound given as a string', { progressBounds: { beforeContentMs: '90000' } }, 'Recipe inferenceBounds.progressBounds.beforeContentMs must be a finite number above 0, got "90000".'],
    ['a negative flatMinimumMs', { flatMinimumMs: -1 }, 'Recipe inferenceBounds.flatMinimumMs must be a finite number above 0, got -1.'],
  ];
  for (const [what, value, message] of refused) {
    test(`${what} stops the load, naming the key`, () => {
      expect(() => validateRecipe({ ...RECIPE, inferenceBounds: value })).toThrow(message);
    });
  }
});
