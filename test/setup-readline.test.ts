import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnvFile } from '../src/setup/secrets.js';

const INDEX_PATH = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'src', 'index.ts');
const SECRET = 'typed-hidden-0123456789';

// The probe keeps the message setup opens the conversation with, and how many of the agent's inferences the log
// holds in the microtask after each turn's inference:completed, where the host reads a refusal. As the framework hands
// it the opening message, it asks the person for a secret through setup's own tool, and the framework waits for its
// onProcess before the turn, as a turn waits for a tool's result. On the agent's second turn it asks for the
// conversation to end, as setup--finished does.
const EXTENSION = `
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
console.error('[probe-early] a line before readline mode starts');
export function register(api, config) {
  let framework;
  api.registerModule(() => ({
    name: 'setup-probe',
    getTools() { return []; },
    async start() {},
    async stop() {},
    async handleToolCall() { return { success: false, error: 'no tools' }; },
    async onProcess(event) {
      if (event.type === 'external-message' && event.source === 'cli' && event.content === config.hold) {
        writeFileSync(join(config.dir, 'holding.txt'), '');
        while (!existsSync(join(config.dir, 'release.txt'))) await Bun.sleep(25);
      }
      if (event.type !== 'external-message' || event.source !== 'system') return {};
      writeFileSync(join(config.dir, 'opened.txt'), event.content);
      const result = await framework.getModule('setup')
        .handleToolCall({ id: 'probe', name: 'ask_secret', input: { name: 'PROBE_TOKEN', purpose: 'a probe' } });
      writeFileSync(join(config.dir, 'asked.json'), JSON.stringify(result));
      return {};
    },
    setFramework(given) {
      framework = given;
      let turns = 0;
      framework.onTrace((event) => {
        if (event.type === 'inference:completed' && event.agentName === 'setup') {
          queueMicrotask(() => appendFileSync(join(config.dir, 'logged.txt'),
            framework.queryInferenceLogs({ agentName: 'setup', limit: 100 }).entries.length + '\\n'));
        }
        if (event.type !== 'inference:started' || event.agentName !== 'setup') return;
        turns++;
        if (turns === (config.finishAt ?? 2)) framework.getModule('setup').finishRequested = true;
      });
    },
  }));
}
`;

function rendered(raw: string): string[] {
  return raw.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').split('\n').map((line) => line.replace(/^.*\r(?!$)/, '').replace(/\r$/, ''));
}

async function until(ready: () => boolean, what: string, screen: () => string): Promise<void> {
  const deadline = performance.now() + 30_000;
  while (!ready()) {
    if (performance.now() > deadline) throw new Error(`no ${what}; the terminal showed: ${screen().slice(-3000)}`);
    await Bun.sleep(25);
  }
}

