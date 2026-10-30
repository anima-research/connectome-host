import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_PATH = join(ROOT, 'src', 'index.ts');
const RUNNING = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as { version: string }).version;
const ALERT_LINE = '⚠ [agent] probe-alert: the person should see this';
const REPLY_WITH_ALERTS = [
  'Hell',
  ALERT_LINE,
  'o th',
  '⚠ [agent] probe-alert (×2): the person should see this',
  'ere,',
  '✓ [agent] probe-alert-clear: cleared',
  ' person.',
];

const EXTENSION = `
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
let made = 0;
export function register(api, config) {
  api.registerModule(() => { const generation = ++made; return {
    name: 'stderr-probe',
    getTools() { return []; },
    async start() {
      if (config.marks) writeFileSync(join(config.marks, 'started-' + generation), '');
    },
    async stop() {
      if (!config.marks) return;
      writeFileSync(join(config.marks, 'stopping-' + generation), '');
      while (generation === 1 && !existsSync(join(config.marks, 'stop-go'))) await new Promise((r) => setTimeout(r, 10));
    },
    async handleToolCall() { return { success: false, error: 'no tools' }; },
    async onProcess() { return {}; },
    setFramework(framework) {
      let turns = 0;
      let tokens = 0;
      if (config.background) {
        // agent-framework listens for SIGUSR2 too, and dumps a [diagnostics]
        // line for each running framework through console.error.
        process.on('SIGUSR2', () => framework.pushEvent({
          type: 'external-message', source: 'cli', content: 'again', metadata: {}, triggerInference: true,
        }));
      }
      framework.onTrace((event) => {
        if (event.type === 'inference:started') {
          turns++;
          tokens = 0;
          return;
        }
        if (event.type !== 'inference:tokens' || turns !== (config.background ? 2 : 1)) return;
        tokens++;
        if (tokens === 2) {
          if (config.crash) setTimeout(() => { throw new Error('probe crash mid-reply'); }, 0);
          console.error('[probe-console] a library line mid-reply');
          console.warn('[probe-warn] a library warning mid-reply');
          process.stderr.write('[probe-direct] a library write mid-reply\\n');
          framework.notifyOpsAlert('probe-alert', event.agentName, 'the person should see this');
        } else if (tokens === 3) {
          framework.notifyOpsAlert('probe-alert', event.agentName, 'the person should see this');
        } else if (tokens === 4) {
          framework.notifyOpsAlert('probe-alert-clear', event.agentName, 'cleared');
        }
      });
    },
  }; });
}
`;

function rendered(raw: string): string[] {
  const rows = [''];
  let row = 0;
  let col = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch === '\x1b') {
      const csi = /^\x1b\[([0-9;?]*)[ -/]*([@-~])/.exec(raw.slice(i, i + 32));
      if (csi === null) continue;
      i += csi[0].length - 1;
      const n = Number(csi[1] || '0');
      if (csi[2] === 'G') col = Math.max(0, n - 1);
      else if (csi[2] === 'K' && n === 0) rows[row] = rows[row]!.slice(0, col);
      else if (csi[2] === 'J' && n === 0) { rows[row] = rows[row]!.slice(0, col); rows.length = row + 1; }
    } else if (ch === '\r') {
      col = 0;
    } else if (ch === '\n') {
      row++;
      col = 0;
      if (rows.length <= row) rows.push('');
    } else {
      const line = rows[row]!.padEnd(col);
      rows[row] = line.slice(0, col) + ch + line.slice(col + 1);
      col++;
    }
  }
  return rows;
}

async function until(ready: () => boolean, ms: number, what: string, screen: () => string): Promise<void> {
  const deadline = performance.now() + ms;
  while (!ready()) {
    if (performance.now() > deadline) throw new Error(`no ${what} within ${ms} ms; the terminal showed: ${rendered(screen()).join('\n').slice(-3000)}`);
    await Bun.sleep(25);
  }
}

interface Session {
  dir: string;
  screen(): string;
  lines(): string[];
  type(text: string): void;
  signal(name: NodeJS.Signals): void;
  exited: Promise<number>;
  close(): Promise<void>;
}

