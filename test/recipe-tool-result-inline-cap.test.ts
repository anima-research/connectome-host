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
  name: 'Tool Result Inline Cap Test',
  agent: { name: 'commander', provider: 'anthropic', model: 'claude-sonnet-4-5-20250929', systemPrompt: 'You are a test.' },
  modules: { subagents: false, lessons: false, retrieval: false, wake: false, workspace: false },
};

const CALL_ID = 'toolu_inline_cap_settings';

function stream(events: Array<Record<string, unknown>>): Response {
  const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

const opening = { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: RECIPE.agent.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } };

/** The agent's first turn calls agent_settings get; the request after it carries the call's result. */
function callsAgentSettings(): Response {
  return stream([
    opening,
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: CALL_ID, name: 'agent_settings', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ action: 'get' }) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ]);
}

function endsTheTurn(): Response {
  return stream([
    opening,
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ]);
}

/** The text of the agent_settings result in a request body, or undefined when the body carries none. */
function settingsResult(body: unknown): string | undefined {
  const messages = (body as { messages?: Array<{ content?: unknown }> }).messages ?? [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content as Array<Record<string, unknown>>) {
      if (block.type !== 'tool_result' || block.tool_use_id !== CALL_ID) continue;
      return typeof block.content === 'string'
        ? block.content
        : (block.content as Array<{ text?: string }>).map((part) => part.text ?? '').join('');
    }
  }
  return undefined;
}

/** What `agent_settings get` reports for the inline cap, in the framework the host builds from `extra`'s recipe. */
async function inlineCapReported(extra: Record<string, unknown>): Promise<{ source: string; effective: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'inline-cap-'));
  let result: ((text: string) => void) | undefined;
  const reported = new Promise<string>((resolveReported) => { result = resolveReported; });
  let calls = 0;
  const model = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (!url.pathname.endsWith('/messages')) return new Response('{}', { status: 404 });
      const body = await request.json();
      const text = settingsResult(body);
      if (text !== undefined) {
        result!(text);
        return endsTheTurn();
      }
      calls++;
      return calls === 1 ? callsAgentSettings() : endsTheTurn();
    },
  });
  let host: ChildProcess | undefined;
  let gone: Promise<void> | undefined;
  let socket: Socket | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const recipePath = join(dir, 'recipe.json');
    writeFileSync(recipePath, JSON.stringify({ ...RECIPE, ...extra }));
    const started = spawn(process.execPath, [INDEX_PATH, recipePath, '--headless'], {
      cwd: dir,
      env: { ...process.env, ANTHROPIC_API_KEY: 'sk-test-inline-cap', ANTHROPIC_BASE_URL: `http://127.0.0.1:${model.port}`, DATA_DIR: dir },
      stdio: 'ignore',
    });
    host = started;
    gone = new Promise((resolveGone) => { started.once('exit', () => resolveGone()); });
    const failed = new Promise<never>((_, reject) => {
      started.once('error', reject);
      started.once('exit', (code) => reject(new Error(`the host exited (${code}) before agent_settings answered`)));
      deadline = setTimeout(() => reject(new Error('agent_settings gave no result within 40 s')), 40_000);
    });
    const asked = (async () => {
      socket = await connectWhenAccepting(join(dir, 'ipc.sock'), { timeoutMs: 20_000 });
      socket.setEncoding('utf8');
      let buffered = '';
      let sent = false;
      socket.on('data', (chunk: string) => {
        buffered += chunk;
        let end: number;
        while ((end = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, end);
          buffered = buffered.slice(end + 1);
          let event: Record<string, unknown>;
          try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
          if (!sent && event.type === 'lifecycle' && event.phase === 'ready') {
            sent = true;
            socket!.write(JSON.stringify({ type: 'text', content: 'What is your inline cap?', from: 'console' }) + '\n');
          }
        }
      });
      return reported;
    })();
    const text = await Promise.race([asked, failed]);
    const source = /"tool_result_inline_max_chars_source"\s*:\s*"([^"]+)"/.exec(text)?.[1];
    const effective = /"tool_result_inline_max_chars_effective"\s*:\s*(\d+)/.exec(text)?.[1];
    if (source === undefined || effective === undefined) throw new Error(`agent_settings get's result names no inline cap: ${text}`);
    return { source, effective: Number(effective) };
  } finally {
    clearTimeout(deadline);
    socket?.destroy();
    if (host?.pid !== undefined) {
      host.kill('SIGKILL');
      await gone;
    }
    model.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('toolResultInlineMaxChars', () => {
  test("the framework the host builds takes the recipe's value: agent_settings get reports it, from framework-config", async () => {
    expect(await inlineCapReported({ toolResultInlineMaxChars: 30_000 })).toEqual({ source: 'framework-config', effective: 30_000 });
  }, 60_000);

  test("left out, agent-framework's own default stands: agent_settings get reports 24000, from default", async () => {
    expect(await inlineCapReported({})).toEqual({ source: 'default', effective: 24_000 });
  }, 60_000);

  test('1000 and a fraction above it load as written', () => {
    expect(validateRecipe({ ...RECIPE, toolResultInlineMaxChars: 1000 }).toolResultInlineMaxChars).toBe(1000);
    expect(validateRecipe({ ...RECIPE, toolResultInlineMaxChars: 30_000.5 }).toolResultInlineMaxChars).toBe(30_000.5);
  });

  const refused: Array<[string, unknown, string]> = [
    ['999', 999, 'Recipe toolResultInlineMaxChars is 999; it must be a finite number of at least 1000.'],
    ['0', 0, 'Recipe toolResultInlineMaxChars is 0; it must be a finite number of at least 1000.'],
    ['Infinity', Infinity, 'Recipe toolResultInlineMaxChars is Infinity; it must be a finite number of at least 1000.'],
    ['a number given as a string', '30000', 'Recipe toolResultInlineMaxChars is "30000"; it must be a finite number of at least 1000.'],
    ['null', null, 'Recipe toolResultInlineMaxChars is null; it must be a finite number of at least 1000.'],
    ['true', true, 'Recipe toolResultInlineMaxChars is true; it must be a finite number of at least 1000.'],
  ];
  for (const [what, value, message] of refused) {
    test(`${what} stops the load, naming the key and the value`, () => {
      expect(() => validateRecipe({ ...RECIPE, toolResultInlineMaxChars: value })).toThrow(message);
    });
  }
});
