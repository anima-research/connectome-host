import { describe, test, expect, afterAll } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webUiHttpUrl } from '../src/modules/web-ui-module.js';
import {
  batchModeStartNotice,
  batchTeardownNotice,
  batchWebUiNotice,
  batchEchoLine,
  BATCH_MCPL_LOG_NOTE,
} from '../src/batch-mode.js';
import { PIPED_TURN_CAP_MS } from '../src/piped-turns.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_PATH = join(REPO_ROOT, 'src', 'index.ts');
const EXIT_WELL_INSIDE_TURN_CAP_MS = PIPED_TURN_CAP_MS / 4;

describe('batch-mode notices', () => {
  test('the start notice says the run ends at EOF and names --headless', () => {
    const line = batchModeStartNotice();
    expect(line).toContain('stdin is not a TTY');
    expect(line).toContain('MCPL servers stop');
    expect(line).toContain('--headless');
  });

  test('the teardown notice counts and names the servers it closes', () => {
    expect(batchTeardownNotice(['discord', 'eidoverse'])).toBe(
      '[batch] closing 2 MCPL servers (discord, eidoverse): batch run complete — use --headless to keep serving',
    );
    expect(batchTeardownNotice(['fake'])).toContain('closing 1 MCPL server (fake):');
    expect(batchTeardownNotice([])).toBe(
      '[batch] stopping the agent: batch run complete — use --headless to keep serving',
    );
  });

  test('the webui URL brackets an IPv6 bind', () => {
    expect(webUiHttpUrl('::1', 7340)).toBe('http://[::1]:7340');
    expect(webUiHttpUrl('[::1]', 7340)).toBe('http://[::1]:7340');
    expect(webUiHttpUrl('127.0.0.1', 7340)).toBe('http://127.0.0.1:7340');
    expect(webUiHttpUrl('localhost', 0)).toBe('http://localhost:0');
  });

  test("the echo hides an /auth line's words after a subcommand it knows, or from the first word it doesn't, and shows every other line as it came", () => {
    expect(batchEchoLine('/auth token sk-ant-oat01-secret')).toBe('/auth token <hidden>');
    expect(batchEchoLine('  /auth TOKEN  two words  ')).toBe('/auth TOKEN <hidden>');
    expect(batchEchoLine('/AUTH token sk-ant-oat01-secret')).toBe('/AUTH token <hidden>');
    expect(batchEchoLine('/auth\ttoken\tsk-ant-oat01-secret')).toBe('/auth token <hidden>');
    expect(batchEchoLine('/ auth token sk-ant-oat01-secret')).toBe('/auth token <hidden>');
    expect(batchEchoLine('/auth recheck now')).toBe('/auth recheck <hidden>');
    expect(batchEchoLine('/auth set-token sk-ant-oat01-secret')).toBe('/auth <hidden>');
    expect(batchEchoLine('/auth sk-ant-oat01-secret')).toBe('/auth <hidden>');
    expect(batchEchoLine('/AUTH set-token sk-ant-oat01-secret')).toBe('/AUTH <hidden>');
    expect(batchEchoLine('/authtoken sk-ant-oat01-secret')).toBe('/authtoken <hidden>');
    expect(batchEchoLine('/auth-token sk-ant-oat01-secret')).toBe('/auth-token <hidden>');
    expect(batchEchoLine('/authx token abc')).toBe('/authx token <hidden>');
    expect(batchEchoLine('/auth login now')).toBe('/auth login <hidden>');
    expect(batchEchoLine('/auth refresh now')).toBe('/auth refresh <hidden>');
    expect(batchEchoLine('/auth status now')).toBe('/auth status <hidden>');
    for (const line of ['/auth', '/auth token', '/auth token   ', '/auth status', '/auth login', '/auth refresh', '/AUTH Recheck', '/authtoken', 'a message about /auth token abc', '  a message  ', 'xauth token abc', '/help']) {
      expect(batchEchoLine(line)).toBe(line);
    }
  });

  test('the webui notice gives the URL and how to exit', () => {
    const line = batchWebUiNotice('http://127.0.0.1:7340');
    expect(line).toContain('http://127.0.0.1:7340');
    expect(line).toContain('agent stopped');
    expect(line).toContain('Ctrl-C');
  });
});

const FAKE_SERVER = `
import { createInterface } from 'node:readline';
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined || msg.method === undefined) return;
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'fake', version: '0.0.0' },
    } });
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } });
  } else {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  }
});
`;

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

