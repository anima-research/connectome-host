import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { type Socket } from 'node:net';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectWhenAccepting } from './ipc-connect.js';
import { compressionModelOf } from '../src/framework-strategy.js';
import type { Recipe } from '../src/recipe.js';
import { buildCountCheck, buildShellCheck, type PanelAppRef } from '../src/web/panel-data.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = join(resolve(TEST_DIR, '..'), 'src', 'index.ts');
const LADDER = join(resolve(TEST_DIR, '..'), 'scripts', 'connectome-doctor');
// The ladder reads /proc and runs under python3, so its test runs on Linux, where CI runs the suite.
const ladderUnrunnable = process.platform !== 'linux' || (!Bun.which('python3') && !process.env.CI);

// Shaped like terminal-sessions-mcp 1.7.3 as it answered when probed:
// `listSessions` answers its sessions as JSON text, and with a missing or
// wrong token it answers JSON-RPC error -32000 "Connection lost".
const FAKE_SHELL = `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const mode = process.argv[2];
const calls = process.argv[3];
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const tools = mode === 'other'
  ? [{ name: 'ping', description: 'ping', inputSchema: { type: 'object', properties: {} } }]
  : [{ name: 'listSessions', description: 'List all active sessions', inputSchema: { type: 'object', properties: {} } }];
createInterface({ input: process.stdin }).on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined || msg.method === undefined) return;
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'terminal-sessions-mcp', version: '1.7.3' },
    } });
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools } });
    if (mode === 'dies') setTimeout(() => process.exit(0), 200);
  } else if (msg.method === 'tools/call' && msg.params?.name === 'listSessions') {
    if (calls) appendFileSync(calls, JSON.stringify(msg.params.arguments ?? null) + '\\n');
    if (mode === 'lost') send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'Connection lost' } });
    else send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify([{ id: 'a' }, { id: 'b' }], null, 2) }] } });
  } else {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  }
});
`;

function lineReader(socket: Socket): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  socket.setEncoding('utf8');
  let buf = '';
  socket.on('data', (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try { events.push(JSON.parse(line) as Record<string, unknown>); } catch {}
    }
  });
  return events;
}

function journalOf(stream: NodeJS.ReadableStream, path: string, pid: number): void {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      appendFileSync(path, `${(Date.now() / 1000).toFixed(6)} host bun[${pid}]: ${buf.slice(0, i)}\n`);
      buf = buf.slice(i + 1);
    }
  });
}