function startReadline(options: {
  crash?: boolean; background?: boolean; env?: Record<string, string>; prepare?: (dir: string) => void; holdFirstStop?: boolean;
} = {}): Session {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'readline-stderr-')));
  options.prepare?.(dir);
  const extension = join(dir, 'probe.ts');
  writeFileSync(extension, EXTENSION);
  const recipe = join(dir, 'recipe.json');
  writeFileSync(recipe, JSON.stringify({
    name: 'Readline stderr test',
    agent: {
      name: 'agent', provider: 'mock', systemPrompt: 'You are a mock agent for offline host testing.',
      mock: { echoMode: false, defaultResponse: 'Hello there, person.', streamChunkSize: 4, streamChunkDelayMs: 40 },
    },
    modules: { subagents: false, lessons: false, retrieval: false, wake: false, workspace: false },
    extensions: { probe: { kind: 'module', path: extension, config: {
      crash: options.crash === true, background: options.background === true, ...(options.holdFirstStop ? { marks: dir } : {}),
    } } },
  }));
  let screen = '';
  const decoder = new TextDecoder();
  const terminal = new Bun.Terminal({
    cols: 160, rows: 50,
    data: (_terminal, data) => { screen += decoder.decode(data, { stream: true }); },
  });
  const host = Bun.spawn([process.execPath, INDEX_PATH, recipe, '--no-tui'], {
    cwd: dir, env: { ...process.env, DATA_DIR: dir, TERM: 'xterm-256color', ...options.env }, terminal,
  });
  return {
    dir,
    screen: () => screen,
    lines: () => rendered(screen),
    type: (text) => { terminal.write(text); },
    signal: (name) => { host.kill(name); },
    exited: host.exited,
    async close() {
      if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL');
      await host.exited;
      if (!terminal.closed) terminal.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function holdsInOrder(rows: string[], wanted: string[]): boolean {
  return rows.some((_row, at) => wanted.every((line, i) => rows[at + i] === line));
}

async function prompted(session: Session): Promise<void> {
  await until(() => session.lines().some((line) => line.includes('Type /help')), 30_000, 'readline prompt', session.screen);
}

async function converse(session: Session): Promise<void> {
  await prompted(session);
  session.type('hello\r');
  await until(() => {
    const lines = session.lines();
    return lines.some((line) => line.includes('person.')) && lines.at(-1) === '> ';
  }, 30_000, 'the reply and the prompt after it', session.screen);
}

test('in readline mode, what libraries write to stderr goes to readline-error.log, and alerts mid-reply each have a line of their own', async () => {
  const session = startReadline();
  try {
    await converse(session);
    session.type('/quit\r');
    expect(await session.exited).toBe(0);
    const shown = session.lines().join('\n');
    expect(shown).not.toContain('[probe-console]');
    expect(shown).not.toContain('[probe-warn]');
    expect(shown).not.toContain('[probe-direct]');
    expect(holdsInOrder(session.lines(), REPLY_WITH_ALERTS)).toBe(true);
    expect(session.lines()).toContain(`Error log: ${join(session.dir, 'readline-error.log')}`);
    expect(statSync(join(session.dir, 'readline-error.log')).mode & 0o777).toBe(0o600);
    const log = readFileSync(join(session.dir, 'readline-error.log'), 'utf-8');
    expect(log).toMatch(/--- session \S+ ---\n/);
    expect(log).toContain('[probe-console] a library line mid-reply\n');
    expect(log).toContain('[probe-warn] a library warning mid-reply\n');
    expect(log).toContain('[probe-direct] a library write mid-reply\n');
  } finally {
    await session.close();
  }
}, 120_000);

test('in readline mode, a notice of a newer release that comes while the prompt waits is shown, each line whole, and what was typed is kept', async () => {
  let promptShown: () => void = () => {};
  const shown = new Promise<void>((done) => { promptShown = done; });
  const registry = Bun.serve({
    port: 0,
    fetch: async () => {
      await shown;
      return Response.json({ versions: { [RUNNING]: {}, '99.0.0': { connectomeRelease: { breaking: true, cacheWrite: false } } } });
    },
  });
  const session = startReadline({ env: { CONNECTOME_UPDATE_CHECK: '1', npm_config_registry: `http://127.0.0.1:${registry.port}` } });
  try {
    await prompted(session);
    session.type('ab');
    await until(() => session.lines().at(-1) === '> ab', 10_000, 'the typed text', session.screen);
    promptShown();
    await until(() => session.lines().some((line) => line.startsWith('[update] Notes:')), 20_000, 'the notice', session.screen);
    expect(session.lines()).toContain(`[update] connectome-host 99.0.0 is out; this host runs ${RUNNING}.`);
    expect(session.lines()).toContain('[update] Breaking: 99.0.0. Read its notes before updating.');
    await until(() => session.lines().at(-1) === '> ab', 10_000, 'the prompt drawn again with what was typed', session.screen);
    expect(session.lines().filter((line) => line === '> ab')).toHaveLength(1);
    session.type('\x15/quit\r');
    expect(await session.exited).toBe(0);
  } finally {
    await session.close();
    await registry.stop(true);
  }
}, 120_000);

test('in readline mode, a crash mid-reply is shown on the terminal, and the log keeps what was written before it', async () => {
  const session = startReadline({ crash: true });
  try {
    await prompted(session);
    session.type('hello\r');
    await until(() => session.lines().join('\n').includes('probe crash mid-reply'), 30_000, 'the crash', session.screen);
    expect(await session.exited).not.toBe(0);
    const log = readFileSync(join(session.dir, 'readline-error.log'), 'utf-8');
    expect(log).toContain('[probe-console] a library line mid-reply\n');
    expect(log).toContain('[probe-direct] a library write mid-reply\n');
  } finally {
    await session.close();
  }
}, 120_000);

test('in readline mode, a reply streaming while the prompt waits keeps its text when an alert comes mid-reply', async () => {
  const session = startReadline({ background: true });
  try {
    await converse(session);
    session.signal('SIGUSR2');
    await until(() => holdsInOrder(session.lines(), REPLY_WITH_ALERTS), 30_000, 'the second reply with its alerts', session.screen);
    session.type('/quit\r');
    expect(await session.exited).toBe(0);
    expect(session.lines().join('\n')).not.toContain('[diagnostics]');
    expect(readFileSync(join(session.dir, 'readline-error.log'), 'utf-8')).toContain('[diagnostics] ');
  } finally {
    await session.close();
  }
}, 120_000);

const UNWRITABLE: Array<{ how: string; prepare: (dir: string) => void; on?: NodeJS.Platform }> = [
  { how: 'can\'t be opened', prepare: (dir) => { mkdirSync(join(dir, 'readline-error.log')); } },
  { how: 'opens but takes no write', prepare: (dir) => { symlinkSync('/dev/full', join(dir, 'readline-error.log')); }, on: 'linux' },
];

for (const { how, prepare, on } of UNWRITABLE) {
  test.skipIf(on !== undefined && process.platform !== on)(`in readline mode, when readline-error.log ${how}, the session goes on and says so, and library lines show as before`, async () => {
    const session = startReadline({ prepare });
    try {
      await converse(session);
      expect(session.lines().some((line) => line.startsWith(`[host] ${join(session.dir, 'readline-error.log')} can't be written (`))).toBe(true);
      expect(session.lines().some((line) => line.startsWith('Error log:'))).toBe(false);
      expect(session.lines().some((line) => line.startsWith('--- session'))).toBe(false);
      const shown = session.lines().join('\n');
      expect(shown).toContain('[probe-console] a library line mid-reply');
      expect(shown).toContain('[probe-warn] a library warning mid-reply');
      expect(shown).toContain('[probe-direct] a library write mid-reply');
      expect(session.lines()).toContain(ALERT_LINE);
      session.type('/quit\r');
      expect(await session.exited).toBe(0);
    } finally {
      await session.close();
    }
  }, 120_000);
}

test('in readline mode, input that ends while a session switch is under way starts no framework once the host has begun to stop, and says the switch didn\'t finish', async () => {
  const session = startReadline({ holdFirstStop: true });
  let ended = false;
  void session.exited.then(() => { ended = true; });
  try {
    await prompted(session);
    session.type('/session new later\r');
    await until(() => existsSync(join(session.dir, 'stopping-1')), 30_000, 'the switch\'s stop of the first framework', session.screen);
    session.type('\x04');
    await until(() => session.lines().some((line) => line.includes('Shutting down...')), 30_000, 'the shutdown', session.screen);
    writeFileSync(join(session.dir, 'stop-go'), '');
    await until(() => ended || existsSync(join(session.dir, 'started-2')), 30_000, 'the host\'s exit or a second framework', session.screen);
    expect(existsSync(join(session.dir, 'started-2'))).toBe(false);
    expect(await session.exited).toBe(0);
    expect(session.lines().some((line) => line.includes('the switch didn\'t finish; the next start opens session later ['))).toBe(true);
  } finally {
    await session.close();
  }
}, 120_000);
