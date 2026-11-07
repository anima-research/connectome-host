import { afterAll, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_PATH = join(REPO_ROOT, 'src', 'index.ts');
const HOST_MS = 45_000;

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function gateway() {
  const seen: Array<{ method: string; path: string; authorization: string | null }> = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const body = await req.json().catch(() => ({})) as { stream?: boolean };
      seen.push({ method: req.method, path: new URL(req.url).pathname, authorization: req.headers.get('authorization') });
      const usage = { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 };
      if (!body.stream) {
        return Response.json({ id: 'gen-1', object: 'chat.completion', created: 0, model: 'anthropic/claude-opus-4.6', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage });
      }
      const chunk = (choices: unknown[], extra = {}) => `data: ${JSON.stringify({ id: 'gen-1', object: 'chat.completion.chunk', created: 0, model: 'anthropic/claude-opus-4.6', choices, ...extra })}\n\n`;
      const sse = chunk([{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }])
        + chunk([{ index: 0, delta: {}, finish_reason: 'stop' }], { usage })
        + 'data: [DONE]\n\n';
      return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, seen, stop: () => server.stop(true) };
}

async function proxy() {
  const seen: string[] = [];
  const server = createServer((socket) => {
    socket.once('data', (d) => { seen.push(String(d).split('\r\n')[0]); socket.destroy(); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, seen, stop: () => server.close() };
}

function runOnce(proxyUrl: string, env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'chost-openrouter-'));
  dirs.push(dir);
  const recipe = {
    name: 'OpenRouter Base URL Test',
    agent: { name: 'agent', provider: 'openrouter', model: 'anthropic/claude-opus-4.6', systemPrompt: 'test' },
    modules: { subagents: false, lessons: false, retrieval: false, wake: false, workspace: false },
  };
  const recipePath = join(dir, 'recipe.json');
  writeFileSync(recipePath, JSON.stringify(recipe));
  const child = spawn(process.execPath, [INDEX_PATH, recipePath], {
    cwd: dir,
    // Keep both proxies at the test's own, which records each call's first line and answers none, so no call reaches openrouter.ai.
    env: { ...process.env, DATA_DIR: join(dir, 'data'), HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl, NO_PROXY: '127.0.0.1,localhost', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout!.on('data', (d) => { output += d; });
  child.stderr!.on('data', (d) => { output += d; });
  child.stdin!.end('hello\n');
  let timedOut = false;
  const killer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, HOST_MS);
  const done = new Promise<{ ended: string; output: string }>((r) => child.on('close', (code, signal) => {
    clearTimeout(killer);
    r({ ended: timedOut ? `was killed (SIGKILL) after ${HOST_MS} ms` : code === null ? `was killed (${signal})` : `exited ${code}`, output });
  }));
  return { child, done };
}

describe('OPENROUTER_BASE_URL', () => {
  test('an openrouter recipe sends its calls to OPENROUTER_BASE_URL when it is set', async () => {
    const gate = gateway();
    const outbound = await proxy();
    const run = runOnce(outbound.url, { OPENROUTER_API_KEY: 'sk-or-fixture', OPENROUTER_BASE_URL: `${gate.url}/api/v1` });
    try {
      const { ended, output } = await run.done;
      if (gate.seen.length === 0) throw new Error(`no call reached the gateway; the host ${ended}, after this output:\n${output.slice(-4000)}`);
      for (const r of gate.seen) expect(r).toEqual({ method: 'POST', path: '/api/v1/chat/completions', authorization: 'Bearer sk-or-fixture' });
      expect(outbound.seen).toEqual([]);
    } finally {
      run.child.kill();
      gate.stop();
      outbound.stop();
    }
  }, HOST_MS + 15_000);

  test('an empty OPENROUTER_BASE_URL leaves the calls on openrouter.ai', async () => {
    const outbound = await proxy();
    const run = runOnce(outbound.url, { OPENROUTER_API_KEY: 'sk-or-fixture', OPENROUTER_BASE_URL: '' });
    try {
      const { ended, output } = await run.done;
      if (outbound.seen.length === 0) throw new Error(`no call went out; the host ${ended}, after this output:\n${output.slice(-4000)}`);
      for (const line of outbound.seen) expect(line).toBe('CONNECT openrouter.ai:443 HTTP/1.1');
    } finally {
      run.child.kill();
      outbound.stop();
    }
  }, HOST_MS + 15_000);
});