async function waitFor(check: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms: ${label}`);
}

describe('doctor host checks over the socket', () => {
  let dir: string;
  let child: ChildProcess;
  let sock: Socket;
  let events: Array<Record<string, unknown>>;
  let countServer: ReturnType<typeof Bun.serve>;
  let recipePath: string;
  let journalPath: string;
  let started: number;
  const countedModels: string[] = [];
  const countedBodies: Array<{ model?: string; system?: unknown; tools?: unknown[]; messages?: unknown[] }> = [];
  let seq = 0;

  async function panel(op: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const corrId = `doctor-${++seq}`;
    sock.write(JSON.stringify({ type: 'panel-request', op, params, corrId }) + '\n');
    await waitFor(() => events.some((e) => e.type === 'panel-response' && e.corrId === corrId), 20_000, `panel-response ${op}`);
    return events.find((e) => e.type === 'panel-response' && e.corrId === corrId)!;
  }

  beforeAll(async () => {
    countServer = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const body = (await req.json()) as { model?: string; system?: unknown; tools?: unknown[]; messages?: unknown[] };
        const counting = new URL(req.url).pathname === '/v1/messages/count_tokens';
        if (counting) {
          countedModels.push(body.model ?? '');
          countedBodies.push(body);
        }
        if (counting && body.model === 'claude-live-test') {
          return Response.json({ input_tokens: 7 + ((body.tools?.length ?? 0) > 0 ? 1_000 : 0) });
        }
        return Response.json({ type: 'error', error: { type: 'not_found_error', message: 'model' } }, { status: 404 });
      },
    });
    dir = mkdtempSync(join(tmpdir(), 'chost-doctor-'));
    const serverPath = join(dir, 'fake-shell.mjs');
    writeFileSync(serverPath, FAKE_SHELL);
    const recipe = {
      name: 'Doctor Checks',
      agent: {
        name: 'resident',
        model: 'claude-live-test',
        systemPrompt: 'never asked to infer in this test',
        strategy: { type: 'autobiographical', compressionModel: 'claude-dead-test' },
      },
      modules: { subagents: false, lessons: false, retrieval: false, wake: false, workspace: false },
      mcpServers: {
        shell: { command: process.execPath, args: [serverPath, 'ok', join(dir, 'calls.jsonl')] },
        brokenshell: { command: process.execPath, args: [serverPath, 'lost', join(dir, 'calls.jsonl')] },
        dying: { command: process.execPath, args: [serverPath, 'dies', join(dir, 'calls.jsonl')], reconnect: false },
        other: { command: process.execPath, args: [serverPath, 'other'] },
        down: { command: process.execPath, args: ['-e', 'process.exit(1)'], reconnect: false },
        closed: { command: process.execPath, args: [serverPath, 'ok', join(dir, 'closed-calls.jsonl')], presentation: 'closed-tab' },
      },
    };
    recipePath = join(dir, 'recipe.json');
    writeFileSync(recipePath, JSON.stringify(recipe));
    const env: Record<string, string | undefined> = {
      ...process.env,
      ANTHROPIC_API_KEY: 'sk-test-doctor',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${countServer.port}`,
      DATA_DIR: dir,
    };
    delete env.COUNT_TOKENS_MODEL;
    delete env.MODEL;
    journalPath = join(dir, 'journal.txt');
    writeFileSync(journalPath, '');
    started = Math.floor(Date.now() / 1000);
    child = spawn(process.execPath, [INDEX_PATH, recipePath, '--headless'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    journalOf(child.stdout!, journalPath, child.pid!);
    journalOf(child.stderr!, journalPath, child.pid!);
    const socketPath = join(dir, 'ipc.sock');
    await waitFor(() => existsSync(socketPath), 20_000, 'socket file appears');
    sock = await connectWhenAccepting(socketPath);
    events = lineReader(sock);
    await waitFor(() => events.some((e) => e.type === 'lifecycle' && e.phase === 'ready'), 5_000, 'lifecycle ready');
  }, 30_000);

  afterAll(async () => {
    const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve()
      : new Promise<void>((done) => child.once('exit', () => done()));
    try { sock.write(JSON.stringify({ type: 'shutdown' }) + '\n'); } catch {}
    const killer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    await exited;
    clearTimeout(killer);
    try { sock.destroy(); } catch {}
    countServer.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test('shell-check calls listSessions with no arguments on each connected server that offers it, leaves the agent\'s next request as it was, whole, and names those not connected, with whether the host still retries them', async () => {
    const live = async () => ((await panel('mcpl')).data as { live: Array<{ id: string; connected: boolean }> }).live;
    for (let i = 0; i < 100 && (await live()).find((s) => s.id === 'dying')?.connected !== false; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect((await live()).find((s) => s.id === 'dying')?.connected).toBe(false);
    const nextRequest = async () => ((await panel('debug-context')).data as { request: unknown }).request;
    const seed = 'a message from before the shell check';
    const idles = events.filter((e) => e.type === 'lifecycle' && e.phase === 'idle').length;
    sock.write(JSON.stringify({ type: 'text', content: seed }) + '\n');
    await waitFor(() => events.filter((e) => e.type === 'lifecycle' && e.phase === 'idle').length > idles, 20_000,
      'the host idle after the seeded message');
    const before = await nextRequest();
    expect(JSON.stringify(before)).toContain(seed);
    expect(await nextRequest()).toEqual(before);
    const res = await panel('shell-check');
    expect(res.ok).toBe(true);
    const data = res.data as {
      shells: Array<{ server: string; answered: boolean; sessions?: number | null; error?: string }>;
      notConnected: Array<{ id: string; retrying: boolean; refused: string | null }>;
    };
    const byServer = new Map(data.shells.map((s) => [s.server, s]));
    expect([...byServer.keys()].sort()).toEqual(['brokenshell', 'shell']);
    expect(byServer.get('shell')).toEqual({ server: 'shell', answered: true, sessions: 2 });
    expect(byServer.get('brokenshell')!.answered).toBe(false);
    expect(byServer.get('brokenshell')!.error).toContain('Connection lost');
    expect(data.notConnected.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 'down', retrying: false, refused: null },
      { id: 'dying', retrying: false, refused: null },
    ]);
    const calls = readFileSync(join(dir, 'calls.jsonl'), 'utf-8').split('\n').filter(Boolean);
    expect(calls).toEqual(['{}', '{}']);
    expect(await nextRequest()).toEqual(before);
  }, 30_000);

  test('shell-check names a server kept as a closed tab apart from those not connected, calls nothing on it and leaves it closed', async () => {
    const res = await panel('shell-check');
    const data = res.data as { shells: Array<{ server: string }>; notConnected: Array<{ id: string }>; closedTabs: string[] };
    const live = ((await panel('mcpl')).data as { live: Array<{ id: string; connected: boolean; closedTab?: boolean }> }).live;
    const after = live.find((s) => s.id === 'closed');
    expect({
      closedTabs: data.closedTabs,
      amongNotConnected: data.notConnected.some((s) => s.id === 'closed'),
      amongShells: data.shells.some((s) => s.server === 'closed'),
      called: existsSync(join(dir, 'closed-calls.jsonl')),
      afterwards: { connected: after?.connected, closedTab: after?.closedTab },
    }).toEqual({
      closedTabs: ['closed'], amongNotConnected: false, amongShells: false, called: false,
      afterwards: { connected: false, closedTab: true },
    });
  }, 30_000);

  test('count-check counts with the agent\'s model and, separately, its compression model, once each, and what the host sends beside the conversation, less the one message', async () => {
    const from = countedModels.length;
    const res = await panel('count-check');
    expect(res.ok).toBe(true);
    const data = res.data as {
      agent: { model: string; countModel: string | null; source: string };
      compression: { model: string; countModel: string | null; source: string } | null;
      beside: { tokens: number | null; source: string };
    };
    expect(data.agent).toEqual({ model: 'claude-live-test', countModel: 'claude-live-test', source: 'count_tokens' });
    expect(data.compression).toEqual({ model: 'claude-dead-test', countModel: 'claude-dead-test', source: 'count_tokens_failed_404' });
    expect(data.beside).toEqual({ tokens: 1_000, source: 'count_tokens' });
    expect((data as { budget?: unknown }).budget).toBe(300_000);
    expect(countedModels.slice(from).sort()).toEqual(['claude-dead-test', 'claude-live-test', 'claude-live-test']);
    const beside = countedBodies.slice(from).find((body) => (body.tools?.length ?? 0) > 0)!;
    expect(JSON.stringify(beside.system)).toContain('never asked to infer in this test');
    expect(JSON.stringify(beside.tools)).toContain('listSessions');
    expect(beside.messages).toHaveLength(1);
    expect(JSON.stringify(beside.messages)).toContain('ping');
    const { loadRecipeDetailed, recipeDigest } = await import('../src/recipe.js') as unknown as {
      loadRecipeDetailed: (path: string) => Promise<{ recipe: unknown }>;
      recipeDigest: (recipe: unknown) => string;
    };
    expect((data as { recipeDigest?: unknown }).recipeDigest).toBe(recipeDigest((await loadRecipeDetailed(recipePath)).recipe));
  }, 30_000);

  test.skipIf(ladderUnrunnable)('the ladder reads this host\'s own gate dump from its journal, with the gate and active streams it reads', async () => {
    const work = mkdtempSync(join(tmpdir(), 'chost-doctor-ladder-'));
    const bins = join(work, 'bin');
    mkdirSync(bins);
    mkdirSync(join(work, 'logs'));
    writeFileSync(join(work, 'unit.txt'), '');
    const tool = (name: string, lines: string[]): void => {
      writeFileSync(join(bins, name), ['#!/bin/sh', ...lines, ''].join('\n'));
      chmodSync(join(bins, name), 0o755);
    };
    const startStamp = new Date(started * 1000).toUTCString().replace('GMT', 'UTC');
    tool('systemctl', [
      'case "$*" in',
      `  *FragmentPath*) echo ${join(work, 'unit.txt')} ;;`,
      `  *--value*) echo ${child.pid} ;;`,
      `  *) printf "ActiveState=active\\nSubState=running\\nNRestarts=0\\nExecMainStartTimestamp=${startStamp}\\nMainPID=${child.pid}\\n" ;;`,
      'esac',
    ]);
    tool('journalctl', [
      'unit="--user -u connectome-test.service"',
      'case "$*" in',
      `  "$unit -q --no-pager -n 1 -o short-unix") tail -n 1 ${journalPath} ;;`,
      `  "$unit -q --no-pager --since @"*" -g "*" -o short-unix") awk -v since="\${7#@}" '$1 + 0 >= since' ${journalPath} | grep -P -- "$9" ;;`,
      `  "$unit -o cat --no-pager --since @"*) awk -v since="\${8#@}" '$1 + 0 >= since { sub(/^[^ ]+ [^ ]+ [^ ]+ /, ""); print }' ${journalPath} ;;`,
      '  *) echo "journalctl stand-in: arguments it doesn\'t answer: $*" >&2; exit 2 ;;',
      'esac',
    ]);
    const ladder = spawn('python3', [LADDER, '--data-dir', dir, work, 'connectome-test.service'], {
      env: { ...process.env, PATH: `${bins}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    ladder.stdout!.on('data', (chunk) => { out += chunk; });
    ladder.stderr!.on('data', (chunk) => { out += chunk; });
    await new Promise<void>((done) => ladder.once('close', () => done()));
    rmSync(work, { recursive: true, force: true });
    const said = out.split('\n').find((line) => line.startsWith('live gate dump'));
    expect(said ?? out).toStartWith('live gate dump (SIGUSR2): {');
    const dump = JSON.parse(said!.slice(said!.indexOf('{'))) as Record<string, unknown>;
    expect({ gate: 'gate' in dump ? dump.gate : 'missing', activeStreams: Array.isArray(dump.activeStreams) })
      .toEqual({ gate: null, activeStreams: true });
    expect({ exitCode: child.exitCode, signalCode: child.signalCode }).toEqual({ exitCode: null, signalCode: null });
  }, 30_000);
});

describe('count-check, with a stand-in for the framework', () => {
  const appWith = (model: string, strategy?: Record<string, unknown>): PanelAppRef => ({
    recipe: { name: 'r', agent: { name: 'resident', systemPrompt: '', ...(strategy ? { strategy } : {}) } } as unknown as Recipe,
    framework: { getAgent: () => ({ model }), getAllAgents: () => [{ name: 'resident' }] } as unknown as PanelAppRef['framework'],
  });
  const saved: Record<string, string | undefined> = {};
  const setEnv = (values: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(values)) {
      if (!(k in saved)) saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  afterAll(() => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });

  test('the recipe\'s digest is the one taken as it loaded, so a config changed after the load, as an extension\'s register can, leaves it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chost-digest-'));
    try {
      const path = join(dir, 'recipe.json');
      writeFileSync(path, JSON.stringify({ name: 'r', agent: { name: 'resident', model: 'claude-agent-test', systemPrompt: 'hello', strategy: { type: 'passthrough' } } }));
      const { loadRecipeDetailed, recipeDigest } = await import('../src/recipe.js');
      const { recipe } = await loadRecipeDetailed(path, { fetchSystemPrompt: false });
      const atLoad = recipeDigest(recipe);
      (recipe.agent.strategy as unknown as Record<string, unknown>).filledAfterLoad = true;
      expect(recipeDigest(recipe)).not.toBe(atLoad);
      setEnv({ COUNT_TOKENS_MODEL: undefined, ANTHROPIC_API_KEY: 'sk-count-test', ANTHROPIC_AUTH_TOKEN: undefined, ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' });
      const check = await buildCountCheck({
        recipe,
        framework: { getAgent: () => ({ model: 'claude-agent-test' }), getAllAgents: () => [{ name: 'resident' }] } as unknown as PanelAppRef['framework'],
      }, 300);
      expect(check.recipeDigest).toBe(atLoad);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an empty compressionModel is reported as that model, not as a strategy with no compression, and only the agent\'s model is counted', async () => {
    const seen: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        seen.push(((await req.json()) as { model: string }).model);
        return Response.json({ input_tokens: 3 });
      },
    });
    try {
      setEnv({ COUNT_TOKENS_MODEL: undefined, ANTHROPIC_API_KEY: 'sk-count-test', ANTHROPIC_AUTH_TOKEN: undefined, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}` });
      const check = await buildCountCheck(appWith('claude-agent-test', { type: 'autobiographical', compressionModel: '' }));
      expect(check.compression).toEqual({ model: '', countModel: null, source: 'count_tokens_unsupported_model' });
      expect(seen).toEqual(['claude-agent-test']);
    } finally {
      server.stop(true);
    }
  });

  test('it counts one message, with the key, with COUNT_TOKENS_MODEL in place of the agent\'s model when that\'s set', async () => {
    const seen: Array<{ key: string | null; model: string; messages: number }> = [];
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const body = (await req.json()) as { model: string; messages: unknown[] };
        seen.push({ key: req.headers.get('x-api-key'), model: body.model, messages: body.messages.length });
        return Response.json({ input_tokens: 3 });
      },
    });
    try {
      setEnv({ COUNT_TOKENS_MODEL: 'claude-count-test', ANTHROPIC_API_KEY: 'sk-count-test', ANTHROPIC_AUTH_TOKEN: undefined, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}` });
      const check = await buildCountCheck(appWith('claude-agent-test', { type: 'passthrough' }));
      expect(check.agent).toEqual({ model: 'claude-agent-test', countModel: 'claude-count-test', source: 'count_tokens' });
      expect(seen).toEqual([{ key: 'sk-count-test', model: 'claude-count-test', messages: 1 }]);
      expect(check.beside).toMatchObject({ tokens: null, source: 'preview_failed' });
    } finally {
      server.stop(true);
    }
  });

  test('a count with no credential to send is still asked: a 401 to it is no credential, other answers keep their status, and a 401 to a sent credential stays a refusal', async () => {
    const seen: Array<{ key: string | null; authorization: string | null }> = [];
    let status = 401;
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        await req.json();
        seen.push({ key: req.headers.get('x-api-key'), authorization: req.headers.get('authorization') });
        return status === 200 ? Response.json({ input_tokens: 3 }) : Response.json({}, { status });
      },
    });
    const strategy = { type: 'autobiographical', compressionModel: 'claude-compress-test' };
    const recipeOn = (provider: string, login?: string): PanelAppRef => {
      const app = appWith('claude-agent-test', strategy);
      (app.recipe.agent as { provider?: string }).provider = provider;
      return login === undefined ? app : { ...app, credentials: { bearer: () => login } } as unknown as PanelAppRef;
    };
    const sent = async (app: PanelAppRef) => {
      const from = seen.length;
      const check = await buildCountCheck(app);
      return { source: check.agent.source, compression: check.compression?.source, carried: seen.slice(from) };
    };
    const nothing = { key: '', authorization: null };
    try {
      setEnv({ COUNT_TOKENS_MODEL: undefined, ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}` });
      for (const provider of ['mock', 'openrouter']) {
        expect([provider, await sent(recipeOn(provider))]).toEqual([provider, {
          source: 'count_tokens_no_credential', compression: 'count_tokens_no_credential', carried: [nothing, nothing],
        }]);
      }
      for (const blank of ['', '   ']) {
        setEnv({ ANTHROPIC_API_KEY: blank, ANTHROPIC_AUTH_TOKEN: blank });
        expect([blank, (await sent(recipeOn('mock'))).source]).toEqual([blank, 'count_tokens_no_credential']);
      }
      setEnv({ ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined });
      status = 403;
      expect((await sent(recipeOn('openrouter'))).source).toBe('count_tokens_failed_403');
      status = 200;
      expect((await sent(recipeOn('openrouter'))).source).toBe('count_tokens');
      status = 401;
      setEnv({ ANTHROPIC_API_KEY: 'sk-count-test' });
      const keyed = await sent(recipeOn('openrouter'));
      expect([keyed.source, keyed.carried[0]]).toEqual(['count_tokens_failed_401', { key: 'sk-count-test', authorization: null }]);
      setEnv({ ANTHROPIC_AUTH_TOKEN: 'token-count-test' });
      const token = await sent(recipeOn('openrouter'));
      expect([token.source, token.carried[0]]).toEqual(['count_tokens_failed_401', { key: null, authorization: 'Bearer token-count-test' }]);
      const login = await sent(recipeOn('openrouter', 'login-count-test'));
      expect([login.source, login.carried[0]]).toEqual(['count_tokens_failed_401', { key: null, authorization: 'Bearer login-count-test' }]);
    } finally {
      server.stop(true);
    }
  });

  test('a count that doesn\'t answer within its limit is reported as timed out when the limit runs out', async () => {
    let asked = 0;
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => { asked += 1; return new Promise<Response>(() => undefined); } });
    try {
      setEnv({ COUNT_TOKENS_MODEL: undefined, ANTHROPIC_API_KEY: 'sk-count-test', ANTHROPIC_AUTH_TOKEN: undefined, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}` });
      const check = await buildCountCheck(appWith('claude-agent-test', { type: 'passthrough' }), 300);
      expect(asked).toBe(1);
      expect(check.agent.source).toBe('count_tokens_timeout');
    } finally {
      server.stop(true);
    }
  });

  test('a count whose answer stops partway through its body is reported as timed out when the limit runs out, too', async () => {
    const start = '{"input_tokens":';
    let asked = 0;
    let sentAt: number | null = null;
    const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: {
      data(socket) {
        if (sentAt !== null) return;
        asked += 1;
        const head = `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 64\r\n\r\n${start}`;
        if (socket.write(head) === head.length) sentAt = Date.now();
      },
    } });
    const realFetch = globalThis.fetch;
    let headAt: number | null = null;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      const answer = await realFetch(...args);
      headAt = Date.now();
      return answer;
    }) as unknown as typeof fetch;
    try {
      setEnv({ COUNT_TOKENS_MODEL: undefined, ANTHROPIC_API_KEY: 'sk-count-test', ANTHROPIC_AUTH_TOKEN: undefined, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}` });
      const began = Date.now();
      const check = await buildCountCheck(appWith('claude-agent-test', { type: 'passthrough' }), 300);
      expect(asked).toBe(1);
      expect(sentAt).not.toBeNull();
      expect(sentAt! - began).toBeLessThan(300);
      expect(headAt).not.toBeNull();
      expect(headAt! - began).toBeLessThan(300);
      expect(check.agent.source).toBe('count_tokens_timeout');
    } finally {
      globalThis.fetch = realFetch;
      server.stop(true);
    }
  });

  test('the agent\'s count and the compression model\'s are asked together, so a count-check takes one count\'s limit, not two', async () => {
    const waiting: Array<() => void> = [];
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => new Promise<Response>((answer) => {
        waiting.push(() => answer(Response.json({ input_tokens: 3 })));
        if (waiting.length === 2) for (const each of waiting) each();
      }),
    });
    try {
      setEnv({ COUNT_TOKENS_MODEL: undefined, ANTHROPIC_API_KEY: 'sk-count-test', ANTHROPIC_AUTH_TOKEN: undefined, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}` });
      const check = await buildCountCheck(appWith('claude-agent-test', { type: 'autobiographical', compressionModel: 'claude-compress-test' }), 10_000);
      expect(check.agent.source).toBe('count_tokens');
      expect(check.compression?.source).toBe('count_tokens');
    } finally {
      server.stop(true);
    }
  });

  const TOOL = { name: 'listSessions', description: 'List all active sessions', inputSchema: { type: 'object', properties: {} } };
  const previewing = (formatter?: string): PanelAppRef => {
    const app = appWith('claude-agent-test', { type: 'autobiographical', compressionModel: 'claude-compress-test' });
    if (formatter) (app.recipe.agent as { formatter?: string }).formatter = formatter;
    Object.assign(app.framework, {
      previewActivation: async () => ({
        system: '', tools: [TOOL],
        messages: [{ participant: 'Ann', content: [{ type: 'text', text: 'a line of the conversation' }] }],
      }),
      getAgentRuntimeSettings: () => ({ contextBudgetTokens: 123_456 }),
    });
    return app;
  };

  test('what the host sends beside the conversation is counted with its tools wherever the formatter puts them, the conversation left out, less the one message, beside the budget the agent is set to', async () => {
    const bodies: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const body = await req.text();
        bodies.push(body);
        return Response.json({ input_tokens: 10 + (body.includes('listSessions') ? 500 : 0) });
      },
    });
    try {
      setEnv({ COUNT_TOKENS_MODEL: undefined, ANTHROPIC_API_KEY: 'sk-count-test', ANTHROPIC_AUTH_TOKEN: undefined, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}` });
      for (const formatter of [undefined, 'anthropic-xml']) {
        bodies.length = 0;
        const check = await buildCountCheck(previewing(formatter));
        expect([formatter, check.beside, check.budget]).toEqual([formatter, { tokens: 500, source: 'count_tokens' }, 123_456]);
        expect(bodies.filter((body) => body.includes('listSessions'))).toHaveLength(1);
        expect(bodies.some((body) => body.includes('a line of the conversation'))).toBe(false);
      }
    } finally {
      server.stop(true);
    }
  });

  test('a count of what the host sends that fails, or a ping that fails beside one that counts, leaves it uncounted with the failure\'s own source', async () => {
    let statuses = { withTools: 400, ping: 200 };
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const body = await req.text();
        const status = body.includes('listSessions') ? statuses.withTools : body.includes('claude-compress-test') ? 200 : statuses.ping;
        return status === 200 ? Response.json({ input_tokens: 10 }) : Response.json({}, { status });
      },
    });
    try {
      setEnv({ COUNT_TOKENS_MODEL: undefined, ANTHROPIC_API_KEY: 'sk-count-test', ANTHROPIC_AUTH_TOKEN: undefined, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}` });
      const sending = await buildCountCheck(previewing());
      expect([sending.agent.source, sending.beside]).toEqual(['count_tokens', { tokens: null, source: 'count_tokens_failed_400' }]);
      statuses = { withTools: 200, ping: 403 };
      const pinging = await buildCountCheck(previewing());
      expect([pinging.agent.source, pinging.beside]).toEqual(['count_tokens_failed_403', { tokens: null, source: 'count_tokens_failed_403' }]);
    } finally {
      server.stop(true);
    }
  });

  test('with a preview, its count is asked together with the other two, so the counts take one count\'s limit', async () => {
    const waiting: Array<() => void> = [];
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => new Promise<Response>((answer) => {
        waiting.push(() => answer(Response.json({ input_tokens: 3 })));
        if (waiting.length === 3) for (const each of waiting) each();
      }),
    });
    try {
      setEnv({ COUNT_TOKENS_MODEL: undefined, ANTHROPIC_API_KEY: 'sk-count-test', ANTHROPIC_AUTH_TOKEN: undefined, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}` });
      const check = await buildCountCheck(previewing(), 10_000);
      expect([check.agent.source, check.compression?.source, check.beside.source]).toEqual(['count_tokens', 'count_tokens', 'count_tokens']);
    } finally {
      server.stop(true);
    }
  });
});

