import { afterAll, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_PATH = join(REPO_ROOT, 'src', 'index.ts');

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

function runOnce(env: Record<string, string>) {
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
    // Keep both proxies at a closed port, so a call bound for any host but the gateway fails instead of reaching openrouter.ai.
    env: { ...process.env, DATA_DIR: join(dir, 'data'), HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout!.on('data', (d) => { output += d; });
  child.stderr!.on('data', (d) => { output += d; });
  child.stdin!.end('hello\n');
  const done = new Promise<{ code: number | null; output: string }>((r) => child.on('close', (code) => r({ code, output })));
  return { child, done };
}

describe('OPENROUTER_BASE_URL', () => {
  test('an openrouter recipe sends its calls to OPENROUTER_BASE_URL when it is set', async () => {
    const gate = gateway();
    const run = runOnce({ OPENROUTER_API_KEY: 'sk-or-fixture', OPENROUTER_BASE_URL: `${gate.url}/api/v1` });
    try {
      const { code, output } = await run.done;
      if (gate.seen.length === 0) throw new Error(`no call reached the gateway; the host exited ${code}, after this output:\n${output.slice(-4000)}`);
      for (const r of gate.seen) expect(r).toEqual({ method: 'POST', path: '/api/v1/chat/completions', authorization: 'Bearer sk-or-fixture' });
    } finally {
      run.child.kill();
      gate.stop();
    }
  }, 60_000);
});