const HOLD_FIRST_STOP = `
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
let made = 0;
export function register(api, config) {
  api.registerModule(() => { const generation = ++made; return {
    name: 'stop-hold',
    getTools() { return []; },
    async start() { writeFileSync(join(config.marks, 'started-' + generation), ''); },
    async stop() {
      writeFileSync(join(config.marks, 'stopping-' + generation), '');
      while (generation === 1 && !existsSync(join(config.marks, 'stop-go'))) await new Promise((r) => setTimeout(r, 10));
    },
    async handleToolCall() { return { success: false, error: 'no tools' }; },
    async onProcess() { return {}; },
  }; });
}
`;

function setup(webui: boolean, holdFirstStop = false): { dir: string; recipePath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'chost-batch-'));
  tmpDirs.push(dir);
  const serverPath = join(dir, 'fake-mcpl.mjs');
  writeFileSync(serverPath, FAKE_SERVER);
  if (holdFirstStop) writeFileSync(join(dir, 'stop-hold.ts'), HOLD_FIRST_STOP);
  const recipe = {
    name: 'Batch Test',
    agent: { name: 'agent', provider: 'mock', systemPrompt: 'batch test' },
    modules: {
      subagents: false, lessons: false, retrieval: false, wake: false, workspace: false,
      ...(webui ? { webui: { host: '127.0.0.1', port: 0 } } : {}),
    },
    mcpServers: { fake: { command: process.execPath, args: [serverPath] } },
    ...(holdFirstStop ? { extensions: { hold: { kind: 'module', path: join(dir, 'stop-hold.ts'), config: { marks: dir } } } } : {}),
  };
  const recipePath = join(dir, 'recipe.json');
  writeFileSync(recipePath, JSON.stringify(recipe));
  return { dir, recipePath };
}