describe('shell-check, for an agent whose allowedTools leave a shell\'s listSessions out', () => {
  let dir: string;
  let child: ChildProcess;
  let sock: Socket;
  let events: Array<Record<string, unknown>>;
  let api: ReturnType<typeof Bun.serve>;

  beforeAll(async () => {
    api = Bun.serve({ port: 0, fetch: () => Response.json({ type: 'error', error: { type: 'not_found_error', message: 'model' } }, { status: 404 }) });
    dir = mkdtempSync(join(tmpdir(), 'chost-doctor-fenced-'));
    const serverPath = join(dir, 'fake-shell.mjs');
    writeFileSync(serverPath, FAKE_SHELL);
    writeFileSync(join(dir, 'recipe.json'), JSON.stringify({
      name: 'Fenced Shell',
      agent: { name: 'resident', model: 'claude-live-test', systemPrompt: 'never asked to infer in this test', allowedTools: ['time--now'] },
      modules: { subagents: false, lessons: false, retrieval: false, wake: false, workspace: false },
      mcpServers: { fenced: { command: process.execPath, args: [serverPath, 'ok', join(dir, 'calls.jsonl')] } },
    }));
    const env: Record<string, string | undefined> = {
      ...process.env, ANTHROPIC_API_KEY: 'sk-test-doctor', ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.port}`, DATA_DIR: dir,
    };
    delete env.MODEL;
    child = spawn(process.execPath, [INDEX_PATH, join(dir, 'recipe.json'), '--headless'], { cwd: dir, env, stdio: 'ignore' });
    const socketPath = join(dir, 'ipc.sock');
    await waitFor(() => existsSync(socketPath), 20_000, 'socket file appears');
    sock = await connectWhenAccepting(socketPath);
    events = lineReader(sock);
    await waitFor(() => events.some((e) => e.type === 'lifecycle' && e.phase === 'ready'), 5_000, 'lifecycle ready');
  }, 30_000);

  afterAll(async () => {
    const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve()
      : new Promise<void>((done) => child.once('exit', () => done()));
    try { sock.write(JSON.stringify({ type: 'shutdown' }) + '\n'); } catch {}
    const killer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    await exited;
    clearTimeout(killer);
    try { sock.destroy(); } catch {}
    api.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test('it calls nothing on that server and names it apart, neither as a shell that answered or failed nor as one not connected', async () => {
    let seq = 0;
    const panel = async (op: string): Promise<Record<string, unknown>> => {
      const corrId = `fenced-${++seq}`;
      sock.write(JSON.stringify({ type: 'panel-request', op, params: {}, corrId }) + '\n');
      await waitFor(() => events.some((e) => e.type === 'panel-response' && e.corrId === corrId), 20_000, `panel-response ${op}`);
      return events.find((e) => e.type === 'panel-response' && e.corrId === corrId)!;
    };
    const connected = async () => ((await panel('mcpl')).data as { live: Array<{ id: string; connected: boolean }> }).live
      .find((s) => s.id === 'fenced')?.connected === true;
    for (let i = 0; i < 100 && !(await connected()); i++) await new Promise((r) => setTimeout(r, 100));
    expect(await connected()).toBe(true);
    const res = await panel('shell-check');
    expect(res.ok).toBe(true);
    const data = res.data as { shells: unknown[]; notAllowed?: string[]; notConnected: unknown[]; unchecked: unknown[] };
    expect({ shells: data.shells, notAllowed: data.notAllowed, notConnected: data.notConnected, unchecked: data.unchecked })
      .toEqual({ shells: [], notAllowed: ['fenced'], notConnected: [], unchecked: [] });
    expect(existsSync(join(dir, 'calls.jsonl'))).toBe(false);
  }, 30_000);
});

describe('shell-check, with a stand-in for the framework', () => {
  test('a server not connected is named with whether the host still retries it and why it refuses one', async () => {
    const app = {
      recipe: { name: 'r', agent: { name: 'resident', systemPrompt: '' } },
      framework: {
        getAgent: () => ({ model: 'claude-x' }),
        getAllAgents: () => [{ name: 'resident' }],
        listMcplServers: () => [
          { id: 'retried', connected: false, retrying: true, refused: null, toolClasses: [] },
          { id: 'refused', connected: false, retrying: false, refused: 'its command is empty', toolClasses: [] },
          { id: 'up', connected: true, retrying: false, refused: null, toolClasses: [] },
        ],
      },
    } as unknown as PanelAppRef;
    expect((await buildShellCheck(app)).notConnected).toEqual([
      { id: 'retried', retrying: true, refused: null },
      { id: 'refused', retrying: false, refused: 'its command is empty' },
    ]);
  });

  test('a closed tab is named apart, and one whose configuration the host refuses is still a server not connected', async () => {
    const app = {
      recipe: { name: 'r', agent: { name: 'resident', systemPrompt: '' } },
      framework: {
        getAgent: () => ({ model: 'claude-x' }),
        getAllAgents: () => [{ name: 'resident' }],
        listMcplServers: () => [
          { id: 'tab', connected: false, closedTab: true, retrying: false, refused: null, toolClasses: [] },
          { id: 'badtab', connected: false, closedTab: true, retrying: false, refused: 'its url is empty', toolClasses: [] },
          { id: 'up', connected: true, closedTab: false, retrying: false, refused: null, toolClasses: [] },
        ],
      },
    } as unknown as PanelAppRef;
    const check = await buildShellCheck(app);
    expect({ closedTabs: check.closedTabs, notConnected: check.notConnected }).toEqual({
      closedTabs: ['tab'],
      notConnected: [{ id: 'badtab', retrying: false, refused: 'its url is empty' }],
    });
  });
});

describe('compressionModelOf', () => {
  const base = { name: 'r', agent: { name: 'a', systemPrompt: '' } } as Recipe;
  const withStrategy = (strategy: Record<string, unknown>): Recipe =>
    ({ ...base, agent: { ...base.agent, strategy } }) as unknown as Recipe;

  test('a recipe that names no strategy compresses with the agent\'s model', () => {
    expect(compressionModelOf(base, 'claude-x')).toBe('claude-x');
  });
  test('autobiographical and frontdesk compress with compressionModel when it is set', () => {
    expect(compressionModelOf(withStrategy({ type: 'autobiographical', compressionModel: 'claude-c' }), 'claude-x')).toBe('claude-c');
    expect(compressionModelOf(withStrategy({ type: 'frontdesk', compressionModel: 'claude-c' }), 'claude-x')).toBe('claude-c');
  });
  test('passthrough and an extension\'s strategy have no compression model the host chooses', () => {
    expect(compressionModelOf(withStrategy({ type: 'passthrough', compressionModel: 'claude-c' }), 'claude-x')).toBeNull();
    expect(compressionModelOf(withStrategy({ type: 'my-ext', compressionModel: 'claude-c' }), 'claude-x')).toBeNull();
  });
});

describe('count-check, in the round on the review of 4a79597ff', () => {
  const appWith = (): PanelAppRef => ({
    recipe: { name: 'r', agent: { name: 'resident', systemPrompt: '', strategy: { type: 'autobiographical', compressionModel: 'claude-compress-test' } } } as unknown as Recipe,
    framework: {
      getAgent: () => ({ model: 'claude-agent-test' }),
      getAllAgents: () => [{ name: 'resident' }],
      previewActivation: async () => ({ system: '', tools: [], messages: [{ participant: 'Ann', content: [{ type: 'text', text: 'hi' }] }] }),
      getAgentRuntimeSettings: () => ({ contextBudgetTokens: 123_456 }),
    } as unknown as PanelAppRef['framework'],
  });
  const saved: Record<string, string | undefined> = {};
  const setEnv = (values: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(values)) {
      if (!(k in saved)) saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  afterAll(() => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });

  test('a count answered 200 with no input_tokens is no count: each source says it failed, and nothing reads as counted', async () => {
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) { await req.text(); return Response.json({}); } });
    try {
      setEnv({ COUNT_TOKENS_MODEL: undefined, ANTHROPIC_API_KEY: 'sk-count-test', ANTHROPIC_AUTH_TOKEN: undefined, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}` });
      const check = await buildCountCheck(appWith(), 2_000);
      expect([check.agent.source, check.compression?.source, check.beside]).toEqual(
        ['count_tokens_error', 'count_tokens_error', { tokens: null, source: 'count_tokens_error' }]);
    } finally {
      server.stop(true);
    }
  });

  test('a session switched while the counts were asked is said as that, not counted against the new session', async () => {
    const app = appWith();
    const next = { ...app.framework } as PanelAppRef['framework'];
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        await req.text();
        app.framework = next;
        return Response.json({ input_tokens: 10 });
      },
    });
    try {
      setEnv({ COUNT_TOKENS_MODEL: undefined, ANTHROPIC_API_KEY: 'sk-count-test', ANTHROPIC_AUTH_TOKEN: undefined, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}` });
      const check = await buildCountCheck(app, 2_000);
      expect(check.beside).toEqual({ tokens: null, source: 'session_switched' });
    } finally {
      server.stop(true);
    }
  });
});

describe('count-check and shell-check, in the round on the review of e9bb852cc', () => {
  const server = (id: string) => ({
    id, connected: true, closedTab: false, refused: null, retrying: false,
    toolClasses: [{ serverTool: 'listSessions', tool: `${id}--listSessions` }],
  });
  const frameworkFor = (calls: string[], label: string, then?: () => void) => ({
    getAgent: () => ({ model: 'claude-agent-test' }),
    getAllAgents: () => [{ name: 'resident' }],
    previewActivation: async () => ({ system: '', tools: [], messages: [{ participant: 'Ann', content: [{ type: 'text', text: 'hi' }] }] }),
    getAgentRuntimeSettings: () => ({ contextBudgetTokens: 123_456 }),
    listMcplServers: () => [server('one'), server('two')],
    executeToolCall: async (call: { name: string }) => {
      calls.push(`${label}:${call.name}`);
      then?.();
      return { success: true, data: 'no sessions' };
    },
  }) as unknown as PanelAppRef['framework'];
  const appFor = (framework: PanelAppRef['framework']): PanelAppRef & { switching?: boolean } => ({
    recipe: { name: 'r', agent: { name: 'resident', systemPrompt: '', strategy: { type: 'passthrough' } } } as unknown as Recipe,
    framework,
  });

  test('a count that comes in while the host is switching sessions is said as that, not counted for the session it\'s leaving', async () => {
    const app = appFor(frameworkFor([], 'first'));
    const saved = { key: process.env.ANTHROPIC_API_KEY, base: process.env.ANTHROPIC_BASE_URL, model: process.env.COUNT_TOKENS_MODEL, token: process.env.ANTHROPIC_AUTH_TOKEN };
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        await req.text();
        app.switching = true;
        return Response.json({ input_tokens: 10 });
      },
    });
    try {
      process.env.ANTHROPIC_API_KEY = 'sk-count-test';
      process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.port}`;
      delete process.env.COUNT_TOKENS_MODEL;
      delete process.env.ANTHROPIC_AUTH_TOKEN;
      const check = await buildCountCheck(app, 2_000);
      expect(check.beside).toEqual({ tokens: null, source: 'session_switched' });
    } finally {
      server.stop(true);
      for (const [name, value] of [['ANTHROPIC_API_KEY', saved.key], ['ANTHROPIC_BASE_URL', saved.base],
        ['COUNT_TOKENS_MODEL', saved.model], ['ANTHROPIC_AUTH_TOKEN', saved.token]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test('a count that starts while a session switch is under way is said as switched, though the switch ends before the counts answer', async () => {
    const app = appFor(frameworkFor([], 'first'));
    app.switching = true;
    const saved = { key: process.env.ANTHROPIC_API_KEY, base: process.env.ANTHROPIC_BASE_URL, model: process.env.COUNT_TOKENS_MODEL, token: process.env.ANTHROPIC_AUTH_TOKEN };
    let asked = 0;
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        await req.text();
        asked += 1;
        app.switching = false;
        return Response.json({ input_tokens: 10 });
      },
    });
    try {
      process.env.ANTHROPIC_API_KEY = 'sk-count-test';
      process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.port}`;
      delete process.env.COUNT_TOKENS_MODEL;
      delete process.env.ANTHROPIC_AUTH_TOKEN;
      const check = await buildCountCheck(app, 2_000);
      expect(asked).toBe(2);
      expect(check.beside).toEqual({ tokens: null, source: 'session_switched' });
    } finally {
      server.stop(true);
      for (const [name, value] of [['ANTHROPIC_API_KEY', saved.key], ['ANTHROPIC_BASE_URL', saved.base],
        ['COUNT_TOKENS_MODEL', saved.model], ['ANTHROPIC_AUTH_TOKEN', saved.token]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test('shell-check makes no call once the session has switched, keeps the answer it had, and names each server after the switch as unchecked', async () => {
    const calls: string[] = [];
    const next = frameworkFor(calls, 'next');
    const app = appFor(frameworkFor(calls, 'first', () => { app.framework = next; }));
    const check = await buildShellCheck(app);
    expect(calls).toEqual(['first:one--listSessions']);
    expect({ shells: check.shells.map((row) => row.server), unchecked: check.unchecked }).toEqual({ shells: ['one'], unchecked: ['two'] });
  });

  test('shell-check makes no call while a session switch is under way, and names every server as unchecked', async () => {
    const calls: string[] = [];
    const app = appFor(frameworkFor(calls, 'first'));
    app.switching = true;
    const check = await buildShellCheck(app);
    expect(calls).toEqual([]);
    expect({ shells: check.shells, unchecked: check.unchecked }).toEqual({ shells: [], unchecked: ['one', 'two'] });
  });

  test('a call that fails as the host switches sessions names its server as unchecked, not as a server whose call failed', async () => {
    const calls: string[] = [];
    const app = appFor(frameworkFor(calls, 'first'));
    (app.framework as unknown as { executeToolCall: (call: { name: string }) => Promise<unknown> }).executeToolCall = async (call) => {
      calls.push(`first:${call.name}`);
      app.switching = true;
      return { success: false, error: 'Connection closed' };
    };
    const check = await buildShellCheck(app);
    expect(calls).toEqual(['first:one--listSessions']);
    expect({ shells: check.shells, unchecked: check.unchecked }).toEqual({ shells: [], unchecked: ['one', 'two'] });
  });
});
