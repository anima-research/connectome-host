/**
 * Batch mode (stdin not a TTY, no --headless): the host echoes and runs each
 * stdin line, then stops the framework, closing every MCPL server. These
 * tests pin that the echo hides what an /auth line's credential may be, that
 * the teardown is announced, on the console and in each server's
 * mcpl-stderr log, and that the process exits once the run is done.
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync, statSync } from 'node:fs';
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

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_PATH = join(REPO_ROOT, 'src', 'index.ts');

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

  test("the echo hides an /auth line's words after its subcommand, and shows every other line as it came", () => {
    expect(batchEchoLine('/auth token sk-ant-oat01-secret')).toBe('/auth token <hidden>');
    expect(batchEchoLine('  /auth TOKEN  two words  ')).toBe('/auth TOKEN <hidden>');
    expect(batchEchoLine('/AUTH token sk-ant-oat01-secret')).toBe('/AUTH token <hidden>');
    // Split on any whitespace, as handleCommand splits it, which runs a line
    // with spaces after its slash as the command they precede.
    expect(batchEchoLine('/auth\ttoken\tsk-ant-oat01-secret')).toBe('/auth token <hidden>');
    expect(batchEchoLine('/ auth token sk-ant-oat01-secret')).toBe('/auth token <hidden>');
    // Words after another subcommand /auth knows run nothing, but are hidden too.
    expect(batchEchoLine('/auth recheck now')).toBe('/auth recheck <hidden>');
    // A word /auth doesn't know may itself be the credential, so it's hidden
    // with what follows it.
    expect(batchEchoLine('/auth set-token sk-ant-oat01-secret')).toBe('/auth <hidden>');
    expect(batchEchoLine('/auth sk-ant-oat01-secret')).toBe('/auth <hidden>');
    expect(batchEchoLine('/AUTH set-token sk-ant-oat01-secret')).toBe('/AUTH <hidden>');
    // A command whose name starts with auth runs nothing unless it's /auth,
    // so a dropped space or a stray character still hides what follows.
    expect(batchEchoLine('/authtoken sk-ant-oat01-secret')).toBe('/authtoken <hidden>');
    expect(batchEchoLine('/auth-token sk-ant-oat01-secret')).toBe('/auth-token <hidden>');
    expect(batchEchoLine('/authx token abc')).toBe('/authx token <hidden>');
    // Each subcommand /auth knows keeps its name.
    expect(batchEchoLine('/auth login now')).toBe('/auth login <hidden>');
    expect(batchEchoLine('/auth refresh now')).toBe('/auth refresh <hidden>');
    expect(batchEchoLine('/auth status now')).toBe('/auth status <hidden>');
    // An /auth line with nothing to hide, a message (even one that reads as
    // the command once its first character goes, or that has spaces around
    // it) and other commands come as they are.
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

// A stdio server that answers just enough of the handshake to connect.
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

function setup(webui: boolean): { dir: string; recipePath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'chost-batch-'));
  tmpDirs.push(dir);
  const serverPath = join(dir, 'fake-mcpl.mjs');
  writeFileSync(serverPath, FAKE_SERVER);
  const recipe = {
    name: 'Batch Test',
    agent: { name: 'agent', provider: 'mock', systemPrompt: 'batch test' },
    modules: {
      subagents: false, lessons: false, retrieval: false, wake: false, workspace: false,
      ...(webui ? { webui: { host: '127.0.0.1', port: 0 } } : {}),
    },
    mcpServers: { fake: { command: process.execPath, args: [serverPath] } },
  };
  const recipePath = join(dir, 'recipe.json');
  writeFileSync(recipePath, JSON.stringify(recipe));
  return { dir, recipePath };
}

function startBatch(dir: string, recipePath: string, input: string) {
  const child = spawn(process.execPath, [INDEX_PATH, recipePath], {
    // cwd=dir keeps the developer's own mcpl-servers.json out of the run.
    cwd: dir,
    env: { ...process.env, DATA_DIR: join(dir, 'data') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout!.on('data', (c: Buffer) => { stdout += c.toString('utf-8'); });
  child.stderr!.on('data', () => { /* drain */ });
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
    // The inference wait's 120 s safety timer used to outlive the reply and
    // hold the process open for two minutes after `Done.`.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      run.exited,
      new Promise<'still running'>((r) => { timer = setTimeout(() => r('still running'), 30_000); }),
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

    // The server's own log states the cause ahead of the close it explains.
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
      new Promise<'still running'>((r) => { timer = setTimeout(() => r('still running'), 30_000); }),
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
      // Boot and the first line take what they take. Then the second line's
      // turn is an echo, so its wait ends far inside the 120 s cap, unless it
      // waits for the cap itself.
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
    // The mock answers each line with `[Echo] …`, so the new session's turn
    // printed its answer after `> second line`, and before `Done.`.
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
      // What the notice promises: the server answers, the agent data doesn't.
      expect((await fetch(`${url}/healthz`)).status).toBe(503);
    } finally {
      run.child.kill('SIGKILL');
      await run.exited;
    }
  }, 60_000);
});