function startBatch(dir: string, recipePath: string, input: string) {
  const child = spawn(process.execPath, [INDEX_PATH, recipePath], {
    cwd: dir,
    env: { ...process.env, DATA_DIR: join(dir, 'data') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout!.on('data', (c: Buffer) => { stdout += c.toString('utf-8'); });
  child.stderr!.on('data', () => { });
  child.stdin!.end(input);
  // 'close', not 'exit': only then have the stdio pipes delivered everything.
  const exited = new Promise<number | null>((r) => child.on('close', (code) => r(code)));
  return { child, exited, out: () => stdout };
}

function findFile(root: string, name: string): string | null {
  for (const entry of readdirSync(root)) {
    const p = join(root, entry);
    if (statSync(p).isDirectory()) {
      const hit = findFile(p, name);
      if (hit) return hit;
    } else if (p.endsWith(name)) {
      return p;
    }
  }
  return null;
}

async function waitFor(check: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out after ${timeoutMs}ms: ${label}`);
}

describe('batch mode end to end', () => {
  test('announces the MCPL teardown and exits once the input is done', async () => {
    const { dir, recipePath } = setup(false);
    const run = startBatch(dir, recipePath, 'hello\n');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      run.exited,
      new Promise<'still running'>((r) => { timer = setTimeout(() => r('still running'), EXIT_WELL_INSIDE_TURN_CAP_MS); }),
    ]).finally(() => clearTimeout(timer));
    if (outcome === 'still running') {
      run.child.kill('SIGKILL');
      await run.exited;
    }
    expect(outcome).toBe(0);

    const out = run.out();
    const start = out.indexOf(batchModeStartNotice());
    const processing = out.indexOf('Processing 1 commands...');
    const done = out.indexOf('Done.');
    const teardown = out.indexOf(batchTeardownNotice(['fake']));
    expect(start).toBeGreaterThanOrEqual(0);
    expect(start).toBeLessThan(processing);
    expect(done).toBeGreaterThan(processing);
    expect(teardown).toBeGreaterThan(done);
    expect(out).not.toContain('webui stays up');

    const log = findFile(join(dir, 'data'), join('mcpl-stderr', 'fake.log'));
    expect(log).not.toBeNull();
    const text = readFileSync(log!, 'utf-8');
    const note = text.indexOf(BATCH_MCPL_LOG_NOTE);
    const closed = text.indexOf('[host] connection closed');
    expect(note).toBeGreaterThanOrEqual(0);
    expect(closed).toBeGreaterThan(note);
  }, 60_000);

  test("a /auth token line is echoed without its credential", async () => {
    const { dir, recipePath } = setup(false);
    const run = startBatch(dir, recipePath, '/auth token sk-ant-oat01-batch-echo-secret\n');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      run.exited,
      new Promise<'still running'>((r) => { timer = setTimeout(() => r('still running'), EXIT_WELL_INSIDE_TURN_CAP_MS); }),
    ]).finally(() => clearTimeout(timer));
    if (outcome === 'still running') {
      run.child.kill('SIGKILL');
      await run.exited;
    }
    expect(outcome).toBe(0);
    const out = run.out();
    expect(out).toContain('> /auth token <hidden>');
    expect(out).not.toContain('batch-echo-secret');
  }, 60_000);

  test('after a session switch, a line waits for the new session\'s turn rather than the cap', async () => {
    const { dir, recipePath } = setup(false);
    const run = startBatch(dir, recipePath, 'first line\n/session new\nsecond line\n');
    let exitCode: number | null | undefined;
    void run.exited.then((code) => { exitCode = code; });
    try {
      await waitFor(() => run.out().includes('> second line'), 120_000, '`> second line`');
      await waitFor(() => run.out().includes('Done.'), 90_000, '`Done.` inside the 120 s cap');
      await waitFor(() => exitCode !== undefined, 30_000, 'the batch run to exit');
    } finally {
      if (exitCode === undefined) {
        run.child.kill('SIGKILL');
        await run.exited;
      }
    }
    expect(exitCode).toBe(0);
    const out = run.out();
    expect(out).toContain('Session switched.');
    const second = out.slice(out.indexOf('> second line'), out.indexOf('Done.'));
    expect(second).toContain('[Echo]');
  }, 260_000);

  test('says the webui stays up with the agent stopped', async () => {
    const { dir, recipePath } = setup(true);
    const run = startBatch(dir, recipePath, '/help\n');
    try {
      await waitFor(() => run.out().includes('webui stays up'), 30_000, 'webui notice');
      const url = /\[webui\] listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(run.out())?.[1];
      expect(url).toBeDefined();
      expect(run.out()).toContain(batchWebUiNotice(url!));
      expect(run.out()).toContain(batchTeardownNotice(['fake']));
      expect((await fetch(`${url}/healthz`)).status).toBe(503);
    } finally {
      run.child.kill('SIGKILL');
      await run.exited;
    }
  }, 60_000);

  test('a session switch the webui asked for, still stopping the old framework when the input ends, starts no framework, and the webui is told the switch didn\'t finish', async () => {
    const { dir, recipePath } = setup(true, true);
    const child = spawn(process.execPath, [INDEX_PATH, recipePath], {
      cwd: dir, env: { ...process.env, DATA_DIR: join(dir, 'data') }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout!.on('data', (c: Buffer) => { stdout += c.toString('utf-8'); });
    child.stderr!.on('data', () => { });
    const exited = new Promise<number | null>((r) => child.on('close', (code) => r(code)));
    try {
      await waitFor(() => /\[webui\] listening on http/.test(stdout), 30_000, 'the webui');
      const url = /\[webui\] listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout)![1]!;
      const ws = new WebSocket(`${url.replace(/^http/, 'ws')}/ws`);
      const messages: Array<Record<string, unknown>> = [];
      ws.onmessage = (event) => { messages.push(JSON.parse(String(event.data))); };
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error('the webui socket failed'));
      });
      await waitFor(() => messages.some((m) => m.type === 'welcome'), 30_000, 'the webui\'s welcome');
      ws.send(JSON.stringify({ type: 'command', command: '/session new later', corrId: 'w1' }));
      await waitFor(() => existsSync(join(dir, 'stopping-1')), 30_000, 'the switch\'s stop of the first framework');
      child.stdin!.end('');
      await waitFor(() => stdout.includes('Done.'), 30_000, 'the batch\'s end');
      writeFileSync(join(dir, 'stop-go'), '');
      const answered = (m: Record<string, unknown>) => m.type === 'error' && m.corrId === 'w1';
      await waitFor(() => messages.some(answered) || existsSync(join(dir, 'started-2')), 30_000, 'the switch\'s answer or a second framework');
      expect(existsSync(join(dir, 'started-2'))).toBe(false);
      expect(String(messages.find(answered)!.message))
        .toStartWith('The host began to stop during the session switch, so the switch didn\'t finish; the next start opens session later [');
      ws.close();
    } finally {
      child.kill('SIGKILL');
      await exited;
    }
  }, 60_000);
});
