/**
 * Recipe `agent.mock` → membrane MockAdapter. The timing knobs and the
 * response queue let an offline run reproduce delay-sensitive behavior; these
 * tests pin that each validated knob reaches the adapter the host builds and
 * does there what the recipe docs say.
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockAdapter, type ProviderRequest } from '@animalabs/membrane';
import { mockAdapterConfig } from '../src/mock-provider.js';
import { validateRecipe } from '../src/recipe.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_PATH = join(REPO_ROOT, 'src', 'index.ts');

const request = (text = 'hello'): ProviderRequest => ({
  messages: [{ role: 'user', content: text }],
  model: 'mock',
  maxTokens: 100,
});

async function streamChunks(adapter: MockAdapter): Promise<{ chunks: string[]; text: string; ms: number }> {
  const chunks: string[] = [];
  const started = performance.now();
  const response = await adapter.stream(request(), { onChunk: (c) => chunks.push(c) });
  const [block] = response.content as Array<{ type: string; text: string }>;
  return { chunks, text: block!.text, ms: performance.now() - started };
}

describe('mockAdapterConfig', () => {
  test('without a block, the host echoes', () => {
    expect(mockAdapterConfig(undefined)).toEqual({ echoMode: true });
    expect(mockAdapterConfig({})).toEqual({ echoMode: true });
  });

  test('passes every knob through', () => {
    const mock = {
      echoMode: false,
      defaultResponse: 'fallback',
      completeDelayMs: 0,
      streamChunkDelayMs: 7,
      streamChunkSize: 3,
      responseQueue: ['a', 'b'],
    };
    const config = mockAdapterConfig(mock);
    expect(config).toEqual(mock);
    // The adapter drains its queue; the recipe's copy must not change with it.
    expect(config.responseQueue).not.toBe(mock.responseQueue);
  });

  test('passes no key the recipe left out', () => {
    // MockAdapter spreads its config over its defaults: an explicit
    // `streamChunkSize: undefined` would stream an empty reply.
    const config = mockAdapterConfig({ streamChunkDelayMs: 0 });
    expect(Object.keys(config).sort()).toEqual(['echoMode', 'streamChunkDelayMs']);
  });
});

describe('the knobs on the installed MockAdapter', () => {
  test('chunk size and chunk delay shape a streamed reply', async () => {
    const recipe = validateRecipe({
      name: 'mock-knobs',
      agent: {
        provider: 'mock',
        mock: { echoMode: false, responseQueue: ['abcdefg'], streamChunkSize: 3, streamChunkDelayMs: 60 },
      },
    });
    const { chunks, text, ms } = await streamChunks(new MockAdapter(mockAdapterConfig(recipe.agent.mock)));
    expect(chunks).toEqual(['abc', 'def', 'g']);
    expect(text).toBe('abcdefg');
    // Two inter-chunk delays, none before the first chunk.
    expect(ms).toBeGreaterThanOrEqual(110);
  });

  test('the queue answers first, in order, then the echo or defaultResponse', async () => {
    const queued = new MockAdapter(mockAdapterConfig({ responseQueue: ['one', 'two'], streamChunkDelayMs: 0 }));
    expect((await streamChunks(queued)).text).toBe('one');
    expect((await streamChunks(queued)).text).toBe('two');
    expect((await streamChunks(queued)).text).toBe('[Echo] hello');

    const canned = new MockAdapter(mockAdapterConfig({
      echoMode: false, defaultResponse: 'fallback', responseQueue: ['one'], streamChunkDelayMs: 0,
    }));
    expect((await streamChunks(canned)).text).toBe('one');
    expect((await streamChunks(canned)).text).toBe('fallback');
  });

  test('completeDelayMs holds a non-streamed reply', async () => {
    const adapter = new MockAdapter(mockAdapterConfig({ completeDelayMs: 80 }));
    const started = performance.now();
    await adapter.complete(request());
    expect(performance.now() - started).toBeGreaterThanOrEqual(70);
  });
});

describe('the host builds its mock from agent.mock', () => {
  const dirs: string[] = [];
  afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

  test('a queued reply comes back from a batch run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chost-mock-knobs-'));
    dirs.push(dir);
    const recipePath = join(dir, 'recipe.json');
    writeFileSync(recipePath, JSON.stringify({
      name: 'Mock Knobs',
      agent: {
        name: 'agent', provider: 'mock', systemPrompt: 'mock',
        mock: { responseQueue: ['queued reply from the recipe'], streamChunkSize: 4, streamChunkDelayMs: 1 },
      },
      modules: { subagents: false, lessons: false, retrieval: false, wake: false, workspace: false },
    }));
    // cwd=dir keeps the developer's own mcpl-servers.json out of the run.
    const child = spawn(process.execPath, [INDEX_PATH, recipePath], {
      cwd: dir,
      env: { ...process.env, DATA_DIR: join(dir, 'data') },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let closed = false;
    child.stdout!.on('data', (c: Buffer) => { out += c.toString('utf-8'); });
    child.stderr!.on('data', (c: Buffer) => { err += c.toString('utf-8'); });
    // 'close', not 'exit': only then have the stdio pipes delivered everything.
    const done = new Promise<void>((r) => child.on('close', () => { closed = true; r(); }));
    child.stdin!.end('hello\n');
    try {
      // Stop early if the host dies at startup, rather than waiting it out.
      const deadline = Date.now() + 30_000;
      while (!out.includes('Done.') && !closed && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const replied = out.includes('queued reply from the recipe');
      const echoed = out.includes('[Echo]');
      // On failure the diff carries the host's own output, e.g. a startup error.
      const output = replied && !echoed ? '' : `stdout:\n${out}\nstderr (tail):\n${err.slice(-4000)}`;
      expect({ replied, echoed, output }).toEqual({ replied: true, echoed: false, output: '' });
    } finally {
      child.kill('SIGKILL');
      await done;
    }
  }, 60_000);
});