test('setup\'s conversation opens with setup\'s message, asks hidden, has its own /help, and ends after the turn that finished', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'setup-readline-')));
  const extension = join(dir, 'probe.ts');
  writeFileSync(extension, EXTENSION);
  const recipe = join(dir, 'recipe.json');
  writeFileSync(recipe, JSON.stringify({
    name: 'Setup readline test',
    agent: { name: 'setup', provider: 'mock', systemPrompt: 'A mock setup agent.', mock: { echoMode: true } },
    modules: { setup: true, subagents: false, lessons: false, retrieval: false, wake: false, workspace: false },
    extensions: { probe: { kind: 'module', path: extension, config: { dir } } },
  }));
  let screen = '';
  const decoder = new TextDecoder();
  const terminal = new Bun.Terminal({ cols: 200, rows: 50, data: (_t, data) => { screen += decoder.decode(data, { stream: true }); } });
  const host = Bun.spawn([process.execPath, INDEX_PATH, recipe, '--no-tui'], {
    cwd: dir, env: { ...process.env, DATA_DIR: dir, CONNECTOME_SETUP_DIR: dir, TERM: 'xterm-256color' }, terminal,
  });
  const lines = () => rendered(screen);
  try {
    await until(() => screen.includes('PROBE_TOKEN (a probe), typed hidden'), 'hidden question', () => screen);
    terminal.write(`${SECRET}\r`);
    await until(() => lines().at(-1) === '> ' && existsSync(join(dir, 'asked.json')), 'the stored secret and a prompt', () => screen);
    expect(readFileSync(join(dir, 'opened.txt'), 'utf-8')).toStartWith('From setup, not the person: they\'ve started setup, and this conversation holds nothing yet');
    expect(JSON.parse(readFileSync(join(dir, 'asked.json'), 'utf-8')).success).toBe(true);
    expect(readEnvFile(join(dir, '.env')).get('PROBE_TOKEN')).toBe(SECRET);
    terminal.write('\x1b[Aprobe-mark');
    await until(() => lines().at(-1)!.endsWith('probe-mark'), 'readline\'s answer to the up arrow', () => screen);
    terminal.write('\x15');
    expect(screen).not.toContain(SECRET);
    expect(screen).not.toContain('[probe-early]');
    expect(readFileSync(join(dir, 'readline-error.log'), 'utf-8')).toContain('[probe-early] a line before readline mode starts');
    terminal.write('/help\r');
    await until(() => lines().some((line) => line.startsWith('  /session new')), '/help', () => screen);
    expect(lines()).toContain('--- In setup ---');
    terminal.write('goodbye\r');
    expect(await host.exited).toBe(0);
    expect(lines().some((line) => line.startsWith('Shutting down'))).toBe(true);
    expect(readFileSync(join(dir, 'logged.txt'), 'utf-8')).toBe('1\n2\n');
  } finally {
    if (host.exitCode === null) host.kill('SIGKILL');
    await host.exited;
    if (!terminal.closed) terminal.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

test('setup\'s conversation ends after the turn that finished, when the line it answers was typed during the turn before', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'setup-readline-')));
  const extension = join(dir, 'probe.ts');
  writeFileSync(extension, EXTENSION);
  const recipe = join(dir, 'recipe.json');
  writeFileSync(recipe, JSON.stringify({
    name: 'Setup readline test',
    agent: { name: 'setup', provider: 'mock', systemPrompt: 'A mock setup agent.', mock: { echoMode: true } },
    modules: { setup: true, subagents: false, lessons: false, retrieval: false, wake: false, workspace: false },
    extensions: { probe: { kind: 'module', path: extension, config: { dir, hold: 'first', finishAt: 3 } } },
  }));
  let screen = '';
  const decoder = new TextDecoder();
  const terminal = new Bun.Terminal({ cols: 200, rows: 50, data: (_t, data) => { screen += decoder.decode(data, { stream: true }); } });
  const host = Bun.spawn([process.execPath, INDEX_PATH, recipe, '--no-tui'], {
    cwd: dir, env: { ...process.env, DATA_DIR: dir, CONNECTOME_SETUP_DIR: dir, TERM: 'xterm-256color' }, terminal,
  });
  const lines = () => rendered(screen);
  try {
    await until(() => screen.includes('PROBE_TOKEN (a probe), typed hidden'), 'hidden question', () => screen);
    terminal.write(`${SECRET}\r`);
    await until(() => lines().at(-1) === '> ' && existsSync(join(dir, 'asked.json')), 'the stored secret and a prompt', () => screen);
    terminal.write('first\r');
    await until(() => existsSync(join(dir, 'holding.txt')), 'the first line held', () => screen);
    terminal.write('goodbye\r');
    await until(() => /goodbye\r*\n/.test(screen), 'the second line read', () => screen);
    writeFileSync(join(dir, 'release.txt'), '');
    const ended = await Promise.race([host.exited, Bun.sleep(20_000).then(() => 'still open after 20 s')]);
    expect(ended).toBe(0);
    expect(readFileSync(join(dir, 'logged.txt'), 'utf-8')).toBe('1\n2\n3\n');
  } finally {
    if (host.exitCode === null) host.kill('SIGKILL');
    await host.exited;
    if (!terminal.closed) terminal.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
