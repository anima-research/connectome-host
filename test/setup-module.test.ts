import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ToolCall, ToolResult } from '@animalabs/agent-framework';
import { SetupModule, commandsShownNote, openingMessage, type SecretAsker } from '../src/modules/setup-module.js';
import { SHOWN_FILE } from '../src/cli/shown.js';
import { EnvFormError, envForm, readEnvFile, writeEnvValue } from '../src/setup/secrets.js';
import { PASTE_QUIET_MS, askHidden } from '../src/setup/terminal-secret.js';
import * as terminalSecret from '../src/setup/terminal-secret.js';
import { modeTest } from './mode-test.js';
import { processEnded, waitForEnd } from './process-ended.js';
import { bracketedPaste } from '../src/readline-paste.js';
import { checkDiscordToken } from '../src/setup/discord-token.js';
import { checkProviderKey } from '../src/setup/provider-key.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'setup-module-'));
  dirs.push(dir);
  return dir;
}

const discordAccepts = (async () => Response.json({ id: '1000', username: 'test-bot' })) as unknown as typeof fetch;

function install(opts: { asker?: SecretAsker | null; env?: Record<string, string>; envFile?: string; dir?: string; fetch?: typeof fetch } = {}) {
  const dir = opts.dir ?? scratch();
  if (opts.envFile !== undefined) writeFileSync(join(dir, '.env'), opts.envFile, { mode: 0o600 });
  const asker = opts.asker === undefined ? null : opts.asker;
  const shown: string[] = [];
  const module = new SetupModule({
    dir,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? dir, ...(opts.env ?? {}) },
    asker: () => asker,
    show: (line) => shown.push(line),
    fetch: opts.fetch ?? discordAccepts,
  });
  return { dir, module, shown };
}

type RunAnswer = {
  exitCode: number | null;
  signal?: string;
  stoppedAtLimit: boolean;
  outputHeldOpen?: boolean;
  note?: string;
  stdout: { bytes: number; text: string; cut: boolean };
  stderr: { bytes: number; text: string; cut: boolean };
  replaced: string[];
};

function runCall(module: SetupModule, command: string, timeoutMs?: number): Promise<ToolResult> {
  return module.handleToolCall({ id: 'c1', name: 'run', input: { command, ...(timeoutMs === undefined ? {} : { timeoutMs }) } } as ToolCall);
}

async function run(module: SetupModule, command: string, timeoutMs?: number): Promise<RunAnswer> {
  const result = await runCall(module, command, timeoutMs);
  expect(result.success, result.error).toBe(true);
  return result.data as RunAnswer;
}

function listSecrets(module: SetupModule, ...names: string[]): void {
  mkdirSync(dirname(module.storedSecrets.file), { recursive: true });
  writeFileSync(module.storedSecrets.file, JSON.stringify(names));
}

async function askSecret(module: SetupModule, input: Record<string, unknown>) {
  return module.handleToolCall({ id: 'c2', name: 'ask_secret', input } as ToolCall);
}

// Work held behind an open question waits on the module's asking with await, which calls a thenable's then.
function heldAt(module: SetupModule): Promise<void> {
  const held = module as unknown as { asking: PromiseLike<unknown> };
  const open = held.asking;
  return new Promise((reached) => {
    held.asking = { then: (onDone, onFailed) => { reached(); return open.then(onDone, onFailed); } } as PromiseLike<unknown>;
  });
}

// A question asked while a model check is under way waits on that check with Promise.all, which calls its then.
function heldOnChecks(module: SetupModule): Promise<void> {
  const { checks } = module as unknown as { checks: Set<Promise<void>> };
  if (checks.size === 0) throw new Error('no model check is under way');
  return new Promise((reached) => {
    for (const check of checks) {
      const then = check.then.bind(check);
      check.then = ((onDone, onFailed) => { reached(); return then(onDone, onFailed); }) as typeof check.then;
    }
  });
}

// For tests that read /proc or run setsid(1): macOS has neither, and a Linux container may not mount /proc or have setsid.
const linuxTest = test.skipIf(process.platform !== 'linux' || !existsSync('/proc/self/stat') || Bun.which('setsid') === null);

const uptime = () => Number(readFileSync('/proc/uptime', 'utf-8').split(' ')[0]);

async function waitForFile(path: string): Promise<string> {
  for (const until = performance.now() + 10_000; performance.now() < until; await Bun.sleep(10)) {
    if (existsSync(path) && readFileSync(path, 'utf-8').trim() !== '') return readFileSync(path, 'utf-8').trim();
  }
  throw new Error(`${path} never came`);
}

const WHY = {
  control: 'holds an ASCII control character, such as a carriage return, which each line of a file saved with Windows line ends has, or a tab',
  start: 'is neither empty, a comment starting with #, nor NAME= at its start',
  value: 'spells its value in none of the form\'s three ways',
};
const outside = (path: string, line: number, why: string, others = 0) => `${path}, line ${line}, ${why}${others === 0 ? '' : `, and ${others} other line${others === 1 ? ' isn\'t' : 's aren\'t'} in setup's form either`}. Setup reads and writes .env in one form, which Bun reads as it's written: empty lines, comments starting with #, and NAME=value, NAME="value" or NAME='value', each on one line, where NAME is ASCII letters, digits and _, not starting with a digit, a quoted value holds no quote of its own kind, $ or backslash, an unquoted one no quote, backtick, $, backslash, space or #, and no line holds a tab or another ASCII control character. Rewrite such a line in that form, or take it out of this .env, which is setup's: a value the host needs from it then has to reach the host's environment another way`;

const PROVIDER_CREDENTIALS = {
  ANTHROPIC_API_KEY: 'anthropic-api-key-value',
  ANTHROPIC_AUTH_TOKEN: 'anthropic-auth-token-value',
  ANTHROPIC_OAUTH_CREDENTIALS_FILE: '/home/someone/oauth-credentials-copy.json',
  OPENAI_API_KEY: 'openai-api-key-value',
  OPENROUTER_API_KEY: 'openrouter-api-key-value',
  OPENAI_COMPATIBLE_API_KEY: 'openai-compatible-api-key-value',
  AWS_ACCESS_KEY_ID: 'aws-access-key-id-value',
  AWS_SECRET_ACCESS_KEY: 'aws-secret-access-key-value',
  AWS_SESSION_TOKEN: 'aws-session-token-value',
  CODEX_GATE_TOKEN: 'codex-gate-token-value',
  ANTHROPIC_BASE_URL: 'https://gateway.example/anthropic?key=gateway-key-value',
  OPENAI_BASE_URL: 'https://openai-gateway.example/v1?key=openai-gateway-key',
  BEDROCK_BASE_URL: 'https://bedrock-gateway.example/?key=bedrock-gateway-key',
  CODEX_BASE_URL: 'https://codex-gateway.example/?key=codex-gateway-key',
  OPENROUTER_BASE_URL: 'https://openrouter-gateway.example/api/v1?key=openrouter-gateway-key',
};

describe('setup--finished', () => {
  const call = (module: SetupModule) => module.handleToolCall({ id: 'f', name: 'finished', input: {} } as ToolCall);
  test('records when setup finished beside its answers, and asks the host to end the conversation', async () => {
    const { dir, module } = install();
    mkdirSync(join(dir, '.setup'), { recursive: true });
    writeFileSync(join(dir, '.setup', 'setup-state.json'), JSON.stringify({ v: 1 }));
    expect(module.finishedAt()).toBeNull();
    const before = Date.now();
    const result = await call(module);
    expect(result.success).toBe(true);
    const state = JSON.parse(readFileSync(join(dir, '.setup', 'setup-state.json'), 'utf-8')) as { v: number; finished: string };
    expect(state).toEqual({ v: 1, finished: state.finished });
    expect(Date.parse(state.finished)).toBeGreaterThanOrEqual(before - 1000);
    expect(String(result.data)).toBe(`Recorded that setup finished at ${state.finished}. The conversation ends after this turn, once anything the person typed meanwhile has come to you as further turns.`);
    expect(statSync(join(dir, '.setup', 'setup-state.json')).mode & 0o777).toBe(0o600);
    expect(module.finishRequested).toBe(true);
    expect(module.finishedAt()).toBe(state.finished);
  });

  test('a finished time that isn\'t an ISO time reading back the same, such as a stored key or an RFC 1123 date, is read as answers setup doesn\'t keep, and isn\'t told; an ISO time is read as when setup finished', () => {
    const { dir, module } = install();
    mkdirSync(join(dir, '.setup'), { recursive: true });
    const state = (finished: string) => writeFileSync(join(dir, '.setup', 'setup-state.json'), JSON.stringify({ v: 1, finished }));
    state('sk-ant-stored-key');
    expect(module.finishedAt()).toBeNull();
    state('Sun, 01 Nov 2026 01:00:00 GMT');
    expect(module.finishedAt()).toBeNull();
    state('2026-11-01T01:00:00.000Z');
    expect(module.finishedAt()).toBe('2026-11-01T01:00:00.000Z');
  });

  test('with no answers of setup\'s to put it beside, records nothing and leaves the conversation going', async () => {
    const { dir, module } = install();
    const result = await call(module);
    expect(result.success).toBe(false);
    expect(String(result.error)).toBe(`${join(dir, '.setup', 'setup-state.json')} isn't there, so nothing was recorded and the conversation goes on. Tell the person: running setup again asks its questions again.`);
    mkdirSync(join(dir, '.setup'), { recursive: true });
    writeFileSync(join(dir, '.setup', 'setup-state.json'), 'not json');
    const unreadable = await call(module);
    expect(String(unreadable.error)).toBe(`${join(dir, '.setup', 'setup-state.json')} can't be read (it isn't JSON), so nothing was recorded and the conversation goes on. Tell the person: while it can't be read, running setup again asks its questions again.`);
    expect(module.finishRequested).toBe(false);
  });

  modeTest('where its directory can\'t be written, records nothing, says what stopped it and what to do, and leaves the conversation going', async () => {
    const { dir, module } = install();
    mkdirSync(join(dir, '.setup'), { recursive: true });
    writeFileSync(join(dir, '.setup', 'setup-state.json'), JSON.stringify({ v: 1 }));
    chmodSync(join(dir, '.setup'), 0o500);
    try {
      const result = await call(module);
      expect(result.success).toBe(false);
      expect(String(result.error)).toStartWith(`${join(dir, '.setup', 'setup-state.json')} couldn't be written (`);
      expect(String(result.error)).toEndWith('), so it may not have been recorded, and the conversation goes on. Tell the person what stopped it, which is theirs to put right, and call setup--finished again once they have.');
      expect(module.finishRequested).toBe(false);
      expect(module.finishedAt()).toBeNull();
    } finally {
      chmodSync(join(dir, '.setup'), 0o700);
    }
  });

  test('a start after setup finished opens by saying so, and when', () => {
    expect(openingMessage(true, 'start', '2026-11-01T01:00:00.000Z')).toBe('From setup, not the person: they\'ve started setup again after it finished, at 2026-11-01T01:00:00.000Z, and this conversation picks up where it stopped.');
    expect(openingMessage(false, 'start', '2026-11-01T01:00:00.000Z')).toBe('From setup, not the person: they\'ve started setup again after it finished, at 2026-11-01T01:00:00.000Z. What setup has done stays on disk, and this conversation doesn\'t hold it.');
    expect(openingMessage(false, 'switch', '2026-11-01T01:00:00.000Z')).toContain(' Setup had finished, at 2026-11-01T01:00:00.000Z.');
    expect(openingMessage(false, 'start')).toBe('From setup, not the person: they\'ve started setup, and this conversation ' +
      'holds nothing yet: what setup did before, if it ran here, stays on disk.');
  });
});

describe('setup--run', () => {
  test('with no bash it can run on the PATH setup started with, it says so, that calling again won\'t help until there is, and to tell the person', async () => {
    const { module } = install({ env: { PATH: scratch() } });
    const result = await runCall(module, 'echo reached');
    expect(result.success).toBe(false);
    expect(result.error).toBe('setup--run couldn\'t start bash: no bash this user can run is on the PATH setup started with, so ' +
      'calling it again runs nothing until one is. Tell the person.');
  });

  test('with the install directory gone, it says the directory isn\'t there, not that bash isn\'t', async () => {
    const { dir, module } = install();
    rmSync(dir, { recursive: true, force: true });
    const result = await runCall(module, 'echo reached');
    expect(result.success).toBe(false);
    expect(result.error).toBe(`setup--run couldn't start bash: the install directory it runs commands in, ${dir}, isn't there ` +
      'now, so calling it again runs nothing until it is. Tell the person.');
  });

  test('runs a command in the install directory and answers its exit status and output, keeping nothing between calls', async () => {
    const { dir, module } = install();
    const first = await run(module, 'export KEPT=yes; cd /; echo "in $PWD"; echo oops >&2; exit 3');
    expect(first.exitCode).toBe(3);
    expect(first.stoppedAtLimit).toBe(false);
    expect(first.stdout.text).toBe('in /\n');
    expect(first.stderr.text).toBe('oops\n');
    const second = await run(module, 'echo "${KEPT:-unset} in $PWD"');
    expect(second.exitCode).toBe(0);
    expect(second.stdout.text).toBe(`unset in ${dir}\n`);
  });

  test('shows the person each command whole as it starts, with a stored secret\'s value as its name and what a terminal would act on as its escape', async () => {
    const dir = scratch();
    writeFileSync(join(dir, '.env'), 'DISCORD_TOKEN="shown-secret-value"\n', { mode: 0o600 });
    const shown: Array<[string, boolean]> = [];
    const module = new SetupModule({
      dir, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir }, asker: () => null,
      show: (line) => shown.push([line, existsSync(join(dir, 'ran'))]),
    });
    listSecrets(module, 'DISCORD_TOKEN');
    const long = `echo ${'x'.repeat(300)} > /dev/null`;
    const answer = await run(module, `${long}\n: '\u001b[2K\r\u202e\u0085\u061c\t\u200b\u00a0\u2028\u{e0041}\u034f\u3164\ufe0f\u2800'\necho shown-secret-value > /dev/null; touch ran`);
    expect(answer.exitCode).toBe(0);
    expect(shown).toEqual([
      ["Setup's agent runs:", false],
      [`  ${long}`, false],
      ["  : '\\u001b[2K\\u000d\\u202e\\u0085\\u061c\\u0009\\u200b\\u00a0\\u2028\\u{e0041}\\u034f\\u3164\\ufe0f\\u2800'", false],
      ['  echo <DISCORD_TOKEN> > /dev/null; touch ran', false],
    ]);
  });

  test('shows a provider credential\'s value as its name under the lead alone, and setup\'s note on how commands are shown names the directory with what a terminal would act on as its escape', async () => {
    const dir = join(scratch(), 'in\u202e\tthere');
    expect(commandsShownNote(dir)).toBe(`Setup's agent runs each command in ${dir.replace('\u202e\t', '\\u202e\\u0009')}, as you. You'll see each command whole as it starts. It doesn't wait for you. Each of its lines is on a line of its own, any character a terminal would hide or act on is shown as a code, such as \\u001b for Escape, and each key or token setup knows of is shown by its name in place of its value, such as <ANTHROPIC_API_KEY>.`);
    mkdirSync(dir);
    const { module, shown } = install({ dir, env: { ANTHROPIC_API_KEY: 'sk-ant-shown-provider-value' } });
    expect((await run(module, 'echo sk-ant-shown-provider-value > /dev/null')).exitCode).toBe(0);
    expect(shown).toEqual([
      "Setup's agent runs:",
      '  echo <ANTHROPIC_API_KEY> > /dev/null',
    ]);
  });

  test('the agent\'s purpose for a hidden question reaches the terminal with what a terminal would act on or hide as its escape', async () => {
    const asked: string[] = [];
    const { module } = install({ asker: { ask: async (_name, purpose) => { asked.push(purpose); return 'a-typed-value'; } } });
    expect((await askSecret(module, { name: 'DISCORD_TOKEN', purpose: 'the bot\u001b[8m token\u202e from\u200b Discord\u034f\u3164\ufe0f\u2800' })).success).toBe(true);
    expect(asked).toEqual(['the bot\\u001b[8m token\\u202e from\\u200b Discord\\u034f\\u3164\\ufe0f\\u2800']);
  });

  test('a command asked for while a hidden question is open is shown and run once the question is answered, not before', async () => {
    let answer: ((value: string) => void) | undefined;
    const { dir, module, shown } = install({ asker: { ask: () => new Promise<string>((done) => { answer = done; }) } });
    const asking = askSecret(module, { name: 'API_TOKEN', purpose: 'a token' });
    for (const started = performance.now(); answer === undefined && performance.now() - started < 5_000; await new Promise((done) => setTimeout(done, 10)));
    expect(answer).toBeDefined();
    const reached = heldAt(module);
    const running = run(module, 'touch ran');
    await Promise.race([reached, running.then(() => { throw new Error('the command ran without waiting for the question'); })]);
    expect(shown).toEqual([]);
    expect(existsSync(join(dir, 'ran'))).toBe(false);
    answer!('a-held-secret');
    expect((await asking).success).toBe(true);
    expect((await running).exitCode).toBe(0);
    expect(shown).toEqual(["Setup's agent runs:", '  touch ran']);
  });

  test('gives its command no input', async () => {
    const { module } = install();
    const answer = await run(module, 'if read -r line; then echo "read: $line"; else echo "nothing to read"; fi');
    expect(answer.stdout.text).toBe('nothing to read\n');
  });

  test('refuses a time limit above 30 minutes, running nothing', async () => {
    const { dir, module } = install();
    const result = await runCall(module, 'touch ran', 30 * 60_000 + 1);
    expect(result.success).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.error).toContain(String(30 * 60_000));
    expect(existsSync(join(dir, 'ran'))).toBe(false);
  });

  test('a command runs without DATA_DIR, CONNECTOME_UPDATE_CHECK and setup\'s own variables, which are for setup\'s host alone, and with the file for what it says to the person', async () => {
    const { module } = install({
      env: { DATA_DIR: '/setup/data', CONNECTOME_UPDATE_CHECK: '0', CONNECTOME_SETUP_INSTALL: '/setup/root', KEEP_ME: 'kept' },
    });
    const answer = await run(module, `env | grep -E "^(DATA_DIR|CONNECTOME_[A-Z0-9_]*|KEEP_ME)=" | sed "s/^${SHOWN_FILE}=.*/${SHOWN_FILE}=<file>/" | sort`);
    expect(answer.stdout.text).toBe(`${SHOWN_FILE}=<file>\nKEEP_ME=kept\n`);
  });

  test('a secret a dotenv file beside .env gives, with the value Bun expands it to, is shown by its name in a command\'s output', async () => {
    const { dir, module } = install({ envFile: 'DISCORD_TOKEN="discord-token-value"\n' });
    writeFileSync(join(dir, '.env.local'), 'BASE=local-base\nMY_TOKEN=${BASE}-suffix\n');
    const answer = await run(module, 'echo "token local-base-suffix"');
    expect(answer.stdout.text).toBe('token <MY_TOKEN>\n');
  });

  test('a stored secret in a command\'s output is shown by its name, its ASCII letters in any case', async () => {
    const { module } = install({ envFile: 'DISCORD_TOKEN="Discord-Token-Value"\n' });
    const answer = await run(module, 'echo "discord-token-value DISCORD-TOKEN-VALUE"; echo "Discord-Token-Value" >&2');
    expect(answer.stdout.text).toBe('<DISCORD_TOKEN> <DISCORD_TOKEN>\n');
    expect(answer.stderr.text).toBe('<DISCORD_TOKEN>\n');
  });

  test('a secret a dotenv file names as a name every object has, such as constructor, is shown by its name in a command\'s output', async () => {
    const { dir, module } = install({ envFile: 'DISCORD_TOKEN="discord-token-value"\n' });
    writeFileSync(join(dir, '.env.local'), 'constructor=private-token\n');
    const answer = await run(module, 'echo "token private-token"');
    expect(answer.stdout.text).toBe('token <constructor>\n');
  });

  async function startedWhileOpen(call: ToolCall, startLine: string, firstName: string, extra: { fetch?: typeof fetch } = {}) {
    let releaseFirst: (value: string | null) => void = () => {};
    let releaseSecond: (value: string | null) => void = () => {};
    const answers = [
      new Promise<string | null>((done) => { releaseFirst = done; }),
      new Promise<string | null>((done) => { releaseSecond = done; }),
    ];
    let asks = 0;
    const made = install({ ...extra, asker: { ask: () => { asks += 1; return answers.shift()!; } } });
    const first = askSecret(made.module, { name: firstName, purpose: 'x' });
    let second: Promise<unknown> | undefined;
    let askedAt = -1;
    let onReached = () => {};
    const reached = new Promise<void>((done) => { onReached = done; });
    void (made.module as unknown as { asking: Promise<unknown> }).asking.then(() => {
      askedAt = made.shown.length;
      second = askSecret(made.module, { name: 'OTHER_TOKEN', purpose: 'y' });
      void heldAt(made.module).then(onReached);
    });
    const pending = made.module.handleToolCall(call);
    releaseFirst('sk-first-value');
    await first;
    await Promise.race([reached, pending.then(() => { throw new Error('it ran without waiting for the second question'); })]);
    const answeredAt = made.shown.length;
    releaseSecond('second-value');
    await second;
    const result = await pending;
    const started = made.shown.findIndex((line) => line.includes(startLine));
    return { result, started: started >= 0, whileAsked: started >= askedAt && started < answeredAt, asks };
  }

  test('a command doesn\'t start while a question asked as its wait for the earlier ones ended is unanswered', async () => {
    const { result, ...when } = await startedWhileOpen(
      { id: 'r1', name: 'run', input: { command: 'echo ran' } } as ToolCall, 'Setup\'s agent runs:', 'MY_TOKEN');
    expect(when).toEqual({ started: true, whileAsked: false, asks: 2 });
    expect(result.success).toBe(true);
  });

  test('a model check doesn\'t start while a question asked as its wait for the earlier ones ended is unanswered', async () => {
    const fetchModels = (async () => Response.json({ data: [{ id: 'gpt-6.1-terra' }] })) as unknown as typeof fetch;
    const { result, ...when } = await startedWhileOpen(
      { id: 'c1', name: 'check_model', input: { name: 'OPENAI_API_KEY', model: 'gpt-6.1-terra' } } as ToolCall,
      'Checking gpt-6.1-terra', 'OPENAI_API_KEY', { fetch: fetchModels });
    expect(when).toEqual({ started: true, whileAsked: false, asks: 2 });
    expect(result.success).toBe(true);
  });

  test('a model check already under way when a question is asked shows nothing while the question is open', async () => {
    let requested = () => {};
    const sent = new Promise<void>((done) => { requested = done; });
    let reply: (response: Response) => void = () => {};
    const fetchModels = (() => {
      requested();
      return new Promise<Response>((done) => { reply = done; });
    }) as unknown as typeof fetch;
    let opened = () => {};
    const open = new Promise<void>((done) => { opened = done; });
    let checked: Promise<ToolResult> = Promise.resolve({ success: false } as ToolResult);
    const shownWhileOpen: string[] = [];
    const made = install({
      envFile: 'OPENAI_API_KEY="sk-stored-value"\n',
      fetch: fetchModels,
      asker: {
        ask: async () => {
          const at = made.shown.length;
          opened();
          await checked;
          shownWhileOpen.push(...made.shown.slice(at));
          return 'other-value';
        },
      },
    });
    checked = made.module.handleToolCall(
      { id: 'c1', name: 'check_model', input: { name: 'OPENAI_API_KEY', model: 'gpt-6.1-terra' } } as ToolCall);
    await sent;
    const held = heldOnChecks(made.module);
    const asked = askSecret(made.module, { name: 'OTHER_TOKEN', purpose: 'y' });
    await Promise.race([open, held]);
    reply(Response.json({ data: [{ id: 'gpt-6.1-terra' }] }));
    expect((await checked).success).toBe(true);
    expect((await asked).success).toBe(true);
    expect(made.shown.some((line) => line.includes('lists gpt-6.1-terra'))).toBe(true);
    expect(shownWhileOpen).toEqual([]);
  });

  test('a command that ends while a question is open shows what it said once the question is answered', async () => {
    const shownWhileOpen: string[] = [];
    let open = '';
    const made = install({
      asker: {
        ask: async () => {
          const at = made.shown.length;
          const held = heldAt(made.module);
          writeFileSync(open, '');
          const shownSince = new Promise<void>((done) => {
            const look = () => (made.shown.slice(at).includes('It said:') ? done() : setTimeout(look, 10));
            look();
          });
          await Promise.race([held, shownSince]);
          shownWhileOpen.push(...made.shown.slice(at));
          return 'a-held-secret';
        },
      },
    });
    open = join(made.dir, 'open');
    const running = run(made.module, `while [ ! -e ${open} ]; do sleep 0.02; done; echo said-for-the-person >> "$CONNECTOME_SETUP_SHOWN"`);
    for (const started = performance.now(); !made.shown.includes("Setup's agent runs:") && performance.now() - started < 5_000; await Bun.sleep(10));
    expect((await askSecret(made.module, { name: 'OTHER_TOKEN', purpose: 'y' })).success).toBe(true);
    expect(shownWhileOpen).toEqual([]);
    expect((await running).exitCode).toBe(0);
    expect(made.shown.slice(-2)).toEqual(['It said:', '  said-for-the-person']);
  });

  test('a timeoutMs out of its range is refused, naming the value given', async () => {
    const { module } = install();
    const result = await runCall(module, 'true', -5);
    expect(result.error).toBe(`setup--run's timeoutMs was -5: it's a number of ms above 0 and at most ${30 * 60_000}.`);
  });

  test('a secret a dotenv file beside .env gives through a name it sets later, or with an escaped $, is shown by its name in a command\'s output, as Bun gives it', async () => {
    const { dir, module } = install({ envFile: 'DISCORD_TOKEN="discord-token-value"\n' });
    writeFileSync(join(dir, '.env.local'), 'MY_TOKEN=${LATER}-token\nLATER=later-value\nPRICE=five\\$a-share\n');
    const answer = await run(module, 'echo "later-value-token five\\$a-share"');
    expect(answer.stdout.text).toBe('<MY_TOKEN> <PRICE>\n');
  });

  test('a NODE_ENV a dotenv file gives is shown by its name, and the modes setup reads the files in aren\'t', async () => {
    const { dir, module } = install({ envFile: 'DISCORD_TOKEN="discord-token-value"\n' });
    writeFileSync(join(dir, '.env.local'), 'NODE_ENV=staging\n');
    const answer = await run(module, 'echo "test production development staging"');
    expect(answer.stdout.text).toBe('test production development <NODE_ENV>\n');
  });

  test('a secret a dotenv file builds from a variable the command\'s environment gives otherwise than setup\'s is shown by its name', async () => {
    const { dir, module } = install({ envFile: 'DISCORD_TOKEN="discord-token-value"\n', env: { DATA_DIR: '/setup-own/data', NODE_ENV: 'staging' } });
    writeFileSync(join(dir, '.env.local'), 'MY_PATH=tok-${DATA_DIR}-en\nMY_TOKEN=tok-${NODE_ENV}-en\n');
    const answer = await run(module, `${process.execPath} -e 'console.log(process.env.MY_PATH, process.env.MY_TOKEN)'`);
    expect(answer.stdout.text).toBe('<MY_PATH> <MY_TOKEN>\n');
  });

  test('a secret a dotenv file builds from a variable that holds another secret\'s value, which the command\'s environment leaves out, is shown by its name', async () => {
    const { dir, module } = install({ env: { ANTHROPIC_API_KEY: 'secret123', COPY: 'secret123' } });
    writeFileSync(join(dir, '.env.local'), 'MY_TOKEN=prefix${COPY}\n');
    const answer = await run(module, `${process.execPath} -e 'console.log(process.env.MY_TOKEN)'`);
    expect(answer.stdout.text).toBe('<MY_TOKEN>\n');
  });

  test('a read of the dotenv files that runs out of time is answered as one to try once more, not as a file to put right', () => {
    const dir = scratch();
    writeFileSync(join(dir, '.env'), 'MY_SERVER_TOKEN="custom-token-value"\n', { mode: 0o600 });
    const child = join(dir, 'timeout-child.ts');
    // spawnSync's answer when its timeout kills the child, for Bun's read of the dotenv files alone.
    writeFileSync(child, `
      import { mock } from 'bun:test';
      import * as childProcess from 'node:child_process';
      const real = childProcess.spawnSync;
      mock.module('node:child_process', () => ({ ...childProcess, spawnSync: (command, args, options) =>
        Array.isArray(args) && args.includes('--config=/dev/null')
          ? { pid: 0, output: [null, '', ''], stdout: '', stderr: '', status: null, signal: 'SIGTERM',
            error: Object.assign(new Error('spawnSync ' + command + ' ETIMEDOUT'), { code: 'ETIMEDOUT' }) }
          : real(command, args, options) }));
      const { SetupModule } = await import(${JSON.stringify(join(import.meta.dir, '..', 'src', 'modules', 'setup-module.ts'))});
      const module = new SetupModule({ dir: ${JSON.stringify(dir)}, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: ${JSON.stringify(dir)} },
        asker: () => null, show: () => {}, fetch: async () => new Response('{}') });
      console.log(JSON.stringify(await module.handleToolCall({ id: 'c1', name: 'run', input: { command: 'echo ran' } })));
      process.exit(0);
    `);
    const ran = Bun.spawnSync([process.execPath, child], { timeout: 20_000, killSignal: 'SIGKILL', stderr: 'pipe' });
    expect({ exitCode: ran.exitCode, signal: ran.signalCode ?? null }, ran.stderr.toString()).toEqual({ exitCode: 0, signal: null });
    const result = JSON.parse(ran.stdout.toString()) as ToolResult;
    expect(result.success).toBe(false);
    expect(result.error).toStartWith(`setup--run ran nothing: Bun didn't finish reading the dotenv files in ${dir} within 10 s`);
    expect(result.error).toContain('call again once');
    expect(result.error).not.toContain('put it right');
  }, 30_000);

  test('a read of the dotenv files that runs out of time after the command ran says it ran, and not to run it again to see its output', () => {
    const dir = scratch();
    writeFileSync(join(dir, '.env'), 'MY_SERVER_TOKEN="custom-token-value"\n', { mode: 0o600 });
    const marker = join(dir, 'ran');
    const child = join(dir, 'timeout-after-child.ts');
    writeFileSync(child, `
      import { mock } from 'bun:test';
      import { existsSync } from 'node:fs';
      import * as childProcess from 'node:child_process';
      const real = childProcess.spawnSync;
      mock.module('node:child_process', () => ({ ...childProcess, spawnSync: (command, args, options) =>
        Array.isArray(args) && args.includes('--config=/dev/null') && existsSync(${JSON.stringify(marker)})
          ? { pid: 0, output: [null, '', ''], stdout: '', stderr: '', status: null, signal: 'SIGTERM',
            error: Object.assign(new Error('spawnSync ' + command + ' ETIMEDOUT'), { code: 'ETIMEDOUT' }) }
          : real(command, args, options) }));
      const { SetupModule } = await import(${JSON.stringify(join(import.meta.dir, '..', 'src', 'modules', 'setup-module.ts'))});
      const module = new SetupModule({ dir: ${JSON.stringify(dir)}, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: ${JSON.stringify(dir)} },
        asker: () => null, show: () => {}, fetch: async () => new Response('{}') });
      console.log(JSON.stringify(await module.handleToolCall({ id: 'c1', name: 'run', input: { command: 'echo once >> ran' } })));
      process.exit(0);
    `);
    const ran = Bun.spawnSync([process.execPath, child], { timeout: 20_000, killSignal: 'SIGKILL', stderr: 'pipe' });
    expect({ exitCode: ran.exitCode, signal: ran.signalCode ?? null }, ran.stderr.toString()).toEqual({ exitCode: 0, signal: null });
    const result = JSON.parse(ran.stdout.toString()) as ToolResult;
    expect(result.success).toBe(false);
    expect(result.error).toStartWith(`setup--run's command ended (exit 0), and its output isn't shown: Bun didn't finish reading the dotenv files in ${dir} within 10 s. It ran, so calling setup--run again with the same command runs it a second time`);
    expect(result.error).not.toContain('call again once');
    expect(readFileSync(marker, 'utf-8')).toBe('once\n');
  }, 30_000);

  test('a command stopped at its limit that left a dotenv file unreadable is said to have been stopped, though its output isn\'t shown', async () => {
    const { module } = install({ envFile: 'MY_SERVER_TOKEN="custom-token-value"\n' });
    const result = await runCall(module, 'mkfifo .env.local; echo word-it-printed; sleep 30', 500);
    expect(result.success).toBe(false);
    expect(result.error).toContain('It was still running at its 500 ms limit, so its process group was sent SIGTERM, and all of it ended within 5 s.');
    expect(result.error).toContain('.env.local can\'t be read (it isn\'t a file)');
    expect(JSON.stringify(result)).not.toContain('word-it-printed');
  }, 20_000);

  test('a command that left a dotenv file unreadable and a process holding its output is said to have left it, though its output isn\'t shown', async () => {
    const { dir, module } = install({ envFile: 'MY_SERVER_TOKEN="custom-token-value"\n' });
    const pidFile = join(dir, 'holder.pid');
    try {
      const result = await runCall(module, `mkfifo .env.local; sleep 30 & echo $! > ${pidFile}; echo word-it-printed`);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Its output was cut 1 s after it ended, since a process it started still holds the output open, and is still running.');
      expect(result.error).toContain('.env.local can\'t be read (it isn\'t a file)');
      expect(JSON.stringify(result)).not.toContain('word-it-printed');
    } finally {
      const pid = Number(readFileSync(pidFile, 'utf-8'));
      if (pid > 0) try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  }, 20_000);

  test('where the environment sets BUN_OPTIONS and a dotenv file expands it, a command runs nothing, since setup reads the files without it', async () => {
    const { dir, module } = install({ envFile: 'DISCORD_TOKEN="discord-token-value"\n', env: { BUN_OPTIONS: '--smol' } });
    writeFileSync(join(dir, '.env.local'), 'MY_TOKEN=prefix${BUN_OPTIONS}suffix\n');
    const result = await runCall(module, `${process.execPath} -e 'console.log(process.env.MY_TOKEN)'`);
    expect(result.success).toBe(false);
    expect(result.error).toStartWith(`setup--run ran nothing: ${join(dir, '.env.local')} expands BUN_OPTIONS, which the environment sets`);
    expect(result.error).toContain('take the expansion out of it, or start the host without BUN_OPTIONS');
    expect(JSON.stringify(result)).not.toContain('prefix--smolsuffix');
    const plain = install({ envFile: 'DISCORD_TOKEN="discord-token-value"\n', env: { BUN_OPTIONS: '--smol' } });
    writeFileSync(join(plain.dir, '.env.local'), 'MY_TOKEN=plain-token-value\n');
    expect((await run(plain.module, 'echo plain-token-value')).stdout.text).toBe('<MY_TOKEN>\n');
    const sets = install({ envFile: 'DISCORD_TOKEN="discord-token-value"\n', env: { BUN_OPTIONS: '--smol' } });
    writeFileSync(join(sets.dir, '.env.local'), 'BUN_OPTIONS=--preload=./no-such-preload.ts\nMY_TOKEN=set-token-value\n');
    listSecrets(sets.module, 'MY_TOKEN');
    expect((await run(sets.module, 'echo set-token-value')).stdout.text).toBe('<MY_TOKEN>\n');
  });

  test('a stored secret a command changes in .env and prints in that same command is shown by its name', async () => {
    const { module } = install({ envFile: 'DISCORD_TOKEN="old-token-value"\n' });
    listSecrets(module, 'DISCORD_TOKEN');
    const answer = await run(module, 'printf \'DISCORD_TOKEN="new-token-value"\\n\' > .env; cat .env');
    expect(answer.stdout.text).toBe('DISCORD_TOKEN="<DISCORD_TOKEN>"\n');
  });

  linuxTest('stops a command at its limit with every process in its group, says so, and answers', async () => {
    const { dir, module } = install();
    const pidFile = join(dir, 'child.pid');
    const called = performance.now();
    const answer = await run(module, `sleep 30 & echo $! > ${pidFile}; echo begun; sleep 30`, 500);
    const ran = performance.now() - called;
    expect(ran, 'the answer came sooner after the call than the limit').toBeGreaterThanOrEqual(490);
    expect(ran, 'the answer waited out the 5 s grace, though the whole group ended of its SIGTERM').toBeLessThan(4_500);
    expect(answer.stoppedAtLimit).toBe(true);
    expect(answer.note).toContain('500 ms limit, so its process group was sent SIGTERM, and all of it ended within 5 s.');
    expect(answer.stdout.text).toBe('begun\n');
    expect(await waitForEnd(Number(readFileSync(pidFile, 'utf-8')), 3_000)).toBe(true);
  }, 20_000);

  linuxTest('kills a process in its group that outlives its SIGTERM, 5 s after that SIGTERM, even once the command itself has ended', async () => {
    const { dir, module } = install();
    const pidFile = join(dir, 'stubborn.pid');
    const termFile = join(dir, 'term-at');
    const aliveFile = join(dir, 'alive-at');
    const answering = run(module, `(trap 'cut -d" " -f1 /proc/uptime > ${termFile}' TERM; echo $BASHPID > ${pidFile}; while :; do cut -d" " -f1 /proc/uptime > ${aliveFile}.new && mv ${aliveFile}.new ${aliveFile}; sleep 0.1 & wait $!; done) & while [ ! -s ${pidFile} ]; do sleep 0.01; done; sleep 30`, 3_000);
    const stubborn = Number(await waitForFile(pidFile));
    const termAt = Number(await waitForFile(termFile));
    let goneAt: number | null = null;
    for (const until = termAt + 15; goneAt === null && uptime() < until; await Bun.sleep(20)) {
      if (processEnded(stubborn)) goneAt = uptime();
    }
    const answer = await answering;
    expect(answer.stoppedAtLimit).toBe(true);
    expect(goneAt).not.toBeNull();
    expect(Math.round((goneAt! - termAt) * 1000)).toBeGreaterThanOrEqual(4_500);
    expect(Math.round((Number(readFileSync(aliveFile, 'utf-8')) - termAt) * 1000)).toBeGreaterThanOrEqual(4_400);
  }, 30_000);

  linuxTest('answers a command stopped at its limit only once its 5 s grace is over and SIGKILL has gone to what it left in its group, a SIGTERM-ignoring process too, whether or not that holds the output', async () => {
    for (const [holds, redirect] of [[true, ''], [false, ' > /dev/null 2>&1']] as const) {
      const { dir, module } = install();
      const pidFile = join(dir, 'stubborn.pid');
      const called = performance.now();
      const answer = await run(module, `(trap '' TERM; echo $BASHPID > ${pidFile}; exec sleep 60${redirect}) & while [ ! -s ${pidFile} ]; do sleep 0.01; done; sleep 30`, 500);
      const ran = performance.now() - called;
      const stubborn = Number(readFileSync(pidFile, 'utf-8'));
      try {
        expect(answer.stoppedAtLimit).toBe(true);
        expect(ran, `holding the output: ${holds}: the answer came before the 5 s grace after the 500 ms limit was over`).toBeGreaterThanOrEqual(5_490);
        expect(await waitForEnd(stubborn, 200), `holding the output: ${holds}: what the command left was still running ` +
          '200 ms after the answer, though SIGKILL should have gone to it before the answer').toBe(true);
        expect(answer.note).toContain('500 ms limit, so its process group was sent SIGTERM, and SIGKILL 5 s later, since some of it was still running then.');
        expect(answer.note).not.toContain('and is still running');
      } finally {
        try { process.kill(stubborn, 'SIGKILL'); } catch {}
      }
    }
  }, 40_000);

  linuxTest('a command that ends before its limit is not stopped at it while its output drains, nor is what it left running', async () => {
    let clear = false;
    for (let runs = 0; !clear && runs < 3; runs += 1) {
      const { dir, module } = install();
      const pidFile = join(dir, 'holder.pid');
      const endedFile = join(dir, 'ended-up');
      let holder = 0;
      try {
        const called = uptime();
        const answer = await run(module, `sh -c 'echo $$ > ${pidFile}; exec sleep 30' & echo begun; read -r up _ < /proc/uptime; echo $up > ${endedFile}`, 900);
        holder = Number(await waitForFile(pidFile));
        clear = Number(await waitForFile(endedFile)) <= called + 0.6;
        if (!clear) continue;
        if (answer.stoppedAtLimit && runs < 2) {
          clear = false;
          continue;
        }
        expect(answer.outputHeldOpen).toBe(true);
        expect(answer.stoppedAtLimit).toBe(false);
        expect(answer.note).not.toContain('limit');
        expect(processEnded(holder)).toBe(false);
      } finally {
        if (holder) try { process.kill(holder, 'SIGKILL'); } catch {}
      }
    }
    expect(clear, 'in 3 runs the command never ended 300 ms clear of its 900 ms limit, or it did and bash was still held ' +
      'past the limit after its last write, so the host was too slow for this case to be reached: that is load, not a ' +
      'fault in the drain').toBe(true);
  }, 30_000);

  linuxTest('answers about a second after its command ends, while a process it started in a group of its own holds the output open, and says so', async () => {
    const { dir, module } = install();
    const pidFile = join(dir, 'escaped.pid');
    const endedAt = join(dir, 'ended-at');
    const stamp = (name: string) => Number(existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf-8') : NaN);
    let holder = 0;
    try {
      const dateBefore = Number(Bun.spawnSync(['date', '+%s%3N']).stdout.toString());
      const nowBefore = Date.now();
      const monoBefore = performance.now();
      // kill -0 succeeds for a zombie, so the holder writes once the module has reaped the command's bash.
      const answer = await run(module, `B=$$ setsid sh -c 'echo $$ > ${pidFile}; while kill -0 $B 2>/dev/null; do sleep 0.01; done; date +%s%3N > ${dir}/reaped-at; echo late; read -r up _ < /proc/uptime; echo $up > ${dir}/late-up; exec sleep 30' & while [ ! -s ${pidFile} ]; do sleep 0.01; done; echo begun; date +%s%3N > ${dir}/begun-at; sleep 1.2; date +%s%3N > ${endedAt}; cut -d' ' -f1 /proc/uptime > ${dir}/ended-up`);
      const answeredUp = uptime();
      const took = Math.round((answeredUp - Number(readFileSync(join(dir, 'ended-up'), 'utf-8'))) * 1000);
      const tookByWallClock = Date.now() - Number(readFileSync(endedAt, 'utf-8'));
      const answeredAfter = Math.round(performance.now() - monoBefore);
      holder = Number(readFileSync(pidFile, 'utf-8'));
      expect(processEnded(holder)).toBe(false);
      const said = JSON.stringify({
        outputHeldOpen: answer.outputHeldOpen, note: answer.note, stdout: answer.stdout.text, exitCode: answer.exitCode,
        signal: answer.signal, answeredAfter, tookByWallClock,
        dateAheadOfNow: dateBefore - nowBefore, begunAfter: stamp('begun-at') - nowBefore,
        endedAfterBegun: stamp('ended-at') - stamp('begun-at'), reapedAfterEnded: stamp('reaped-at') - stamp('ended-at'),
      });
      expect(took, said).toBeGreaterThanOrEqual(900);
      expect(took, said).toBeLessThan(6_000);
      expect(answer.exitCode).toBe(0);
      expect(answer.outputHeldOpen).toBe(true);
      expect(answer.note).toContain('still holds the output open');
      if (answer.stdout.text !== 'begun\nlate\n') {
        const lateBeforeAnswer = answeredUp - Number(await waitForFile(join(dir, 'late-up')));
        expect(lateBeforeAnswer, `${said}: the answer left out "late", which this test allows only where the ` +
          'holder\'s stamp, read just after it wrote "late", is within 0.5 s of the answer').toBeLessThanOrEqual(0.5);
        expect(answer.stdout.text).toBe('begun\n');
      }
    } finally {
      if (holder) try { process.kill(holder, 'SIGKILL'); } catch {}
    }
  }, 20_000);

  test('answers a long output by its head and tail, with its size', async () => {
    const { module } = install();
    const answer = await run(module, 'head -c 100000 /dev/zero | tr "\\0" a; echo; echo the-end');
    expect(answer.stdout.bytes).toBe(100_009);
    expect(answer.stdout.cut).toBe(true);
    expect(answer.stdout.text.startsWith('aaaa')).toBe(true);
    expect(answer.stdout.text.endsWith('a\nthe-end\n')).toBe(true);
    const match = /^(.*)\n\[([\d,]+) bytes not shown\]\n(.*)$/s.exec(answer.stdout.text);
    expect(match).not.toBeNull();
    const [, head, hidden, tail] = match!;
    expect(head!.length).toBe(4 * 1024);
    expect(tail!.length).toBe(4 * 1024);
    expect(Number(hidden!.replace(/,/g, ''))).toBe(100_009 - 8 * 1024);
  });

  test("answers two long outputs within agent-framework's 24,000-character cap for a tool result, stderr's tail included", async () => {
    const { module } = install();
    const answer = await run(module, 'head -c 100000 /dev/zero | tr "\\0" a; head -c 100000 /dev/zero | tr "\\0" b >&2; echo the-last-word >&2');
    expect(answer.stdout.cut).toBe(true);
    expect(answer.stderr.cut).toBe(true);
    expect(answer.stderr.text.endsWith('bthe-last-word\n')).toBe(true);
    expect(JSON.stringify(answer).length).toBeLessThan(24_000);
  });

  test('keeps 4 KiB each end of ordinary output past 8 KiB, however long a stored secret is, so both streams answer under 24,000 characters', async () => {
    const { module } = install({ envFile: `LONG_TOKEN=${'t'.repeat(4_000)}\n` });
    listSecrets(module, 'LONG_TOKEN');
    const answer = await run(module, 'head -c 12000 /dev/zero | tr "\\0" a; head -c 12000 /dev/zero | tr "\\0" b >&2; echo the-last-word >&2');
    expect(answer.stdout.cut && answer.stderr.cut).toBe(true);
    expect(answer.stderr.text.endsWith('the-last-word\n')).toBe(true);
    expect(JSON.stringify(answer).length).toBeLessThan(24_000);
    const longer = install({ envFile: `LONG_TOKEN=${'t'.repeat(10_000)}\n` });
    listSecrets(longer.module, 'LONG_TOKEN');
    const short = await run(longer.module, 'head -c 9000 /dev/zero | tr "\\0" a');
    expect(short.stdout).toEqual({ bytes: 9_000, text: `${'a'.repeat(4_096)}\n[808 bytes not shown]\n${'a'.repeat(4_096)}`, cut: true });
  });

  test('an output of exactly twice the kept window answers its first and last 4 KiB, and counts the 8 bytes between', async () => {
    const { module } = install();
    const answer = await run(module, 'head -c 4100 /dev/zero | tr "\\0" a; head -c 4100 /dev/zero | tr "\\0" b');
    expect(answer.stdout).toEqual({ bytes: 8_200, text: `${'a'.repeat(4_096)}\n[8 bytes not shown]\n${'b'.repeat(4_096)}`, cut: true });
  });

  test('shows whole a secret the head\'s cut runs through, and counts the bytes left out from its end', async () => {
    const { module } = install({ envFile: `LONG_TOKEN=${'t'.repeat(2_000)}\n` });
    listSecrets(module, 'LONG_TOKEN');
    const answer = await run(module, `head -c 4000 /dev/zero | tr "\\0" a; printf '%s' ${'t'.repeat(2_000)}; head -c 6000 /dev/zero | tr "\\0" b`);
    expect(answer.stdout).toEqual({ bytes: 12_000, text: `${'a'.repeat(4_000)}<LONG_TOKEN>\n[1,904 bytes not shown]\n${'b'.repeat(4_096)}`, cut: true });
  });

  test('gives back whole an output past 8 KiB whose secret runs through both cuts, replaced once, rather than its middle twice', async () => {
    const { module } = install({ envFile: `LONG_TOKEN=${'t'.repeat(2_000)}\n` });
    listSecrets(module, 'LONG_TOKEN');
    const answer = await run(module, `head -c 4000 /dev/zero | tr "\\0" x; printf '%s' ${'t'.repeat(2_000)}; head -c 3000 /dev/zero | tr "\\0" y`);
    expect(answer.stdout).toEqual({ bytes: 9_000, text: `${'x'.repeat(4_000)}<LONG_TOKEN>${'y'.repeat(3_000)}`, cut: false });
  });

  test('cuts a long output of many-byte characters between characters, at 4 KiB each end, and counts the bytes left out', async () => {
    const { module } = install();
    const answer = await run(module, 'for i in $(seq 1 30000); do printf "€"; done');
    expect(answer.stdout.bytes).toBe(90_000);
    expect(answer.stdout.cut).toBe(true);
    const match = /^(.*)\n\[([\d,]+) bytes not shown\]\n(.*)$/s.exec(answer.stdout.text);
    expect(match).not.toBeNull();
    const [, head, hidden, tail] = match!;
    expect(head).toMatch(/^€+$/);
    expect(tail).toMatch(/^€+$/);
    for (const part of [head!, tail!]) {
      expect(Buffer.byteLength(part)).toBeLessThanOrEqual(4 * 1024);
      expect(Buffer.byteLength(part)).toBeGreaterThan(4 * 1024 - 3);
    }
    expect(Number(hidden!.replace(/,/g, '')) + Buffer.byteLength(head!) + Buffer.byteLength(tail!)).toBe(90_000);
  });

  test("gives its commands an environment without the stored secrets or any provider credential the host reads, and replaces those values in what comes back", async () => {
    const { module } = install({
      envFile: 'DISCORD_TOKEN="discord-token-value"\n',
      env: {
        ...PROVIDER_CREDENTIALS, DISCORD_TOKEN: 'discord-token-value', KEEP_ME: 'kept',
        CODEX_HOME: '/home/someone/codex-home', IDENTITY_KEY_FILE: '/home/someone/identity-key.pem',
      },
    });
    listSecrets(module, 'DISCORD_TOKEN');
    const names = [...Object.keys(PROVIDER_CREDENTIALS), 'DISCORD_TOKEN'];
    const answer = await run(module, `env; echo "${Object.values(PROVIDER_CREDENTIALS).join(' ')}"`);
    const lines = answer.stdout.text.split('\n');
    for (const name of names) expect(lines.some((line) => line.startsWith(`${name}=`)), name).toBe(false);
    expect(lines).toContain('KEEP_ME=kept');
    expect(lines).toContain('CODEX_HOME=/home/someone/codex-home');
    expect(lines).toContain('IDENTITY_KEY_FILE=/home/someone/identity-key.pem');
    for (const value of Object.values(PROVIDER_CREDENTIALS)) expect(answer.stdout.text).not.toContain(value);
    expect(lines).toContain(Object.keys(PROVIDER_CREDENTIALS).map((name) => `<${name}>`).join(' '));
  });

  test('leaves out of its commands\' environment a variable of another name holding a stored value whole, and keeps one holding it within a longer value, whose value still comes back by its name', async () => {
    const { module } = install({
      envFile: 'ANTHROPIC_API_KEY="sk-ant-stored-key"\n',
      env: { ANTHROPIC_API_KEY: 'sk-ant-stored-key', MY_COPY: 'sk-ant-stored-key', MY_HEADER: 'Bearer sk-ant-stored-key', KEEP_ME: 'kept' },
    });
    const answer = await run(module, 'printenv MY_COPY; echo "copy=$?"; printenv MY_HEADER; printenv KEEP_ME');
    expect(answer.stdout.text).toBe('copy=1\nBearer <ANTHROPIC_API_KEY>\nkept\n');
  });

  test('leaves out of its commands\' environment a variable of another name holding a stored value trimmed, and keeps an empty one where a stored value is only spaces', async () => {
    const { module } = install({
      envFile: 'MY_SERVER_TOKEN="  custom-token-value  "\nMY_BLANK="   "\n',
      env: { MY_COPY: 'custom-token-value', MY_EMPTY: '' },
    });
    listSecrets(module, 'MY_SERVER_TOKEN', 'MY_BLANK');
    const answer = await run(module, 'printenv MY_COPY; echo "copy=$?"; printenv MY_EMPTY; echo "empty=$?"');
    expect(answer.stdout.text).toBe('copy=1\n\nempty=0\n');
  });

  test('where the list of stored secrets is missing, every name .env or another dotenv file beside it gives that setup doesn\'t know counts as secret, whatever its value, and the answer says why', async () => {
    const { dir, module } = install({
      envFile: 'DISCORD_TOKEN="discord-token-value"\nMY_SERVER_TOKEN="custom-token-value"\nDEBUG=7\n',
      env: { DISCORD_TOKEN: 'discord-token-value', MY_SERVER_TOKEN: 'custom-token-value', DEBUG: '7', KEEP_ME: 'kept' },
    });
    const stripped = await run(module, 'printenv DISCORD_TOKEN; echo "DISCORD_TOKEN=$?"; printenv MY_SERVER_TOKEN; ' +
      'echo "MY_SERVER_TOKEN=$?"; printenv DEBUG; echo "DEBUG=$?"; printenv KEEP_ME');
    expect(stripped.stdout.text).toBe('DISCORD_TOKEN=1\nMY_SERVER_TOKEN=1\nDEBUG=1\nkept\n');
    const answer = await run(module, 'cat .env');
    expect(answer.stdout.text).not.toContain('custom-token-value');
    expect(answer.stdout.text).not.toContain('discord-token-value');
    expect(answer.stdout.text).toContain('DEBUG=<DEBUG>');
    expect(answer.replaced).toEqual(['DEBUG', 'DISCORD_TOKEN', 'MY_SERVER_TOKEN']);
    expect(answer.note).toBe(`${join(dir, '.setup', 'stored-secrets.json')}, the list of the secrets setup stored, is missing, so every name that .env or another dotenv file beside it gives and setup doesn't know counts as secret, and DEBUG, MY_SERVER_TOKEN came back as its name. For values that aren't secret to show, the person writes that file as a JSON list of the name of every secret, those in .env and any the host is given through its environment, such as ["MY_SERVER_TOKEN"], leaving out only names that aren't secret; it takes effect from the host's next start.`);
    listSecrets(module, 'MY_SERVER_TOKEN');
    const again = await run(module, 'cat .env');
    expect(again.stdout.text).toContain('DEBUG=<DEBUG>');
    listSecrets(module, 'MY_SERVER_TOKEN', 'ENV_ONLY_TOKEN');
    const nextStart = `const { SetupModule } = await import(${JSON.stringify(join(import.meta.dir, '..', 'src', 'modules', 'setup-module.ts'))});
      const module = new SetupModule({ dir: ${JSON.stringify(dir)}, env: { PATH: process.env.PATH, HOME: ${JSON.stringify(dir)}, ENV_ONLY_TOKEN: 'env-only-value' }, asker: () => null, show: () => {}, fetch });
      const answer = await module.handleToolCall({ id: 'c1', name: 'run', input: { command: 'cat .env; echo env-only-value; printenv ENV_ONLY_TOKEN || echo stripped' } });
      console.log(JSON.stringify(answer.data));`;
    const after = JSON.parse(Bun.spawnSync([process.execPath, '-e', nextStart]).stdout.toString()) as RunAnswer;
    expect(after.stdout.text).toContain('DEBUG=7');
    expect(after.stdout.text).not.toContain('custom-token-value');
    expect(after.stdout.text).not.toContain('discord-token-value');
    expect(after.stdout.text).toContain('<ENV_ONLY_TOKEN>\nstripped');
    expect(after.note).toBeUndefined();
  });

  test('storing a secret where the list is missing and .env holds a name setup doesn\'t know leaves the list missing, so every such name stays secret, the new one among them', async () => {
    const { dir, module } = install({ envFile: 'MY_SERVER_TOKEN="custom-token-value"\n', asker: { ask: async () => 'a-new-secret-value' } });
    expect((await askSecret(module, { name: 'NEW_TOKEN', purpose: 'x' })).success).toBe(true);
    expect(existsSync(join(dir, '.setup', 'stored-secrets.json'))).toBe(false);
    const answer = await run(module, 'cat .env');
    expect(answer.stdout.text).not.toContain('custom-token-value');
    expect(answer.stdout.text).not.toContain('a-new-secret-value');
    expect(answer.note).toContain('MY_SERVER_TOKEN, NEW_TOKEN came back as its name');
    const later = install({ dir });
    expect((await run(later.module, 'cat .env')).replaced).toEqual(['MY_SERVER_TOKEN', 'NEW_TOKEN']);
  });

  test('storing a secret where the list is missing and .env holds only names setup knows starts the list with it', async () => {
    const { dir, module } = install({ envFile: 'OPENAI_API_KEY="openai-key-value"\n', asker: { ask: async () => 'a-new-secret-value' } });
    expect((await askSecret(module, { name: 'NEW_TOKEN', purpose: 'x' })).success).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, '.setup', 'stored-secrets.json'), 'utf-8'))).toEqual(['NEW_TOKEN']);
  });

  test('where the list can\'t be read, nothing is stored, though .env already holds the same value', async () => {
    for (const typed of ['the-same-value', 'a-new-value']) {
      let list = '';
      const { dir, module } = install({
        envFile: 'NEW_TOKEN="the-same-value"\n',
        asker: { ask: async () => { writeFileSync(list, 'not a list'); return typed; } },
      });
      list = join(dir, '.setup', 'stored-secrets.json');
      listSecrets(module);
      const result = await askSecret(module, { name: 'NEW_TOKEN', purpose: 'x' });
      expect(result.success, typed).toBe(false);
      expect(readFileSync(join(dir, '.env'), 'utf-8'), typed).toBe('NEW_TOKEN="the-same-value"\n');
      expect(result.error, typed).toBe(`Nothing was stored as NEW_TOKEN: ${join(dir, '.setup', 'stored-secrets.json')} isn't the list of the names of the secrets setup stored, such as ["DISCORD_TOKEN"]. Ask the person to put that right, then call again.`);
    }
  });

  test('a list that becomes a link to a list that\'s gone while the person types is refused, and left as it is', async () => {
    let list = '';
    const { dir, module } = install({
      envFile: 'OPENAI_API_KEY="openai-key-value"\n',
      asker: { ask: async () => { rmSync(list); symlinkSync(join(dirname(list), 'gone.json'), list); return 'a-new-value'; } },
    });
    list = join(dir, '.setup', 'stored-secrets.json');
    listSecrets(module);
    const result = await askSecret(module, { name: 'NEW_TOKEN', purpose: 'x' });
    expect(result.success).toBe(false);
    expect(result.error).toStartWith(`Nothing was stored as NEW_TOKEN: ${list} can't be read: ENOENT`);
    expect(lstatSync(list).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(dir, '.env'), 'utf-8')).toBe('OPENAI_API_KEY="openai-key-value"\n');
  });

  test('a link to a list that\'s gone isn\'t taken for no list: setup--run runs nothing', async () => {
    const { dir, module } = install({ envFile: 'MY_SERVER_TOKEN="custom-token-value"\n' });
    mkdirSync(join(dir, '.setup'));
    symlinkSync(join(dir, 'gone.json'), join(dir, '.setup', 'stored-secrets.json'));
    const linked = await runCall(module, 'echo ran > ran.txt');
    expect(linked.success).toBe(false);
    expect(linked.error).toContain(`setup--run ran nothing: ${join(dir, '.setup', 'stored-secrets.json')} can't be read: ENOENT`);
    expect(existsSync(join(dir, 'ran.txt'))).toBe(false);
  });

  modeTest('a list setup can\'t reach isn\'t taken for no list: setup--run runs nothing', async () => {
    const { dir, module } = install({ envFile: 'MY_SERVER_TOKEN="custom-token-value"\n' });
    listSecrets(module, 'MY_SERVER_TOKEN');
    chmodSync(join(dir, '.setup'), 0o000);
    try {
      const unreachable = await runCall(module, 'echo ran > ran.txt');
      expect(unreachable.success).toBe(false);
      expect(unreachable.error).toContain(`setup--run ran nothing: ${join(dir, '.setup', 'stored-secrets.json')} can't be read: EACCES`);
    } finally {
      chmodSync(join(dir, '.setup'), 0o700);
    }
    expect(existsSync(join(dir, 'ran.txt'))).toBe(false);
  });

  test('where the list of stored secrets is there, DISCORD_TOKEN is secret though the list doesn\'t name it, and another name in .env shows as it is', async () => {
    const { module } = install({ envFile: 'DISCORD_TOKEN="discord-token-value"\nDEBUG=7\n' });
    listSecrets(module, 'OTHER_TOKEN');
    const answer = await run(module, 'cat .env');
    expect(answer.stdout.text).toContain('DISCORD_TOKEN="<DISCORD_TOKEN>"');
    expect(answer.stdout.text).toContain('DEBUG=7');
    expect(answer.note).toBeUndefined();
  });

  test("runs with the host's PATH, and no shell startup file brings a stored secret back", async () => {
    const home = scratch();
    const bin = scratch();
    writeFileSync(join(bin, 'only-on-the-hosts-path'), '#!/bin/sh\necho found\n', { mode: 0o755 });
    const reexport = 'export DISCORD_TOKEN=from-a-startup-file\nexport PATH=/usr/bin:/bin\n';
    for (const file of ['.profile', '.bash_profile', '.bash_login', '.bashrc', 'bash-env']) writeFileSync(join(home, file), reexport);
    const { module } = install({
      envFile: 'DISCORD_TOKEN="discord-token-value"\n',
      // As sshd starts a shell, which Debian's bash takes as a reason to read ~/.bashrc.
      env: { HOME: home, PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, BASH_ENV: join(home, 'bash-env'), SSH_CLIENT: '192.0.2.1 50000 22' },
    });
    listSecrets(module, 'DISCORD_TOKEN');
    const answer = await run(module, 'echo "${DISCORD_TOKEN:-none}"; only-on-the-hosts-path');
    expect(answer.stdout.text).toBe('none\nfound\n');
  });

  test('answers with each stored secret replaced by its name, in stdout and stderr, and says it did', async () => {
    const { module } = install({
      envFile: 'DISCORD_TOKEN="discord-token-value"\nANTHROPIC_API_KEY="sk-ant-the-key"\nPORT=8080\n',
      env: { ANTHROPIC_API_KEY: 'sk-ant-the-key' },
    });
    listSecrets(module, 'DISCORD_TOKEN');
    const answer = await run(module, 'cat .env; cat .env >&2');
    expect(answer.stdout.text).toBe('DISCORD_TOKEN="<DISCORD_TOKEN>"\nANTHROPIC_API_KEY="<ANTHROPIC_API_KEY>"\nPORT=8080\n');
    expect(answer.stderr.text).toContain('"<DISCORD_TOKEN>"');
    expect(answer.stdout.text + answer.stderr.text).not.toContain('discord-token-value');
    expect(answer.stdout.text + answer.stderr.text).not.toContain('sk-ant-the-key');
    expect(answer.replaced.sort()).toEqual(['ANTHROPIC_API_KEY', 'DISCORD_TOKEN']);
  });

  test('replaces a stored secret as each of its lines in .env spells it, single-quoted with a space and a # too', async () => {
    const { module } = install({ envFile: "SERVICE_PASSWORD='old password#private-tail'\nSERVICE_PASSWORD=current-password\n" });
    listSecrets(module, 'SERVICE_PASSWORD');
    const answer = await run(module, 'cat .env');
    expect(answer.stdout.text).toBe("SERVICE_PASSWORD='<SERVICE_PASSWORD>'\nSERVICE_PASSWORD=<SERVICE_PASSWORD>\n");
  });

  test('runs nothing while .env holds a line outside setup\'s form, a secret\'s or another, naming the first and counting the rest, and nothing of any', async () => {
    for (const [envFile, line, why, others] of [
      ['DISCORD_TOKEN="first-half\nsecond-half"\nNOTE="a note\nover two lines"\n', 1, WHY.value, 3],
      ['A=one\nNOTE=`a note`\nDISCORD_TOKEN=first-half\n', 2, WHY.value, 0],
      ['DISCORD_TOKEN=first-half\r\nA=one\r\n', 1, WHY.control, 1],
      ['A=one\nexport DISCORD_TOKEN=first-half\n', 2, WHY.start, 0],
    ] as const) {
      const { dir, module } = install({ envFile });
      listSecrets(module, 'DISCORD_TOKEN');
      const result = await runCall(module, 'touch ran; cat .env');
      expect(result.isError, envFile).toBe(true);
      expect(result.error, envFile).toBe(`setup--run ran nothing: ${outside(join(dir, '.env'), line, why, others)}. While .env holds such a line, what Bun reads from it, and so what a command prints of a secret, isn't known, so ask the person to put that right; you can't, since setup--run runs nothing meanwhile.`);
      for (const part of ['first-half', 'second-half', 'a note', 'over two']) expect(JSON.stringify(result), envFile).not.toContain(part);
      expect(existsSync(join(dir, 'ran')), envFile).toBe(false);
    }
  });

  test('gives back none of a command\'s output when .env comes to hold a line outside setup\'s form while it runs', async () => {
    const { dir, module } = install({ envFile: 'DISCORD_TOKEN=first-half\n' });
    listSecrets(module, 'DISCORD_TOKEN');
    const result = await runCall(module, `touch ran; printf 'DISCORD_TOKEN="first-half\\nsecond-half"\\n' > .env; echo printed-line; cat .env`);
    expect(existsSync(join(dir, 'ran'))).toBe(true);
    expect(result.isError).toBe(true);
    expect(result.error).toContain(outside(join(dir, '.env'), 1, WHY.value, 1));
    for (const part of ['printed-line', 'first-half', 'second-half']) expect(JSON.stringify(result)).not.toContain(part);
  });

  test('gives back none of a command\'s output when what setup reads of its secrets can\'t be read once it ends, and says why', async () => {
    const { dir, module } = install({ envFile: 'MY_SERVER_TOKEN="custom-token-value"\n' });
    listSecrets(module, 'MY_SERVER_TOKEN');
    const list = join(dir, '.setup', 'stored-secrets.json');
    const result = await runCall(module, `rm ${list}; ln -s gone.json ${list}; echo word-it-printed`);
    expect(result.success).toBe(false);
    expect(result.error).toStartWith(`setup--run's command ended (exit 0), and its output isn't shown: ${list} can't be read: ENOENT`);
    expect(JSON.stringify(result)).not.toContain('word-it-printed');
  });

  test('a dotenv file, the list of stored secrets, setup\'s state or the host\'s package.json that is a named pipe is refused rather than read, so each read answers', () => {
    const dir = scratch();
    const child = join(dir, 'child.ts');
    writeFileSync(child, `
      import { mkdirSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { pathToFileURL } from 'node:url';
      import { hostVersionOf } from ${JSON.stringify(join(import.meta.dir, '..', 'src', 'update', 'update.ts'))};
      import { SetupModule } from ${JSON.stringify(join(import.meta.dir, '..', 'src', 'modules', 'setup-module.ts'))};
      const answers = [];
      for (const [name, pipeFirst, command] of [
        ['before', true, 'echo ran'],
        ['after', false, 'mkfifo .env.local; echo word-it-printed'],
        ['list', false, 'mkdir -p .setup; rm -f .setup/stored-secrets.json; mkfifo .setup/stored-secrets.json; echo word-it-printed'],
      ]) {
        const at = join(${JSON.stringify(dir)}, name);
        mkdirSync(at);
        writeFileSync(join(at, '.env'), 'MY_SERVER_TOKEN="custom-token-value"\\n', { mode: 0o600 });
        if (pipeFirst) Bun.spawnSync(['mkfifo', join(at, '.env.local')]);
        const module = new SetupModule({ dir: at, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: at },
          asker: () => null, show: () => {}, fetch: async () => new Response('{}') });
        const result = await module.handleToolCall({ id: 'c1', name: 'run', input: { command } });
        answers.push({ name, success: result.success, error: result.error, data: result.data ?? null });
      }
      {
        const at = join(${JSON.stringify(dir)}, 'state');
        mkdirSync(join(at, '.setup'), { recursive: true });
        Bun.spawnSync(['mkfifo', join(at, '.setup', 'setup-state.json')]);
        const module = new SetupModule({ dir: at, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: at },
          asker: () => null, show: () => {}, fetch: async () => new Response('{}') });
        const result = await module.handleToolCall({ id: 'f1', name: 'finished', input: {} });
        answers.push({ name: 'state', success: result.success, error: result.error, data: result.data ?? null });
      }
      {
        const pipe = join(${JSON.stringify(dir)}, 'package.json');
        Bun.spawnSync(['mkfifo', pipe]);
        let error = null;
        try {
          hostVersionOf(pathToFileURL(pipe));
        } catch (thrown) {
          error = thrown.message;
        }
        answers.push({ name: 'package', success: error === null, error, data: null });
      }
      console.log(JSON.stringify(answers));
      process.exit(0);
    `);
    const ran = Bun.spawnSync([process.execPath, child], { timeout: 10_000, killSignal: 'SIGKILL', stderr: 'pipe' });
    expect({ exitCode: ran.exitCode, signal: ran.signalCode ?? null }, ran.stderr.toString()).toEqual({ exitCode: 0, signal: null });
    const [before, after, list, state, pkg] = JSON.parse(ran.stdout.toString()) as Array<{ name: string; success: boolean; error?: string; data: unknown }>;
    expect(before!.success).toBe(false);
    expect(before!.error).toStartWith(`setup--run ran nothing: ${join(dir, 'before', '.env.local')} can't be read (it isn't a file)`);
    expect(after!.success).toBe(false);
    expect(after!.error).toStartWith(`setup--run's command ended (exit 0), and its output isn't shown: ${join(dir, 'after', '.env.local')} can't be read (it isn't a file)`);
    expect(JSON.stringify(after)).not.toContain('word-it-printed');
    expect(list!.success).toBe(false);
    expect(list!.error).toStartWith(`setup--run's command ended (exit 0), and its output isn't shown: ${join(dir, 'list', '.setup', 'stored-secrets.json')} can't be read: it isn't a file`);
    expect(JSON.stringify(list)).not.toContain('word-it-printed');
    expect(state!.success).toBe(false);
    expect(state!.error).toStartWith(`${join(dir, 'state', '.setup', 'setup-state.json')} can't be read (it isn't a file), so nothing was recorded`);
    expect(pkg).toEqual({ name: 'package', success: false, error: `${join(dir, 'package.json')} can't be read (it isn't a file)`, data: null });
  }, 20_000);

  test('replaces a secret stored while its command was running', async () => {
    const { dir, module } = install({ asker: { ask: async () => 'stored-mid-run-value' } });
    const flag = join(dir, 'stored');
    const pending = run(module, `touch started; while [ ! -e ${flag} ]; do sleep 0.02; done; cat .env`);
    for (const begun = performance.now(); !existsSync(join(dir, 'started')) && performance.now() - begun < 10_000; await Bun.sleep(10));
    expect(existsSync(join(dir, 'started'))).toBe(true);
    expect((await askSecret(module, { name: 'DISCORD_TOKEN', purpose: 'the bot token' })).success).toBe(true);
    writeFileSync(flag, '');
    const answer = await pending;
    expect(answer.stdout.text).toBe('DISCORD_TOKEN="<DISCORD_TOKEN>"\n');
  });

  test("leaves no part of a secret where the long output's head or tail is cut", async () => {
    const secret = 'x'.repeat(40) + 'tail-of-the-secret';
    const { module } = install({ envFile: `LONG_SECRET="${secret}"\n` });
    listSecrets(module, 'LONG_SECRET');
    const answer = await run(module, `s=$(grep -o 'x*tail-of-the-secret' .env); for i in $(seq 1 4000); do printf '%s%s' "$i" "$s"; done`);
    expect(answer.stdout.cut).toBe(true);
    expect(answer.replaced).toEqual(['LONG_SECRET']);
    const left = answer.stdout.text.replace(/\n\[[\d,]+ bytes not shown\]\n/, '').replace(/<LONG_SECRET>/g, '').replace(/\d/g, '');
    expect(left).toMatch(/^[<LONGSECRT_>]*$/);
  });

  test("runs nothing while the list of stored secrets is damaged, and says which file", async () => {
    for (const damaged of ['["DISCORD_TO', '[42]', '["1TOKEN"]', '["DISCORD_TOKEN", "NOT A NAME"]']) {
      const { dir, module } = install({ envFile: 'DISCORD_TOKEN="discord-token-value"\n' });
      mkdirSync(join(dir, '.setup'));
      writeFileSync(join(dir, '.setup', 'stored-secrets.json'), damaged);
      const result = await runCall(module, 'touch ran; cat .env');
      expect(result.success, damaged).toBe(false);
      expect(result.isError, damaged).toBe(true);
      expect(result.error, damaged).toContain(join(dir, '.setup', 'stored-secrets.json'));
      expect(existsSync(join(dir, 'ran')), damaged).toBe(false);
    }
  });

  test('a new module on the same install still replaces the secrets an earlier one stored', async () => {
    const { dir, module } = install({ asker: { ask: async () => 'stored-by-the-first' } });
    expect((await askSecret(module, { name: 'DISCORD_TOKEN', purpose: 'the bot token' })).success).toBe(true);
    const again = install({ dir });
    const answer = await run(again.module, 'cat .env');
    expect(answer.stdout.text).toBe('DISCORD_TOKEN="<DISCORD_TOKEN>"\n');
  });

  test('replaces a value known at launch and then replaced while its command ran', async () => {
    const values = ['first-stored-value', 'second-stored-value'];
    const { dir, module } = install({ asker: { ask: async () => values.shift() ?? null } });
    const [one, done, two] = ['one', 'done', 'two'].map((name) => join(dir, name));
    const pending = run(module, `while [ ! -e ${one} ]; do sleep 0.02; done; cat .env > snapshot; touch ${done}; while [ ! -e ${two} ]; do sleep 0.02; done; cat snapshot`);
    expect((await askSecret(module, { name: 'DISCORD_TOKEN', purpose: 'x' })).success).toBe(true);
    writeFileSync(one, '');
    for (const until = performance.now() + 10_000; !existsSync(done) && performance.now() < until;) await Bun.sleep(10);
    expect(existsSync(done)).toBe(true);
    expect((await askSecret(module, { name: 'DISCORD_TOKEN', purpose: 'x' })).success).toBe(true);
    writeFileSync(two, '');
    const answer = await pending;
    expect(answer.stdout.text).toBe('DISCORD_TOKEN="<DISCORD_TOKEN>"\n');
  });

  test('replaces a value stored and then replaced while its command ran', async () => {
    const values = ['first-stored-value', 'second-stored-value'];
    const { dir, module } = install({ asker: { ask: async () => values.shift() ?? null } });
    const [started, one, done, two] = ['started', 'one', 'done', 'two'].map((name) => join(dir, name));
    const pending = run(module, `touch ${started}; while [ ! -e ${one} ]; do sleep 0.02; done; cat .env > snapshot; touch ${done}; while [ ! -e ${two} ]; do sleep 0.02; done; cat snapshot`);
    for (const until = performance.now() + 10_000; !existsSync(started) && performance.now() < until;) await Bun.sleep(10);
    expect(existsSync(started)).toBe(true);
    expect((await askSecret(module, { name: 'DISCORD_TOKEN', purpose: 'x' })).success).toBe(true);
    writeFileSync(one, '');
    for (const until = performance.now() + 10_000; !existsSync(done) && performance.now() < until;) await Bun.sleep(10);
    expect(existsSync(done)).toBe(true);
    expect((await askSecret(module, { name: 'DISCORD_TOKEN', purpose: 'x' })).success).toBe(true);
    writeFileSync(two, '');
    const answer = await pending;
    expect(answer.stdout.text).toBe('DISCORD_TOKEN="<DISCORD_TOKEN>"\n');
  });

  test('keeps replacing a secret an earlier host stored, and keeping it from its commands, after its list is removed while this host runs', async () => {
    const { dir, module } = install({
      envFile: 'DISCORD_TOKEN="stored-by-an-earlier-host"\n', env: { DISCORD_TOKEN: 'stored-by-an-earlier-host' },
    });
    listSecrets(module, 'DISCORD_TOKEN');
    expect((await run(module, 'cat .env')).stdout.text).toBe('DISCORD_TOKEN="<DISCORD_TOKEN>"\n');
    rmSync(join(dir, '.setup', 'stored-secrets.json'));
    const answer = await run(module, 'echo "${DISCORD_TOKEN:-none}"; cat .env');
    expect(answer.stdout.text).toBe('none\nDISCORD_TOKEN="<DISCORD_TOKEN>"\n');
  });

  test('keeps replacing a secret this host stored and then replaced, in a new module too', async () => {
    const values = ['first stored #value', 'second-stored-value'];
    const { dir, module } = install({ asker: { ask: async () => values.shift() ?? null } });
    expect((await askSecret(module, { name: 'DISCORD_TOKEN', purpose: 'x' })).success).toBe(true);
    await run(module, 'cp .env backup');
    expect((await askSecret(module, { name: 'DISCORD_TOKEN', purpose: 'x' })).success).toBe(true);
    expect((await run(module, 'cat backup')).stdout.text).toBe('DISCORD_TOKEN="<DISCORD_TOKEN>"\n');
    const again = install({ dir });
    expect((await run(again.module, 'cat backup')).stdout.text).toBe('DISCORD_TOKEN="<DISCORD_TOKEN>"\n');
  });

  test('keeps replacing a secret listed when ask_secret stored another, after the list is removed', async () => {
    const { dir, module } = install({ envFile: 'DISCORD_TOKEN="stored-by-an-earlier-host"\n', asker: { ask: async () => 'another-value' } });
    listSecrets(module, 'DISCORD_TOKEN');
    expect((await askSecret(module, { name: 'OTHER_TOKEN', purpose: 'x' })).success).toBe(true);
    rmSync(join(dir, '.setup', 'stored-secrets.json'));
    expect((await run(module, 'cat .env')).stdout.text).toBe('DISCORD_TOKEN="<DISCORD_TOKEN>"\nOTHER_TOKEN="<OTHER_TOKEN>"\n');
  });

  test('keeps replacing a value ask_secret replaced in .env, though nothing had read it before, listed or not', async () => {
    for (const listed of [true, false]) {
      const { dir, module } = install({ envFile: 'DISCORD_TOKEN="listed-old-value"\n', asker: { ask: async () => 'the-new-value' } });
      if (listed) listSecrets(module, 'DISCORD_TOKEN');
      writeFileSync(join(dir, 'backup'), 'listed-old-value\n');
      expect((await askSecret(module, { name: 'DISCORD_TOKEN', purpose: 'x' })).success).toBe(true);
      expect(readEnvFile(join(dir, '.env')).get('DISCORD_TOKEN')).toBe('the-new-value');
      expect((await run(module, 'cat backup .env')).stdout.text, String(listed)).toBe('<DISCORD_TOKEN>\nDISCORD_TOKEN="<DISCORD_TOKEN>"\n');
    }
  });

  test('keeps replacing a value it read from .env after a command changes it there', async () => {
    const { dir, module } = install({ envFile: 'DISCORD_TOKEN="first-read-value"\n' });
    listSecrets(module, 'DISCORD_TOKEN');
    await run(module, 'cp .env backup; sed s/first-read-value/second-read-value/ backup > .env');
    expect(readEnvFile(join(dir, '.env')).get('DISCORD_TOKEN')).toBe('second-read-value');
    expect((await run(module, 'cat backup .env')).stdout.text).toBe('DISCORD_TOKEN="<DISCORD_TOKEN>"\nDISCORD_TOKEN="<DISCORD_TOKEN>"\n');
  });

  test('names every secret whose value it replaced, two names with one value too', async () => {
    const { module } = install({ envFile: 'FIRST_TOKEN="one-shared-value"\nSECOND_TOKEN="one-shared-value"\n' });
    listSecrets(module, 'FIRST_TOKEN', 'SECOND_TOKEN');
    const answer = await run(module, 'echo one-shared-value');
    expect(answer.stdout.text).toBe('<FIRST_TOKEN>\n');
    expect(answer.replaced).toEqual(['FIRST_TOKEN', 'SECOND_TOKEN']);
  });

  test('replaces two stored values that overlap in the output, all of both', async () => {
    const { module } = install({ envFile: 'FIRST_TOKEN="abcdef123"\nSECOND_TOKEN="123ghijkl"\n' });
    listSecrets(module, 'FIRST_TOKEN', 'SECOND_TOKEN');
    const answer = await run(module, 'echo "x-abcdef123ghijkl-y"');
    expect(answer.stdout.text).toBe('x-<FIRST_TOKEN>-y\n');
    expect(answer.replaced).toEqual(['FIRST_TOKEN', 'SECOND_TOKEN']);
  });

  test("withholds a command's output when the list of stored secrets is damaged while it runs", async () => {
    const { dir, module } = install({ asker: { ask: async () => 'a-stored-secret' } });
    expect((await askSecret(module, { name: 'DISCORD_TOKEN', purpose: 'x' })).success).toBe(true);
    const result = await runCall(module, 'touch ran; echo broken > .setup/stored-secrets.json; cat .env');
    expect(existsSync(join(dir, 'ran'))).toBe(true);
    expect(readFileSync(join(dir, '.setup', 'stored-secrets.json'), 'utf-8')).toBe('broken\n');
    expect(result.success).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.error).toContain(join(dir, '.setup', 'stored-secrets.json'));
    expect(JSON.stringify(result)).not.toContain('a-stored-secret');
  });

  linuxTest('what an ended command left running keeps running once the module stops, and commands after are refused', async () => {
    const { dir, module } = install();
    const pidFile = join(dir, 'left.pid');
    let left = 0;
    try {
      await run(module, `sleep 60 > /dev/null 2>&1 & echo $! > ${pidFile}`);
      left = Number(readFileSync(pidFile, 'utf-8'));
      await module.stop();
      expect(processEnded(left)).toBe(false);
      const after = await runCall(module, 'touch ran');
      expect(after.isError).toBe(true);
      expect(after.error).toContain('won\'t change that');
      expect(existsSync(join(dir, 'ran'))).toBe(false);
    } finally {
      if (left) try { process.kill(left, 'SIGKILL'); } catch {}
    }
  }, 20_000);

  linuxTest('stopping the module kills what outlives its SIGTERM 5 s on by elapsed time, whatever the wall clock does', async () => {
    const { dir, module } = install();
    const pidFile = join(dir, 'stubborn.pid');
    const pending = run(module, `trap '' TERM; sleep 60 & echo $! > ${pidFile}; sleep 60`);
    const stubborn = Number(await waitForFile(pidFile));
    const frozen = spyOn(Date, 'now').mockReturnValue(Date.now());
    let stoppedInTime: boolean;
    try {
      stoppedInTime = await Promise.race([module.stop().then(() => true), Bun.sleep(15_000).then(() => false)]);
    } finally {
      frozen.mockRestore();
    }
    expect(stoppedInTime).toBe(true);
    expect((await pending).signal).toBe('SIGKILL');
    expect(await waitForEnd(stubborn, 3_000)).toBe(true);
  }, 30_000);

  test('a command asked for while a secret is asked for waits for each secret asked for after it too, so nothing it does is shown while the person types', async () => {
    const answers: Array<(value: string) => void> = [];
    const made = install({ asker: { ask: () => new Promise<string>((resolve) => { answers.push(resolve); }) } });
    const first = askSecret(made.module, { name: 'FIRST_TOKEN', purpose: 'a token' });
    const ran = runCall(made.module, 'touch ran');
    const second = askSecret(made.module, { name: 'SECOND_TOKEN', purpose: 'a token' });
    const reached = heldAt(made.module);
    while (answers.length < 1) await Bun.sleep(1);
    answers[0]!('first-value');
    await Promise.race([reached, ran.then(() => { throw new Error('the command ran without waiting for the second question'); })]);
    while (answers.length < 2) await Bun.sleep(1);
    expect(made.shown.filter((line) => line.startsWith('Setup\'s agent runs'))).toEqual([]);
    answers[1]!('second-value');
    expect((await first).success).toBe(true);
    expect((await second).success).toBe(true);
    expect((await ran).success).toBe(true);
    expect(existsSync(join(made.dir, 'ran'))).toBe(true);
  });

  linuxTest('stopping the module stops a command still running, every process in its group, one that ignores SIGTERM too', async () => {
    const { dir, module } = install();
    const pidFile = join(dir, 'stubborn.pid');
    const pending = run(module, `trap '' TERM; sleep 60 & echo $! > ${pidFile}; sleep 60`);
    const stubborn = Number(await waitForFile(pidFile));
    const stopping = performance.now();
    await module.stop();
    expect(performance.now() - stopping).toBeGreaterThanOrEqual(4_900);
    const answer = await pending;
    expect(answer.signal).toBe('SIGKILL');
    expect(await waitForEnd(stubborn, 3_000)).toBe(true);
  }, 20_000);
  test('a command still running, or still being stopped, when its host process ends goes with it: at an uncaught error, an exit, a SIGHUP, a SIGINT and a SIGTERM, and at a SIGINT while stop() waits on a process that outlived its SIGTERM; the host still ends as it was ended; and a process left by a command that ended before keeps running', async () => {
    const dir = scratch();
    const script = join(dir, 'host.ts');
    writeFileSync(script, `const { SetupModule } = await import(${JSON.stringify(join(import.meta.dir, '..', 'src', 'modules', 'setup-module.ts'))});
const module = new SetupModule({ dir: ${JSON.stringify(dir)}, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, asker: () => null, show: () => {} });
const [how, seconds] = process.argv.slice(2);
const command = how === 'stop' ? "(trap '' TERM; exec sleep " + seconds + ") & wait"
  : how === 'leftover' ? "sleep " + seconds + " > /dev/null 2>&1 & echo started"
  : "trap '' TERM HUP INT; sleep " + seconds;
void module.handleToolCall({ id: 'c', name: 'run', input: { command } }).then(() => console.log('answered'));
process.stdin.on('data', () => {
  if (how === 'crash') throw new Error('a crash');
  if (how === 'exit') process.exit(3);
  if (how === 'leftover') process.exit(0);
  if (how === 'stop') {
    void module.stop();
    console.log('stopping');
  }
});
setInterval(() => {}, 1000);
`);
    const found = (pattern: string) => Bun.spawnSync(['pgrep', '-f', pattern]).stdout.toString().trim();
    const until = async (check: () => boolean, ms: number) => {
      for (const started = performance.now(); !check() && performance.now() - started < ms; await new Promise((done) => setTimeout(done, 25)));
      return check();
    };
    const left: string[] = [];
    const hosts: Array<ReturnType<typeof Bun.spawn>> = [];
    try {
      for (const how of ['crash', 'exit', 'SIGHUP', 'SIGINT', 'SIGTERM', 'stop', 'leftover'] as const) {
        const seconds = String(1000 + Math.floor(Math.random() * 90_000));
        left.push(seconds);
        const sleeping = () => found(`^sleep ${seconds}$`) !== '';
        const host = Bun.spawn([process.execPath, script, how, seconds], { cwd: dir, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
        hosts.push(host);
        let said = '';
        void (async () => {
          for await (const chunk of host.stdout as ReadableStream<Uint8Array>) said += new TextDecoder().decode(chunk);
        })();
        expect(await until(sleeping, 15_000), how).toBe(true);
        if (how === 'leftover') expect(await until(() => said.includes('answered'), 10_000), how).toBe(true);
        if (how.startsWith('SIG')) host.kill(how);
        else {
          host.stdin.write('go\n');
          host.stdin.flush();
        }
        if (how === 'stop') {
          expect(await until(() => said.includes('stopping'), 4_500), how).toBe(true);
          expect(sleeping(), how).toBe(true);
          host.kill('SIGINT');
        }
        const killer = setTimeout(() => host.kill('SIGKILL'), 10_000);
        await host.exited;
        clearTimeout(killer);
        if (how === 'crash') expect(host.exitCode, how).toBe(1);
        else if (how === 'exit') expect(host.exitCode, how).toBe(3);
        else if (how === 'leftover') expect(host.exitCode, how).toBe(0);
        else expect(host.signalCode, how).toBe(how === 'stop' ? 'SIGINT' : how);
        if (how === 'leftover') expect(await until(() => !sleeping(), 1_000), how).toBe(false);
        else expect(await until(() => !sleeping(), 3_000), how).toBe(true);
      }
    } finally {
      for (const host of hosts) if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL');
      for (const seconds of left) Bun.spawnSync(['pkill', '-KILL', '-f', `^sleep ${seconds}$`]);
    }
  }, 90_000);
});

describe('setup--run, and what the install\'s commands say for the person', () => {
  const afterCommand = (shown: string[]) => shown.slice(shown.findIndex((line) => line === 'Setup\'s agent runs:') + 2);

  test('what a command writes to the file CONNECTOME_SETUP_SHOWN names is shown once it ends, however the command is written', async () => {
    const { module, shown } = install();
    const answer = await run(module, 'cd / && sh -c \'printf "for the person\\nand a second line\\n" >> "$CONNECTOME_SETUP_SHOWN"\' | cat; echo for the agent');
    expect(answer.stdout.text).toBe('for the agent\n');
    expect(afterCommand(shown)).toEqual(['It said:', '  for the person', '  and a second line']);
  });

  test('a command that writes nothing there shows nothing after its own line', async () => {
    const { module, shown } = install();
    await run(module, 'echo for the agent only');
    expect(afterCommand(shown)).toEqual([]);
  });

  test('each command gets a fresh, empty file, gone once the command is answered', async () => {
    const { module, shown } = install();
    const first = await run(module, 'echo "$CONNECTOME_SETUP_SHOWN"; echo first >> "$CONNECTOME_SETUP_SHOWN"');
    const second = await run(module, 'echo "$CONNECTOME_SETUP_SHOWN"; wc -c < "$CONNECTOME_SETUP_SHOWN"');
    const [firstFile] = first.stdout.text.split('\n');
    const [secondFile, size] = second.stdout.text.split('\n');
    expect(firstFile).not.toBe('');
    expect(secondFile).not.toBe(firstFile);
    expect(size!.trim()).toBe('0');
    expect(existsSync(firstFile!)).toBe(false);
    expect(existsSync(secondFile!)).toBe(false);
    expect(shown.filter((line) => line === '  first')).toHaveLength(1);
  });

  test('what is shown hides a stored secret by its name, as the agent\'s copy does, and shows a control character as a code', async () => {
    const { module, shown } = install({ envFile: 'DISCORD_TOKEN="the-stored-value"\n' });
    listSecrets(module, 'DISCORD_TOKEN');
    await run(module, 'printf "token the-stored-value\\n\\033[31mred\\n" >> "$CONNECTOME_SETUP_SHOWN"');
    expect(afterCommand(shown)).toEqual(['It said:', '  token <DISCORD_TOKEN>', '  \\u001b[31mred']);
  });

  test('a file the command took away is said to be unreadable, naming it', async () => {
    const { module, shown } = install();
    const answer = await run(module, 'echo "$CONNECTOME_SETUP_SHOWN"; echo gone >> "$CONNECTOME_SETUP_SHOWN"; rm "$CONNECTOME_SETUP_SHOWN"');
    const [file] = answer.stdout.text.split('\n');
    const after = afterCommand(shown);
    expect(after).toHaveLength(1);
    expect(after[0]).toContain(file!);
    expect(after.join('\n')).not.toContain('gone');
  });

  test('a command stopped at its limit after writing there ends with a line saying it didn\'t finish', async () => {
    const { module, shown } = install();
    await run(module, 'echo started >> "$CONNECTOME_SETUP_SHOWN"; sleep 30', 1000);
    expect(afterCommand(shown)).toEqual(['It said:', '  started', 'It didn\'t finish: it was stopped at its 1 s limit.']);
  });

  test('a command ended by a signal after writing there ends with a line saying so, and one that wrote nothing shows nothing', async () => {
    const { module, shown } = install();
    await run(module, 'echo started >> "$CONNECTOME_SETUP_SHOWN"; kill -TERM $$');
    expect(afterCommand(shown)).toEqual(['It said:', '  started', 'It didn\'t finish: it was ended by SIGTERM.']);
    const quiet = install();
    await run(quiet.module, 'kill -TERM $$');
    expect(afterCommand(quiet.shown)).toEqual([]);
  });

  test('a named pipe left where the file for the person was is refused as no file, and the command is answered', async () => {
    const { dir, module, shown } = install();
    const [at, go] = [join(dir, 'pipe-at'), join(dir, 'go')];
    const answering = run(module, `rm "$CONNECTOME_SETUP_SHOWN" && mkfifo "$CONNECTOME_SETUP_SHOWN" && echo "$CONNECTOME_SETUP_SHOWN" > ${at}.new && mv ${at}.new ${at} && while [ ! -e ${go} ]; do sleep 0.02; done; echo for the agent`);
    let writer: ReturnType<typeof Bun.spawn> | undefined;
    try {
      for (const started = performance.now(); !existsSync(at) && performance.now() - started < 10_000; await Bun.sleep(10));
      // Where a read waits on the pipe, this writer gives it a line, so the test ends either way.
      writer = Bun.spawn(['sh', '-c', 'while [ -p "$1" ]; do printf "written-to-the-pipe\\n" > "$1"; done', 'sh', readFileSync(at, 'utf-8').trim()], { stdout: 'ignore', stderr: 'ignore' });
      writeFileSync(go, '');
      const answer = await answering;
      expect(answer.stdout.text).toBe('for the agent\n');
      const after = afterCommand(shown);
      expect(after).toHaveLength(1);
      expect(after[0]).toMatch(/^What it said for you can't be shown: .+ can't be read \(it isn't a file\)\.$/);
    } finally {
      writeFileSync(go, '');
      await answering.catch(() => {});
      writer?.kill('SIGKILL');
    }
  }, 20_000);

  test('where which values are secret can\'t be read once the command ends, nothing it wrote there is shown, and the person is told', async () => {
    const { module, shown } = install({ envFile: 'DISCORD_TOKEN="the-stored-value"\n' });
    const result = await runCall(module, 'echo written-for-the-person >> "$CONNECTOME_SETUP_SHOWN"; mkdir .env.local');
    expect(result.success).toBe(false);
    expect(afterCommand(shown)).toEqual(['What it said for you isn\'t shown, since which values are secret isn\'t known.']);
  });
});

describe('setup--ask_secret with a DISCORD_TOKEN', () => {
  const typed = (value: string) => ({ ask: async () => value });
  const said = (module: ReturnType<typeof install>, result: ToolResult) => `${String(result.data ?? '')} ${result.error ?? ''} ${module.shown.join('\n')}`;

  test('asks Discord who the token belongs to before storing it, and stores it once Discord accepts it, naming the bot to the agent and on the terminal', async () => {
    const requests: Array<{ url: string; method: string; headers: Headers }> = [];
    const made = install({
      asker: typed('the-bot-token'),
      fetch: (async (url: string, init: RequestInit) => {
        requests.push({ url: String(url), method: init.method ?? 'GET', headers: new Headers(init.headers) });
        return Response.json({ id: '123', username: 'wren-bot' });
      }) as unknown as typeof fetch,
    });
    const result = await askSecret(made.module, { name: 'DISCORD_TOKEN', purpose: 'the bot token' });
    expect(result.success, result.error).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('https://discord.com/api/v10/users/@me');
    expect(requests[0]!.method).toBe('GET');
    expect(requests[0]!.headers.get('authorization')).toBe('Bot the-bot-token');
    expect(requests[0]!.headers.get('user-agent')).toStartWith('DiscordBot (https://github.com/anima-research/connectome-host, ');
    expect(String(result.data)).toBe(`stored as DISCORD_TOKEN in ${join(made.dir, '.env')}. Discord accepted it: the bot is wren-bot (123).`);
    expect(readEnvFile(join(made.dir, '.env')).get('DISCORD_TOKEN')).toBe('the-bot-token');
    expect(made.shown).toEqual(['Checking it with Discord.', 'Discord accepted it: the bot is wren-bot.']);
    expect(said(made, result)).not.toContain('the-bot-token');
  });

  test('stores nothing when Discord refuses the token, leaving what was stored before, and says so to the agent and on the terminal', async () => {
    const made = install({
      envFile: 'DISCORD_TOKEN="the-old-token"\n',
      asker: typed('a-refused-token'),
      fetch: (async () => Response.json({ message: '401: Unauthorized', code: 0 }, { status: 401 })) as unknown as typeof fetch,
    });
    const result = await askSecret(made.module, { name: 'DISCORD_TOKEN', purpose: 'the bot token' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Discord refused this token (401), so nothing was stored as DISCORD_TOKEN, and what was stored as it before stays as it was. Tell the person, and ask them to copy it again from their application\'s Bot page in the Discord Developer Portal (Reset Token there makes a new one), then call again.');
    expect(readEnvFile(join(made.dir, '.env')).get('DISCORD_TOKEN')).toBe('the-old-token');
    expect(made.shown).toEqual(['Checking it with Discord.', 'Discord refused it (401): nothing was stored.']);
    expect(said(made, result)).not.toContain('a-refused-token');
  });

  test('stores a token Discord answered otherwise, other than a 429 or 5xx, or couldn\'t be asked about, saying it isn\'t known to work and why, and to ask for it again or go on with it unchecked, never with the token in the words', async () => {
    const answered = install({
      asker: typed('token-one'),
      fetch: (async () => Response.json({ message: 'Missing Access' }, { status: 403 })) as unknown as typeof fetch,
    });
    const first = await askSecret(answered.module, { name: 'DISCORD_TOKEN', purpose: 'the bot token' });
    expect(String(first.data)).toBe(`stored as DISCORD_TOKEN in ${join(answered.dir, '.env')}, but it isn't known to work: Discord answered 403: Missing Access. Ask for it again with setup--ask_secret to check it again, or go on with it unchecked.`);
    expect(answered.shown).toEqual(['Checking it with Discord.', 'Discord didn\'t say whether it works: it answered 403 (Missing Access).', 'It\'s stored as DISCORD_TOKEN, though whether it works isn\'t known.']);
    expect(readEnvFile(join(answered.dir, '.env')).get('DISCORD_TOKEN')).toBe('token-one');
    const unasked = install({
      asker: typed('token-two'),
      fetch: (async () => { throw new Error('connect ECONNREFUSED, sending Bot token-two'); }) as unknown as typeof fetch,
    });
    const second = await askSecret(unasked.module, { name: 'DISCORD_TOKEN', purpose: 'the bot token' });
    expect(String(second.data)).toBe(`stored as DISCORD_TOKEN in ${join(unasked.dir, '.env')}, but it isn't known to work: Discord couldn't be asked (connect ECONNREFUSED, sending Bot <DISCORD_TOKEN>). Ask for it again with setup--ask_secret to check it again, or go on with it unchecked.`);
    expect(unasked.shown).toEqual(['Checking it with Discord.', 'Discord couldn\'t be asked whether it works (connect ECONNREFUSED, sending Bot <DISCORD_TOKEN>).', 'It\'s stored as DISCORD_TOKEN, though whether it works isn\'t known.']);
    expect(readEnvFile(join(unasked.dir, '.env')).get('DISCORD_TOKEN')).toBe('token-two');
    expect(said(unasked, second)).not.toContain('token-two');
    const trimmed = install({
      asker: typed(' token-three  '),
      fetch: (async () => { throw new Error('rejected header: Bot token-three'); }) as unknown as typeof fetch,
    });
    const third = await askSecret(trimmed.module, { name: 'DISCORD_TOKEN', purpose: 'the bot token' });
    expect(said(trimmed, third)).not.toContain('token-three');
    expect(String(third.data)).toContain('rejected header: Bot <DISCORD_TOKEN>');
  });

  test('stores nothing, and asks Discord nothing, for a token a request header can\'t carry, leaving what was stored before', async () => {
    let called = 0;
    const made = install({
      envFile: 'DISCORD_TOKEN="the-old-token"\n',
      asker: typed('a-token\u2028broken'),
      fetch: (async () => { called += 1; return Response.json({ id: '1', username: 'x' }); }) as unknown as typeof fetch,
    });
    const result = await askSecret(made.module, { name: 'DISCORD_TOKEN', purpose: 'the bot token' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('What the person typed for DISCORD_TOKEN holds a character a request header can\'t carry, so it can\'t be a bot token, and nothing was stored. Ask them to check what they copied, then call again.');
    expect(called).toBe(0);
    expect(readEnvFile(join(made.dir, '.env')).get('DISCORD_TOKEN')).toBe('the-old-token');
    expect(made.shown).toEqual(['It holds a character a request header can\'t carry, so it can\'t be a token: nothing was stored.']);
  });

  test('a token of only whitespace is refused as empty, asking Discord nothing and leaving what was stored before', async () => {
    let called = 0;
    const made = install({
      envFile: 'DISCORD_TOKEN="the-old-token"\n',
      asker: typed(' \t '),
      fetch: (async () => { called += 1; throw new Error('unreachable'); }) as unknown as typeof fetch,
    });
    const result = await askSecret(made.module, { name: 'DISCORD_TOKEN', purpose: 'the bot token' });
    expect(result.success).toBe(false);
    expect(result.error).toStartWith('Nothing came back from the terminal (Enter alone, or only whitespace, or the terminal closed)');
    expect(called).toBe(0);
    expect(readEnvFile(join(made.dir, '.env')).get('DISCORD_TOKEN')).toBe('the-old-token');
  });

  test('a token with a tab or a CR around it is trimmed, not refused as holding a control character', async () => {
    const made = install({ asker: typed('token-five\t\r') });
    expect((await askSecret(made.module, { name: 'DISCORD_TOKEN', purpose: 'the bot token' })).success).toBe(true);
    expect(readEnvFile(join(made.dir, '.env')).get('DISCORD_TOKEN')).toBe('token-five');
  });

  test('checks and stores a token without the spaces pasted around it, so what Discord was asked about is what is stored', async () => {
    let sent: string | null = null;
    const made = install({
      asker: typed('  token-four  '),
      fetch: (async (_url: string, init: RequestInit) => {
        sent = new Headers(init.headers).get('authorization');
        return Response.json({ id: '7', username: 'four-bot' });
      }) as unknown as typeof fetch,
    });
    expect((await askSecret(made.module, { name: 'DISCORD_TOKEN', purpose: 'the bot token' })).success).toBe(true);
    expect(sent).toBe('Bot token-four');
    expect(readEnvFile(join(made.dir, '.env')).get('DISCORD_TOKEN')).toBe('token-four');
  });

  test('asks Discord nothing about a secret of a name no service checks, and stores it as typed, spaces and all', async () => {
    let called = 0;
    const made = install({ asker: typed('  a-value '), fetch: (async () => { called += 1; return new Response(''); }) as unknown as typeof fetch });
    expect((await askSecret(made.module, { name: 'DISCORD_TOKEN_NOTE', purpose: 'x' })).success).toBe(true);
    expect(called).toBe(0);
    expect(made.shown).toEqual([]);
    expect(readEnvFile(join(made.dir, '.env')).get('DISCORD_TOKEN_NOTE')).toBe('  a-value ');
  });
});

describe('checkProviderKey', () => {
  test('a provider key a redirect puts in a host, lowercased, is hidden in where it leads', async () => {
    const result = await checkProviderKey('OPENROUTER_API_KEY', 'sk-or-ABC', {
      fetch: (async () => new Response(null, { status: 302, headers: { location: 'https://sk-or-abc.example/' } })) as unknown as typeof fetch,
    });
    expect(result).toEqual({ kind: 'redirected', status: 302, to: 'https://<OPENROUTER_API_KEY>.example/' });
  });

  test('another stored secret is hidden in what the provider says, its ASCII letters in any case', async () => {
    const result = await checkProviderKey('OPENROUTER_API_KEY', 'sk-or-ABC', {
      hide: [{ name: 'MY_TOKEN', value: 'AbCd1234' }],
      fetch: (async () => Response.json({ error: { message: 'no route for abcd1234 or ABCD1234' } }, { status: 400 })) as unknown as typeof fetch,
    });
    expect(result).toEqual({ kind: 'answered', status: 400, said: 'no route for <MY_TOKEN> or <MY_TOKEN>' });
  });

  test('a short stored secret isn\'t found again inside the name that took a longer one\'s place in what the provider says', async () => {
    const result = await checkProviderKey('OPENROUTER_API_KEY', 'sk-or-ABC', {
      hide: [{ name: 'MY_TOKEN', value: 'AbCd1234' }, { name: 'SHORT', value: 't' }],
      fetch: (async () => Response.json({ error: { message: 'no abcd1234' } }, { status: 400 })) as unknown as typeof fetch,
    });
    expect(result).toEqual({ kind: 'answered', status: 400, said: 'no <MY_TOKEN>' });
  });

  test('another stored secret is hidden in what the provider says, in its trimmed form as well as whole', async () => {
    const result = await checkProviderKey('OPENROUTER_API_KEY', 'sk-or-ABC', {
      hide: [{ name: 'MY_TOKEN', value: '  abc123  ' }],
      fetch: (async () => Response.json({ error: { message: 'no route for abc123' } }, { status: 400 })) as unknown as typeof fetch,
    });
    expect(result).toEqual({ kind: 'answered', status: 400, said: 'no route for <MY_TOKEN>' });
  });

  test('a 401 or 403 typed other than JSON, json-seq included, is read as unrecognized, decided before the body, and one typed JSON, or untyped, as the provider\'s refusal', async () => {
    const answering = (status: number, type: string | null, body: BodyInit | null) => (async () =>
      new Response(body, { status, headers: type === null ? {} : { 'content-type': type } })) as unknown as typeof fetch;
    const never = () => new ReadableStream({ start() {} });
    for (const status of [401, 403]) {
      const results = {
        html: await checkProviderKey('OPENAI_API_KEY', 'sk-ABC', { fetch: answering(status, 'text/html; charset=utf-8', never()) }),
        json: await checkProviderKey('OPENAI_API_KEY', 'sk-ABC', { fetch: answering(status, 'application/json; charset=utf-8', never()) }),
        problem: await checkProviderKey('OPENAI_API_KEY', 'sk-ABC', { fetch: answering(status, 'application/problem+json', never()) }),
        untyped: await checkProviderKey('OPENAI_API_KEY', 'sk-ABC', { fetch: answering(status, null, never()) }),
        seq: await checkProviderKey('OPENAI_API_KEY', 'sk-ABC', { fetch: answering(status, 'application/json-seq', never()) }),
      };
      expect({ status, ...results }).toEqual({
        status, html: { kind: 'unrecognized', status }, json: { kind: 'refused', status },
        problem: { kind: 'refused', status }, untyped: { kind: 'refused', status }, seq: { kind: 'unrecognized', status },
      });
    }
  });

  test('a 404 typed other than JSON is read as unrecognized, decided before the body, and one typed JSON as the provider\'s answer', async () => {
    const answering = (type: string, body: BodyInit) => (async () =>
      new Response(body, { status: 404, headers: { 'content-type': type } })) as unknown as typeof fetch;
    expect({
      html: await checkProviderKey('OPENAI_API_KEY', 'sk-ABC', { fetch: answering('text/html', new ReadableStream({ start() {} })) }),
      json: await checkProviderKey('OPENAI_API_KEY', 'sk-ABC', { fetch: answering('application/json', JSON.stringify({ error: { message: 'no such route' } })) }),
    }).toEqual({ html: { kind: 'unrecognized', status: 404 }, json: { kind: 'answered', status: 404, said: 'no such route' } });
  });
});

describe('checkDiscordToken', () => {
  test('follows no redirect, and answers a 3xx as a redirect, with where it leads', async () => {
    let redirect: RequestRedirect | undefined;
    const result = await checkDiscordToken('a-token', {
      fetch: (async (_url: string, init: RequestInit) => {
        redirect = init.redirect;
        return new Response(null, { status: 307, headers: { location: 'https://elsewhere.example/' } });
      }) as unknown as typeof fetch,
    });
    expect(redirect).toBe('manual');
    expect(result).toEqual({ kind: 'redirected', status: 307, to: 'https://elsewhere.example/' });
    const relative = await checkDiscordToken('a-token', {
      fetch: (async () => new Response(null, { status: 302, headers: { location: '/login' } })) as unknown as typeof fetch,
    });
    expect(relative).toEqual({ kind: 'redirected', status: 302, to: 'https://discord.com/login' });
  });

  test('a token a redirect puts in a host, lowercased, is hidden in where it leads', async () => {
    const result = await checkDiscordToken('A-Token', {
      fetch: (async () => new Response(null, { status: 307, headers: { location: 'https://a-token.example/' } })) as unknown as typeof fetch,
    });
    expect(result).toEqual({ kind: 'redirected', status: 307, to: 'https://<DISCORD_TOKEN>.example/' });
  });

  test('a token passed with spaces around it is hidden in what an error quotes, as sent or trimmed', async () => {
    const result = await checkDiscordToken(' a-token  ', {
      fetch: (async () => { throw new Error('header Bot  a-token rejected; sent Bot  a-token  '); }) as unknown as typeof fetch,
    });
    expect(result).toEqual({ kind: 'unanswered', why: 'header Bot  <DISCORD_TOKEN> rejected; sent Bot <DISCORD_TOKEN>' });
  });

  test('a 401 is a refusal though its body never comes', async () => {
    const result = await checkDiscordToken('a-token', {
      fetch: (async () => new Response(new ReadableStream({ start() {} }), { status: 401 })) as unknown as typeof fetch,
    });
    expect(result).toEqual({ kind: 'refused' });
  });

  test('a 401 whose answer says it isn\'t JSON isn\'t read as Discord\'s refusal, and one that says JSON is a refusal before its body comes', async () => {
    const answering = (type: string) => (async () => new Response('<html>Unauthorized</html>', { status: 401, headers: { 'content-type': type } })) as unknown as typeof fetch;
    expect(await checkDiscordToken('a-token', { fetch: answering('text/html; charset=utf-8') })).toEqual({ kind: 'unrecognized', status: 401 });
    expect(await checkDiscordToken('a-token', { fetch: answering('application/json') })).toEqual({ kind: 'refused' });
    expect(await checkDiscordToken('a-token', { fetch: (async () => new Response(new ReadableStream({ start() {} }), { status: 401, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch })).toEqual({ kind: 'refused' });
    expect(await checkDiscordToken('a-token', { fetch: (async () => new Response('<html>', { status: 403 })) as unknown as typeof fetch })).toEqual({ kind: 'unrecognized', status: 403 });
  });

  test('a 401 typed other than JSON is read as unrecognized, decided before the body, and one typed JSON, or a +json type, as Discord\'s refusal', async () => {
    const answering = (type: string) => (async () => new Response(new ReadableStream({ start() {} }), {
      status: 401, headers: { 'content-type': type },
    })) as unknown as typeof fetch;
    expect({
      html: await checkDiscordToken('a-token', { fetch: answering('text/html; charset=utf-8') }),
      json: await checkDiscordToken('a-token', { fetch: answering('application/json') }),
      problem: await checkDiscordToken('a-token', { fetch: answering('application/problem+json') }),
    }).toEqual({ html: { kind: 'unrecognized', status: 401 }, json: { kind: 'refused' }, problem: { kind: 'refused' } });
  });

  test('no answer within its limit is unanswered, saying so', async () => {
    const result = await checkDiscordToken('a-token', {
      limitMs: 50,
      fetch: ((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
      })) as unknown as typeof fetch,
    });
    expect(result).toEqual({ kind: 'unanswered', why: 'no answer within 0.05 s' });
  });

  test('a 200 that isn\'t JSON is read as unrecognized, one that isn\'t the bot user as Discord answering otherwise, and Discord\'s own words never show the token', async () => {
    expect(await checkDiscordToken('a-token', { fetch: (async () => new Response('<html>')) as unknown as typeof fetch }))
      .toEqual({ kind: 'unrecognized', status: 200 });
    expect(await checkDiscordToken('a-token', { fetch: (async () => Response.json({})) as unknown as typeof fetch }))
      .toEqual({ kind: 'answered', status: 200, said: null });
    expect(await checkDiscordToken('a-token', {
      fetch: (async () => Response.json({ message: 'bad token a-token' }, { status: 403 })) as unknown as typeof fetch,
    })).toEqual({ kind: 'answered', status: 403, said: 'bad token <DISCORD_TOKEN>' });
    expect(await checkDiscordToken('a-token', {
      fetch: (async () => Response.json({ id: 'a-token', username: 'bot a-token' })) as unknown as typeof fetch,
    })).toEqual({ kind: 'accepted', name: 'bot <DISCORD_TOKEN>', id: '<DISCORD_TOKEN>' });
  });
});

describe('setup--ask_secret', () => {
  test('asks the person, stores the value in .env (0600) beside what is there, and answers where it went and what Discord said of it', async () => {
    const asked: Array<{ name: string; purpose: string }> = [];
    const { dir, module } = install({
      envFile: 'ANTHROPIC_API_KEY="sk-ant-the-key"\nDISCORD_TOKEN="old"\n',
      asker: { ask: async (name, purpose) => { asked.push({ name, purpose }); return 'new-discord-token'; } },
    });
    chmodSync(join(dir, '.env'), 0o644);
    const result = await askSecret(module, { name: 'DISCORD_TOKEN', purpose: 'the bot token from the Discord developer portal' });
    expect(result.success, result.error).toBe(true);
    expect(asked).toEqual([{ name: 'DISCORD_TOKEN', purpose: 'the bot token from the Discord developer portal' }]);
    expect(JSON.stringify(result)).not.toContain('new-discord-token');
    expect(String(result.data)).toBe(`stored as DISCORD_TOKEN in ${join(dir, '.env')}. Discord accepted it: the bot is test-bot (1000).`);
    expect(readFileSync(join(dir, '.env'), 'utf-8')).toBe('ANTHROPIC_API_KEY="sk-ant-the-key"\nDISCORD_TOKEN="new-discord-token"\n');
    expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o600);
    expect(module.storedSecrets.names()).toContain('DISCORD_TOKEN');
    const answer = await run(module, 'echo "${DISCORD_TOKEN:-none}"; cat .env');
    expect(answer.stdout.text).not.toContain('new-discord-token');
    expect(answer.stdout.text.startsWith('none\n')).toBe(true);
  });

  test('refuses a name that isn\'t letters, digits and _, quoting the name it was given, and asks nothing', async () => {
    const asked: string[] = [];
    const { module } = install({ asker: { ask: async (name) => { asked.push(name); return 'unasked'; } } });
    const result = await askSecret(module, { name: 'DISCORD-TOKEN', purpose: 'the bot token' });
    expect(result.error).toBe('setup--ask_secret\'s name was "DISCORD-TOKEN", and it needs a name an environment variable can have: letters, digits and _, not starting with a digit.');
    expect(asked).toEqual([]);
  });

  test('replaces every line a name has in .env with one, where the first was, so the value stored is the one read', async () => {
    const { dir, module } = install({
      envFile: "DISCORD_TOKEN=\"first-old\"\nPORT=8080\nDISCORD_TOKEN='second-old'\n",
      asker: { ask: async () => 'the-new-token' },
    });
    expect((await askSecret(module, { name: 'DISCORD_TOKEN', purpose: 'the bot token' })).success).toBe(true);
    expect(readFileSync(join(dir, '.env'), 'utf-8')).toBe('DISCORD_TOKEN="the-new-token"\nPORT=8080\n');
    expect(readEnvFile(join(dir, '.env')).get('DISCORD_TOKEN')).toBe('the-new-token');
  });

  test('a value the person declines, or a terminal that closes, stores nothing and says so', async () => {
    for (const typed of [null, '']) {
      const { dir, module } = install({ asker: { ask: async () => typed } });
      const result = await askSecret(module, { name: 'DISCORD_TOKEN', purpose: 'the bot token' });
      expect(result.success).toBe(false);
      expect(result.isError).toBe(true);
      expect(result.error).toContain('nothing was stored');
      expect(result.error).toContain('If they declined, ask them in the conversation whether to try again.');
      expect(existsSync(join(dir, '.env'))).toBe(false);
    }
  });

  test('with no terminal to ask on, it refuses, stores nothing, and says calling again won\'t help', async () => {
    const { dir, module } = install({ asker: null });
    const result = await askSecret(module, { name: 'DISCORD_TOKEN', purpose: 'the bot token' });
    expect(result.success).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.error).toContain('terminal');
    expect(result.error).toContain('won\'t help');
    expect(existsSync(join(dir, '.env'))).toBe(false);
  });

  test('refuses a name an environment variable cannot have, without asking', async () => {
    let asked = false;
    const { dir, module } = install({ asker: { ask: async () => { asked = true; return 'a-fine-value'; } } });
    for (const name of ['discord token', '1TOKEN', 'TOKEN-X', '']) {
      const result = await askSecret(module, { name, purpose: 'x' });
      expect(result.success, name).toBe(false);
      expect(result.isError, name).toBe(true);
      expect(result.error, name).toContain('name');
    }
    expect(asked).toBe(false);
    expect(existsSync(join(dir, '.env'))).toBe(false);
  });

  test('stores a value holding U+2028 or U+2029 as typed, read back so by Bun and by readEnvFile', async () => {
    const value = 'line\u2028and\u2029paragraph';
    const { dir, module } = install({ asker: { ask: async () => value } });
    const result = await askSecret(module, { name: 'A_SECRET', purpose: 'x' });
    expect(result.success, result.error).toBe(true);
    const bun = Bun.spawnSync([process.execPath, '-e', 'process.stdout.write(JSON.stringify(process.env.A_SECRET ?? null))'], {
      cwd: dir, env: { PATH: process.env.PATH ?? '' },
    });
    expect(JSON.parse(bun.stdout.toString())).toBe(value);
    expect(readEnvFile(join(dir, '.env')).get('A_SECRET')).toBe(value);
  });

  test('refuses a value .env cannot hold as typed, without showing it, saying which characters it can\'t hold', async () => {
    const quoting = 'it holds a double quote, a $ or a backslash, which Bun can read in a .env line otherwise than typed, so setup doesn\'t write them there';
    const control = 'it holds a line break, a tab or another control character';
    for (const [value, why] of [
      ['has"quote', quoting], ['back\\slash', quoting], ['pa$$word', quoting], ['line\nbreak', control], ['tab\there', control],
      ['bell\u0007', control],
    ] as const) {
      const { dir, module } = install({ asker: { ask: async () => value } });
      const result = await askSecret(module, { name: 'DISCORD_TOKEN', purpose: 'x' });
      expect(result.success, JSON.stringify(value)).toBe(false);
      expect(result.isError).toBe(true);
      expect(result.error).not.toContain(value);
      expect(result.error).toBe(`What the person typed for DISCORD_TOKEN can't be stored, since ${why}, and ask_secret can't store such a value however it is asked. Nothing was stored. Tell them why, and ask them to check what they copied; if it's right as typed, tell them setup can't store it.`);
      expect(existsSync(join(dir, '.env'))).toBe(false);
    }
  });

  test("asks nothing and stores nothing, and says which file, while the list of stored secrets is damaged", async () => {
    let asked = false;
    const { dir, module } = install({ asker: { ask: async () => { asked = true; return 'a-new-secret'; } } });
    mkdirSync(join(dir, '.setup'));
    writeFileSync(join(dir, '.setup', 'stored-secrets.json'), '{"not": "a list"}');
    const result = await askSecret(module, { name: 'DISCORD_TOKEN', purpose: 'the bot token' });
    expect(result.success).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.error).toContain(join(dir, '.setup', 'stored-secrets.json'));
    expect(asked).toBe(false);
    expect(existsSync(join(dir, '.env'))).toBe(false);
  });

  linuxTest('stores a value in .env readable by this user alone, though a .env.tmp others can read was left beside it', async () => {
    const { dir, module } = install({ envFile: 'PORT=8080\n', asker: { ask: async () => 'the-new-token' } });
    writeFileSync(join(dir, '.env.tmp'), 'left by a write cut off\n');
    chmodSync(join(dir, '.env.tmp'), 0o644);
    const tmp = join(realpathSync(dir), '.env.tmp');
    const modes: number[] = [];
    const real = fs.writeSync;
    const writes = spyOn(fs, 'writeSync').mockImplementation(((fd: number, ...rest: unknown[]) => {
      if (readlinkSync(`/proc/self/fd/${fd}`) === tmp) modes.push(fs.fstatSync(fd).mode & 0o777);
      return (real as (...args: unknown[]) => number)(fd, ...rest);
    }) as typeof fs.writeSync);
    try {
      expect((await askSecret(module, { name: 'DISCORD_TOKEN', purpose: 'x' })).success).toBe(true);
    } finally {
      writes.mockRestore();
    }
    expect(modes.length).toBeGreaterThan(0);
    expect(modes.every((mode) => mode === 0o600)).toBe(true);
    expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o600);
    expect(readEnvFile(join(dir, '.env')).get('DISCORD_TOKEN')).toBe('the-new-token');
  });

  test('asks nothing while .env is a link, to a file, a directory, a file this user can\'t read, or nothing, saying where it leads and what the person can do, and leaves the link as it was', async () => {
    const elsewhere = scratch();
    const targets: Array<[string, string]> = [
      ['a file', join(elsewhere, 'shared.env')],
      ['a directory', join(elsewhere, 'a-directory')],
      ['a file this user can\'t read', join(elsewhere, 'closed.env')],
      ['nothing', join(elsewhere, 'not-there.env')],
    ];
    writeFileSync(join(elsewhere, 'shared.env'), 'PORT=8080\n');
    chmodSync(join(elsewhere, 'shared.env'), 0o644);
    mkdirSync(join(elsewhere, 'a-directory'));
    writeFileSync(join(elsewhere, 'closed.env'), 'PORT=8080\n', { mode: 0o000 });
    for (const [what, target] of targets) {
      const dir = scratch();
      symlinkSync(target, join(dir, '.env'));
      const modeBefore = existsSync(target) ? statSync(target).mode & 0o777 : null;
      let asked = false;
      const { module } = install({ dir, asker: { ask: async () => { asked = true; return 'a-new-secret'; } } });
      const result = await askSecret(module, { name: 'DISCORD_TOKEN', purpose: 'x' });
      expect(result.isError, what).toBe(true);
      expect(result.error, what).toBe(`Nothing was asked, so nothing was stored as DISCORD_TOKEN: ${join(dir, '.env')} is a link to ${target}, and it's written only as a file of its own, not through a link or over one. Asking again won't help until the person replaces the link with the file it leads to, if that's there, or takes it away; tell them so.`);
      expect(asked, what).toBe(false);
      expect(lstatSync(join(dir, '.env')).isSymbolicLink(), what).toBe(true);
      expect(existsSync(target) ? statSync(target).mode & 0o777 : null, what).toBe(modeBefore);
    }
    expect(readFileSync(join(elsewhere, 'shared.env'), 'utf-8')).toBe('PORT=8080\n');
  });

  test('stores nothing through or over a .env made a link while it asks, to a file that holds the value, a directory or a file this user can\'t read, saying where it leads and what the person can do, and leaves the link and its target as they were', async () => {
    const elsewhere = scratch();
    const holding = join(elsewhere, 'shared.env');
    writeFileSync(holding, 'PORT=8080\nDISCORD_TOKEN="linked-value"\n');
    chmodSync(holding, 0o644);
    mkdirSync(join(elsewhere, 'a-directory'));
    writeFileSync(join(elsewhere, 'closed.env'), 'PORT=8080\n', { mode: 0o000 });
    for (const target of [holding, join(elsewhere, 'a-directory'), join(elsewhere, 'closed.env')]) {
      const dir = scratch();
      const modeBefore = statSync(target).mode & 0o777;
      const { module } = install({ dir, asker: { ask: async () => { symlinkSync(target, join(dir, '.env')); return 'linked-value'; } } });
      const result = await askSecret(module, { name: 'DISCORD_TOKEN', purpose: 'x' });
      expect(result.isError, target).toBe(true);
      expect(result.error, target).toBe(`Nothing was stored as DISCORD_TOKEN: ${join(dir, '.env')} is a link to ${target}, and it's written only as a file of its own, not through a link or over one. Asking again won't help until the person replaces the link with the file it leads to, if that's there, or takes it away; tell them so.`);
      expect(lstatSync(join(dir, '.env')).isSymbolicLink(), target).toBe(true);
      expect(statSync(target).mode & 0o777, target).toBe(modeBefore);
    }
    expect(readFileSync(holding, 'utf-8')).toBe('PORT=8080\nDISCORD_TOKEN="linked-value"\n');
    expect(statSync(holding).mode & 0o777).toBe(0o644);
  });

  modeTest('says it isn\'t known whether a value was stored when its directory refuses the write to .env, and leaves no copy of it beside .env', async () => {
    const { dir, module } = install({ envFile: 'PORT=8080\n', asker: { ask: async () => 'unwritten-value' } });
    mkdirSync(join(dir, '.setup'), { mode: 0o700 });
    chmodSync(dir, 0o500);
    let result: ToolResult;
    try {
      result = await askSecret(module, { name: 'DISCORD_TOKEN', purpose: 'x' });
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(result.isError).toBe(true);
    expect(result.error).toStartWith('It isn\'t known whether DISCORD_TOKEN was stored: EACCES');
    expect(result.error).toEndWith('. Ask the person to put right what that names, then call again, which asks for the value again.');
    expect(readFileSync(join(dir, '.env'), 'utf-8')).toBe('PORT=8080\n');
    expect(readdirSync(dir).sort()).toEqual(['.env', '.setup']);
  });

  test('a write of .env or of the list of stored secrets that fails before its rename, here at a file-size limit, leaves .env as it was, and no copy beside either', () => {
    const other = scratch();
    writeFileSync(join(other, '.env'), 'OPENAI_API_KEY=openai-key-value\n');
    const script = `const { StoredSecrets, writeEnvValue } = await import(${JSON.stringify(join(import.meta.dir, '..', 'src', 'setup', 'secrets.ts'))});
      try { writeEnvValue(${JSON.stringify(join(other, '.env'))}, 'DISCORD_TOKEN', 'cut-off-value'); } catch (e) { console.log('threw', e.code); }
      try { new StoredSecrets(${JSON.stringify(join(other, '.setup'))}).record('DISCORD_TOKEN'); } catch (e) { console.log('threw', e.code); }`;
    const ran = Bun.spawnSync(['bash', '-c', `trap '' XFSZ; ulimit -f 0; exec ${process.execPath} -e "$0"`, script], { cwd: other });
    expect(ran.stdout.toString().match(/threw/g)).toHaveLength(2);
    expect(readdirSync(other).sort()).toEqual(['.env', '.setup']);
    expect(readdirSync(join(other, '.setup'))).toEqual([]);
    expect(readFileSync(join(other, '.env'), 'utf-8')).toBe('OPENAI_API_KEY=openai-key-value\n');
  });

  modeTest('says nothing was stored when .env can\'t be read once the person has typed the value, before anything is written', async () => {
    let envFile = '';
    const { dir, module } = install({
      envFile: 'PORT=8080\n',
      asker: { ask: async () => { chmodSync(envFile, 0o000); return 'typed-while-it-closed'; } },
    });
    envFile = join(dir, '.env');
    listSecrets(module);
    let result: ToolResult;
    try {
      result = await askSecret(module, { name: 'DISCORD_TOKEN', purpose: 'x' });
    } finally {
      chmodSync(envFile, 0o600);
    }
    expect(result.isError).toBe(true);
    expect(result.error).toBe(`Nothing was stored as DISCORD_TOKEN: ${envFile} can't be read (EACCES). Ask the person to put that right, then call again.`);
    expect(readFileSync(envFile, 'utf-8')).toBe('PORT=8080\n');
  });

  test('stores nothing where .env comes to hold a line outside setup\'s form while the person types, and says what to do', async () => {
    const { dir, module } = install({
      asker: { ask: async () => { writeFileSync(join(dir, '.env'), 'NOTE="a note\nover two lines"\n', { mode: 0o600 }); return 'a-new-secret'; } },
    });
    const result = await askSecret(module, { name: 'DISCORD_TOKEN', purpose: 'the bot token' });
    expect(result.isError).toBe(true);
    expect(result.error).toBe(`Nothing was stored as DISCORD_TOKEN: ${outside(join(dir, '.env'), 1, WHY.value, 1)}. Ask the person to put that right, then call again.`);
    expect(readFileSync(join(dir, '.env'), 'utf-8')).toBe('NOTE="a note\nover two lines"\n');
  });

  test('asks nothing while .env holds a line outside setup\'s form, naming it and nothing of it', async () => {
    let asked = false;
    const { dir, module } = install({
      envFile: 'NOTE="a note\nover two lines"\n',
      asker: { ask: async () => { asked = true; return 'a-new-secret'; } },
    });
    const result = await askSecret(module, { name: 'DISCORD_TOKEN', purpose: 'the bot token' });
    expect(result.isError).toBe(true);
    expect(result.error).toBe(`Nothing was asked, so nothing was stored as DISCORD_TOKEN: ${outside(join(dir, '.env'), 1, WHY.value, 1)}. Ask the person to put that right, then call again.`);
    expect(result.error).not.toContain('a note');
    expect(asked).toBe(false);
    expect(readFileSync(join(dir, '.env'), 'utf-8')).toBe('NOTE="a note\nover two lines"\n');
  });

  const asksNothingWhile = async (unreadable: (envFile: string) => void) => {
    let asked = false;
    const { dir, module } = install({ asker: { ask: async () => { asked = true; return 'a-new-secret'; } } });
    unreadable(join(dir, '.env'));
    const result = await askSecret(module, { name: 'DISCORD_TOKEN', purpose: 'the bot token' });
    expect(result.isError).toBe(true);
    expect(result.error).toStartWith('Nothing was asked, so nothing was stored as DISCORD_TOKEN');
    expect(result.error).toContain(`${join(dir, '.env')} can't be read`);
    expect(asked).toBe(false);
  };

  test('asks nothing while .env is a directory, and says so', () => asksNothingWhile((envFile) => mkdirSync(envFile)));

  modeTest('asks nothing while .env is a file this user can\'t read, and says so', () =>
    asksNothingWhile((envFile) => writeFileSync(envFile, 'PORT=8080\n', { mode: 0o000 })));

  test('a question already open when the module stops is answered and stored', async () => {
    let module: SetupModule | undefined;
    const made = install({ asker: { ask: async () => { await module!.stop(); return 'answered-after-the-stop'; } } });
    module = made.module;
    const result = await askSecret(made.module, { name: 'DISCORD_TOKEN', purpose: 'the bot token' });
    expect(result.success, result.error).toBe(true);
    expect(readEnvFile(join(made.dir, '.env')).get('DISCORD_TOKEN')).toBe('answered-after-the-stop');
  });

  test('a question waiting behind an open one when the module stops asks nothing and stores nothing; the open one is stored', async () => {
    const asked: string[] = [];
    let release = () => {};
    const { dir, module } = install({
      asker: {
        ask: async (name) => {
          asked.push(name);
          if (name === 'FIRST_TOKEN') await new Promise<void>((resolve) => { release = resolve; });
          return `value-of-${name}`;
        },
      },
    });
    const first = askSecret(module, { name: 'FIRST_TOKEN', purpose: 'x' });
    const second = askSecret(module, { name: 'SECOND_TOKEN', purpose: 'y' });
    for (const until = performance.now() + 5_000; asked.length === 0 && performance.now() < until;) await Bun.sleep(5);
    await module.stop();
    release();
    expect((await first).success).toBe(true);
    const refused = await second;
    expect(refused.isError).toBe(true);
    expect(refused.error).toContain('The host is stopping, so setup--ask_secret asks nothing');
    expect(asked).toEqual(['FIRST_TOKEN']);
    const stored = readEnvFile(join(dir, '.env'));
    expect(stored.get('FIRST_TOKEN')).toBe('value-of-FIRST_TOKEN');
    expect(stored.has('SECOND_TOKEN')).toBe(false);
  });

  test('once the module has stopped, asks nothing and stores nothing, and says so', async () => {
    let asked = false;
    const { dir, module } = install({ asker: { ask: async () => { asked = true; return 'a-new-secret'; } } });
    await module.stop();
    const result = await askSecret(module, { name: 'DISCORD_TOKEN', purpose: 'the bot token' });
    expect(result.isError).toBe(true);
    expect(result.error).toContain('The host is stopping, so setup--ask_secret asks nothing');
    expect(asked).toBe(false);
    expect(existsSync(join(dir, '.env'))).toBe(false);
  });

  test('a secret named as an object\'s inherited property, constructor, is stored, and comes back as its name, like any other', async () => {
    const { dir, module } = install({ asker: { ask: async () => 'constructor-value' } });
    expect((await askSecret(module, { name: 'constructor', purpose: 'x' })).success).toBe(true);
    expect(readEnvFile(join(dir, '.env')).get('constructor')).toBe('constructor-value');
    const answer = await run(module, 'cat .env');
    expect(answer.stdout.text).toBe('constructor="<constructor>"\n');
  });

  modeTest('a name that can\'t be recorded stores nothing, and says why', async () => {
    const { dir, module } = install({ asker: { ask: async () => 'unrecorded-value' } });
    mkdirSync(join(dir, '.setup'), { mode: 0o500 });
    try {
      const result = await askSecret(module, { name: 'DISCORD_TOKEN', purpose: 'x' });
      expect(result.isError).toBe(true);
      expect(result.error).toContain('Nothing was stored as DISCORD_TOKEN');
      expect(result.error).not.toContain('runs nothing');
      expect(existsSync(join(dir, '.env'))).toBe(false);
    } finally {
      chmodSync(join(dir, '.setup'), 0o700);
    }
  });

  test('a terminal it can\'t ask on refuses, saying calling again won\'t change that', async () => {
    const { module } = install({ asker: { ask: async () => { throw new Error('this terminal\'s readline offers no way to keep what\'s typed from showing'); } } });
    const result = await askSecret(module, { name: 'DISCORD_TOKEN', purpose: 'x' });
    expect(result.isError).toBe(true);
    expect(result.error).toContain('won\'t change that');
    expect(result.error).toContain('tell the person why');
  });

  test('asks one secret at a time, each stored under its own name', async () => {
    const events: string[] = [];
    const { dir, module } = install({
      asker: {
        ask: async (name) => {
          events.push(`ask ${name}`);
          await Bun.sleep(20);
          events.push(`answered ${name}`);
          return `value-of-${name}`;
        },
      },
    });
    const [first, second] = await Promise.all([
      askSecret(module, { name: 'FIRST_TOKEN', purpose: 'x' }),
      askSecret(module, { name: 'SECOND_TOKEN', purpose: 'y' }),
    ]);
    expect(first.success && second.success).toBe(true);
    expect(events).toEqual(['ask FIRST_TOKEN', 'answered FIRST_TOKEN', 'ask SECOND_TOKEN', 'answered SECOND_TOKEN']);
    const stored = readEnvFile(join(dir, '.env'));
    expect(stored.get('FIRST_TOKEN')).toBe('value-of-FIRST_TOKEN');
    expect(stored.get('SECOND_TOKEN')).toBe('value-of-SECOND_TOKEN');
  });
});

describe('reading .env', () => {
  const CHARACTERS = [
    ...Array.from({ length: 0x80 }, (_, at) => String.fromCharCode(at)).filter((character) => character !== '\n'),
    '\u00e9', '\u00a0', '\u2028', '\u2029', '\u0085', '\u00ff', '\u200b', '\ufeff', '\u3000', '\u{1F600}',
  ];

  test('the form takes exactly the lines its refusal describes, setup reads each alone and together as spelled, and Bun reads them all in one file as setup does, with comments holding the characters between', () => {
    const dir = scratch();
    const one = join(dir, 'one.env');
    const lines: string[] = [];
    const spelled = new Map<string, string>();
    for (const character of CHARACTERS) {
      const comments = [`# a comment ${character} holding it`, `#${character}`];
      if (/[\u0000-\u001f\u007f]/.test(character)) {
        for (const comment of comments) {
          writeFileSync(one, `${comment}\n`);
          expect(envForm(one)?.message, JSON.stringify(comment)).toBe(outside(one, 1, WHY.control));
        }
      } else {
        lines.push(...comments, '');
      }
      for (const quote of ['', '"', "'"]) {
        for (const value of [`a${character}b`, `ab${character}`, `${character}ab`, character]) {
          const name = `P_${spelled.size}`;
          const line = `${name}=${quote}${value}${quote}`;
          writeFileSync(one, `${line}\n`);
          const takes = !/[\u0000-\u001f\u007f$\\]/.test(value) && (quote === '' ? !/["'` #]/.test(value) : !value.includes(quote));
          expect(envForm(one) === null, line).toBe(takes);
          if (!takes) continue;
          expect(readEnvFile(one).get(name), line).toBe(value);
          lines.push(line);
          spelled.set(name, value);
        }
      }
    }
    lines.push('P_EMPTY=', 'P_TWICE=first', 'P_TWICE="second"');
    spelled.set('P_EMPTY', '').set('P_TWICE', 'second');
    writeFileSync(join(dir, '.env'), `\ufeff${lines.join('\n')}\n`);
    const names = [...spelled.keys()];
    const bun = Bun.spawnSync([process.execPath, '-e', `process.stdout.write(JSON.stringify(${JSON.stringify(names)}.map((name) => process.env[name] ?? null)))`], {
      cwd: dir, env: { PATH: process.env.PATH ?? '' },
    });
    expect(JSON.parse(bun.stdout.toString())).toEqual([...spelled.values()]);
    const ours = readEnvFile(join(dir, '.env'));
    expect(names.map((name) => ours.get(name) ?? null)).toEqual([...spelled.values()]);
  });

  test('takes blank lines, comments, and values unquoted, double-quoted and single-quoted, quoted ones with spaces, # and the other quotes', () => {
    const dir = scratch();
    const envFile = join(dir, '.env');
    writeFileSync(envFile, ['\ufeff# a comment with "quotes", \'s, `ticks`, $HOME and \\', '', 'A=sk-ant-x_1.2/3+4=', 'B="a b#c \'d\' `e`"', "C='a b#c \"d\" `e`'", 'D=', 'E=""', ''].join('\n'));
    expect(envForm(envFile)).toBeNull();
    expect(Object.fromEntries(readEnvFile(envFile))).toEqual({ A: 'sk-ant-x_1.2/3+4=', B: 'a b#c \'d\' `e`', C: 'a b#c "d" `e`', D: '', E: '' });
  });

  test('refuses a .env outside setup\'s form by its first such line\'s number alone, counting the rest, saying nothing of what any holds, and writes nothing', () => {
    const dir = scratch();
    const envFile = join(dir, '.env');
    for (const [text, line, why, others] of [
      ['A=xyzzy\r\nB=xyzzy\r\n', 1, WHY.control, 1],
      ['A=one\nB=xyzzy\there\n', 2, WHY.control, 0],
      ['# a comment\twith a tab, xyzzy\n', 1, WHY.control, 0],
      ['A=xyzzy\rB=xyzzy\n', 1, WHY.control, 0],
      ['export A=xyzzy\n', 1, WHY.start, 0],
      ['  A=xyzzy\n', 1, WHY.start, 0],
      ['A = xyzzy\n', 1, WHY.start, 0],
      ['A.B=xyzzy\n', 1, WHY.start, 0],
      ['sk-ant-xyzzy\n', 1, WHY.start, 0],
      ['\ufeff\ufeffA=xyzzy\n', 1, WHY.start, 0],
      ['A=xyzzy one\n', 1, WHY.value, 0],
      ['A=xyzzy#one\n', 1, WHY.value, 0],
      ['A=xyzzy$HOME\n', 1, WHY.value, 0],
      ['A=xyzzy\\one\n', 1, WHY.value, 0],
      ["A=xyzzy's\n", 1, WHY.value, 0],
      ['A=`xyzzy`\n', 1, WHY.value, 0],
      ['A="xyzzy$HOME"\n', 1, WHY.value, 0],
      ["A='xyzzy$HOME'\n", 1, WHY.value, 0],
      ['A="xyzzy\\none"\n', 1, WHY.value, 0],
      ['A="xyzzy"one"\n', 1, WHY.value, 0],
      ["A='xyzzy'one'\n", 1, WHY.value, 0],
      ['A="xyzzy\n', 1, WHY.value, 0],
      ['A="xyzzy" # a comment\n', 1, WHY.value, 0],
      ['A=one\nB="xyzzy-first\nxyzzy-second"\nC=three\n', 2, WHY.value, 1],
      ['xyzzy_secret=not in the form\n', 1, WHY.value, 0],
    ] as const) {
      writeFileSync(envFile, text, { mode: 0o600 });
      const said = outside(envFile, line, why, others);
      expect(envForm(envFile)?.message, text).toBe(said);
      expect(() => readEnvFile(envFile), text).toThrow(said);
      let thrown: unknown;
      try {
        writeEnvValue(envFile, 'ANTHROPIC_API_KEY', 'sk-new');
      } catch (error) {
        thrown = error;
      }
      expect(thrown, text).toBeInstanceOf(EnvFormError);
      expect((thrown as Error).message, text).toBe(said);
      expect(said, text).not.toContain('xyzzy');
      expect(readFileSync(envFile, 'utf-8'), text).toBe(text);
    }
  });

  test('writes NAME="value" in place of the first line for the name, takes its later lines out, and keeps every other line as it was', () => {
    const dir = scratch();
    const envFile = join(dir, '.env');
    const before = ['# a comment with "quotes", \'s, `ticks`, $HOME and \\', '', 'TOKEN=old-one', 'B="a b#c"', "TOKEN='old-two'", 'D=', ''].join('\n');
    writeFileSync(envFile, `\ufeff${before}`, { mode: 0o644 });
    writeEnvValue(envFile, 'TOKEN', 'sk new #1');
    expect(readFileSync(envFile, 'utf-8')).toBe(before.replace('TOKEN=old-one', 'TOKEN="sk new #1"').replace("TOKEN='old-two'\n", ''));
    expect(readEnvFile(envFile).get('TOKEN')).toBe('sk new #1');
    writeEnvValue(envFile, 'ADDED', 'added');
    expect(readFileSync(envFile, 'utf-8')).toEndWith('D=\nADDED="added"\n');
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
  });
});

describe("the terminal's hidden question", () => {
  function terminal() {
    const input = new PassThrough();
    const output = new PassThrough();
    let shown = '';
    output.on('data', (chunk) => { shown += chunk.toString(); });
    Object.assign(input, { isTTY: true, setRawMode: () => {} });
    const rl = createInterface({ input, output, terminal: true, prompt: '> ' });
    const lines: string[] = [];
    rl.on('line', (line) => lines.push(line));
    const nextLine = () => new Promise<void>((resolve) => rl.once('line', () => resolve()));
    return { input, output, rl, lines, nextLine, shown: () => shown };
  }

  test('reads one line with nothing echoed, which never reaches the conversation or its history', async () => {
    const { input, output, rl, lines, nextLine, shown } = terminal();
    const hello = nextLine();
    input.write('hello\r');
    await hello;
    const answer = askHidden(rl, output, 'DISCORD_TOKEN (the bot token)');
    input.write('s3cret-value\r');
    expect(await answer).toBe('s3cret-value');
    const after = nextLine();
    input.write('after\r');
    await after;
    expect(lines).toEqual(['hello', 'after']);
    expect(shown()).not.toContain('s3cret-value');
    expect(shown()).toContain('DISCORD_TOKEN (the bot token)');
    expect((rl as unknown as { history: string[] }).history).not.toContain('s3cret-value');
    rl.close();
  });

  test('a hidden question asked while a bracketed paste is under way opens once the paste ends, which is left whole for the conversation', async () => {
    const { input, output, rl, shown } = terminal();
    const signals = { on: () => {}, off: () => {}, kill: () => {}, listenerCount: () => 0, pid: 0 };
    const paste = bracketedPaste(rl, input as never, output as never, () => {}, signals as never);
    const sent: string[] = [];
    rl.on('line', (line) => {
      const message = paste.take(line);
      if (message !== null) sent.push(message);
    });
    input.write('\x1b[200~chat one\r');
    await Bun.sleep(20);
    const answer = askHidden(rl, output, 'DISCORD_TOKEN (the bot token)', paste);
    input.write('chat two\r');
    await Bun.sleep(PASTE_QUIET_MS + 100);
    expect(shown()).not.toContain('DISCORD_TOKEN');
    input.write('chat three\x1b[201~');
    await Bun.sleep(20);
    expect(shown()).toContain('DISCORD_TOKEN (the bot token)');
    input.write('s3cret-value\r');
    expect(await answer).toBe('s3cret-value');
    expect(rl.line).toBe('chat three');
    const after = new Promise<void>((resolve) => rl.once('line', () => resolve()));
    input.write('\r');
    await after;
    expect(sent).toEqual(['chat one\nchat two\nchat three']);
    expect(shown()).not.toContain('s3cret-value');
    paste.end();
    rl.close();
  });

  test('a conversation closed while a hidden question waits out a paste answers nothing, and the question never opens', async () => {
    const { input, output, rl, shown } = terminal();
    input.write('half');
    await Bun.sleep(20);
    const answer = askHidden(rl, output, 'DISCORD_TOKEN (the bot token)', { pasting: () => true, drop: () => ({ taken: 0, left: 0 }) });
    rl.close();
    expect(await answer).toBe('');
    expect(shown()).not.toContain('DISCORD_TOKEN');
  });

  test('a conversation closed in the same tick as the paste\'s end, from a listener after the question\'s own, answers nothing, and the question never opens', async () => {
    const { input, output, rl, shown } = terminal();
    const signals = { on: () => {}, off: () => {}, kill: () => {}, listenerCount: () => 0, pid: 0 };
    const paste = bracketedPaste(rl, input as never, output as never, () => {}, signals as never);
    rl.on('line', (line) => { paste.take(line); });
    input.write('\x1b[200~chat one\r');
    await Bun.sleep(30);
    const answer = askHidden(rl, output, 'DISCORD_TOKEN (the bot token)', paste);
    input.on('keypress', (_text: unknown, key: { name?: string } | undefined) => {
      if (key?.name === 'paste-end') rl.close();
    });
    input.write('\x1b[201~');
    expect(await answer).toBe('');
    expect(shown()).not.toContain('DISCORD_TOKEN');
    paste.end();
  });

  test('a paste\'s end and Ctrl-D in one chunk, while a hidden question waits out the paste, answer nothing, and the question never opens', async () => {
    const { input, output, rl, shown } = terminal();
    const signals = { on: () => {}, off: () => {}, kill: () => {}, listenerCount: () => 0, pid: 0 };
    const paste = bracketedPaste(rl, input as never, output as never, () => {}, signals as never);
    rl.on('line', (line) => { paste.take(line); });
    input.write('\x1b[200~chat one\r');
    await Bun.sleep(30);
    const answer = askHidden(rl, output, 'DISCORD_TOKEN (the bot token)', paste);
    input.write('\x1b[201~\x04');
    expect(await answer).toBe('');
    expect(shown()).not.toContain('DISCORD_TOKEN');
    paste.end();
  });

  test('a line on the prompt that holds the answer just given hidden isn\'t given back, so the secret isn\'t one Enter from the conversation', async () => {
    const { input, output, rl, lines, nextLine, shown } = terminal();
    input.write('tok-123456');
    await Bun.sleep(20);
    const answer = askHidden(rl, output, 'DISCORD_TOKEN (the bot token)');
    input.write('tok-123456\r');
    expect(await answer).toBe('tok-123456');
    expect(rl.line).toBe('');
    expect(shown()).toContain('What you\'d typed held what you just entered hidden, so it was taken out.');
    const after = nextLine();
    input.write('after\r');
    await after;
    expect(lines).toEqual(['after']);
    expect(shown().split('tok-123456').length - 1).toBe(1);
    rl.close();
  });

  test('a line on the prompt, a pasted line held for the conversation, a history entry and a kill that hold the answer, its ASCII letters in another case, are taken out too', async () => {
    const { input, output, rl, shown } = terminal();
    const signals = { on: () => {}, off: () => {}, kill: () => {}, listenerCount: () => 0, pid: 0 };
    const paste = bracketedPaste(rl, input as never, output as never, () => {}, signals as never);
    const sent: string[] = [];
    rl.on('line', (line) => {
      const message = paste.take(line);
      if (message !== null) sent.push(message);
    });
    input.write('TOK-ABCDEF\x15');
    input.write('\x1b[200~my token is\rthe token is Tok-AbcDef\r\x1b[201~');
    await Bun.sleep(30);
    input.write('typed TOK-abcdef');
    await Bun.sleep(20);
    const history = (rl as unknown as { history: string[] }).history;
    const ringKey = Object.getOwnPropertySymbols(rl).find((key) => key.description === '_killRing');
    const ring = (rl as unknown as Record<symbol, unknown[]>)[ringKey!]!;
    expect(history.some((entry) => entry.toLowerCase().includes('tok-abcdef')), 'the history held the token first').toBe(true);
    expect(ring.some((entry) => String(entry).toLowerCase().includes('tok-abcdef')), 'the kill ring held the token first').toBe(true);
    const answer = askHidden(rl, output, 'DISCORD_TOKEN (the bot token)', paste);
    input.write('tok-abcdef\r');
    expect(await answer).toBe('tok-abcdef');
    expect(rl.line).toBe('');
    expect(shown()).toContain('What you\'d typed held what you just entered hidden, so it was taken out.');
    expect(shown()).toContain('1 pasted line held what you just entered hidden, so it was taken out. Enter sends the rest.\n');
    expect(history.some((entry) => entry.toLowerCase().includes('tok-abcdef'))).toBe(false);
    const yanked = new Promise<void>((resolve) => rl.once('line', () => resolve()));
    input.write('\x19\r');
    await yanked;
    expect(sent).toEqual(['my token is\n']);
    paste.end();
    rl.close();
  });

  test('whether a line holds an answer given hidden is told with ASCII letters in any case and other letters as given, as a line queued for the conversation is', () => {
    expect(terminalSecret.holdsAnswer('my TOK-abcdef', ['tok-ABCDEF'])).toBe(true);
    expect(terminalSecret.holdsAnswer('my token', ['tok-abcdef', 'other'])).toBe(false);
    expect(terminalSecret.holdsAnswer('my ΟΣA', ['ΟΣ'])).toBe(true);
    expect(terminalSecret.holdsAnswer('my CAFÉ', ['café'])).toBe(false);
  });

  test('a draft that holds the answer isn\'t given back where the answer came with spaces around it', async () => {
    const { input, output, rl } = terminal();
    input.write('tok-123456');
    await Bun.sleep(20);
    const answer = askHidden(rl, output, 'DISCORD_TOKEN (the bot token)');
    input.write(' tok-123456 \r');
    expect(await answer).toBe(' tok-123456 ');
    expect(rl.line).toBe('');
    rl.close();
  });

  test('a pasted line held for the conversation that holds the answer just given hidden is taken out, saying so, and the rest stays', async () => {
    const { input, output, rl, shown } = terminal();
    const signals = { on: () => {}, off: () => {}, kill: () => {}, listenerCount: () => 0, pid: 0 };
    const paste = bracketedPaste(rl, input as never, output as never, () => {}, signals as never);
    const sent: string[] = [];
    rl.on('line', (line) => {
      const message = paste.take(line);
      if (message !== null) sent.push(message);
    });
    input.write('\x1b[200~my token is\r tok-123456 \r\x1b[201~');
    await Bun.sleep(30);
    const answer = askHidden(rl, output, 'DISCORD_TOKEN (the bot token)', paste);
    input.write('tok-123456\r');
    expect(await answer).toBe('tok-123456');
    const after = new Promise<void>((resolve) => rl.once('line', () => resolve()));
    input.write('\r');
    await after;
    expect(sent).toEqual(['my token is\n']);
    expect(shown()).toContain('1 pasted line held what you just entered hidden, so it was taken out. Enter sends the rest.\n');
    paste.end();
    rl.close();
  });

  test('a pasted line that holds the answer just given hidden is taken out of readline\'s history too, and the lines that don\'t stay', async () => {
    const { input, output, rl } = terminal();
    const signals = { on: () => {}, off: () => {}, kill: () => {}, listenerCount: () => 0, pid: 0 };
    const paste = bracketedPaste(rl, input as never, output as never, () => {}, signals as never);
    rl.on('line', (line) => { paste.take(line); });
    input.write('\x1b[200~my token is\r tok-123456 \rthe token is tok-123456\r\x1b[201~');
    await Bun.sleep(30);
    const history = (rl as unknown as { history: string[] }).history;
    expect(history.some((entry) => entry.includes('tok-123456')), 'the history held the token first').toBe(true);
    const answer = askHidden(rl, output, 'DISCORD_TOKEN (the bot token)', paste);
    input.write('tok-123456\r');
    expect(await answer).toBe('tok-123456');
    expect(history.some((entry) => entry.includes('tok-123456'))).toBe(false);
    expect(history).toContain('my token is');
    paste.end();
    rl.close();
  });

  test('a line killed before a hidden question that holds its answer is taken out of the kill ring too, and Ctrl-Y after yanks the newest kill left, even where Meta-Y had moved the ring on', async () => {
    for (const [before, sent] of [['other\x15tok-123456\x15', []], ['other\x15tok-123456\x15\x19\x1by\r', ['other']]] as const) {
      const { input, output, rl, lines, nextLine } = terminal();
      input.write(before);
      await Bun.sleep(10);
      const ringKey = Object.getOwnPropertySymbols(rl).find((key) => key.description === '_killRing');
      const ring = (rl as unknown as Record<symbol, unknown[]>)[ringKey!]!;
      expect(ring.some((entry) => String(entry).includes('tok-123456')), 'the kill ring held the token first').toBe(true);
      const answer = askHidden(rl, output, 'DISCORD_TOKEN (the bot token)');
      input.write('tok-123456\r');
      expect(await answer).toBe('tok-123456');
      const yanked = nextLine();
      input.write('\x19\r');
      await yanked;
      expect(lines).toEqual([...sent, 'other']);
      rl.close();
    }
  });

  test('an answer of more than one line is matched line by line, so a paste of it held for the conversation, and its last line left unsent, are taken out', async () => {
    const { input, output, rl, shown } = terminal();
    const signals = { on: () => {}, off: () => {}, kill: () => {}, listenerCount: () => 0, pid: 0 };
    const paste = bracketedPaste(rl, input as never, output as never, () => {}, signals as never);
    const sent: string[] = [];
    rl.on('line', (line) => {
      const message = paste.take(line);
      if (message !== null) sent.push(message);
    });
    input.write('\x1b[200~first\rsecond\x1b[201~');
    await Bun.sleep(30);
    const answer = askHidden(rl, output, 'DISCORD_TOKEN (the bot token)', paste);
    input.write('\x1b[200~first\rsecond\x1b[201~');
    expect(await answer).toBe('first\nsecond');
    expect(rl.line).toBe('');
    expect(shown()).toContain('1 pasted line held what you just entered hidden, so it was taken out.\n');
    const after = new Promise<void>((resolve) => rl.once('line', () => resolve()));
    input.write('\r');
    await after;
    expect(sent).toEqual(['']);
    paste.end();
    rl.close();
  });

  test('a paste held for the conversation that\'s all taken out for holding the answer says so, with nothing left to send', async () => {
    const { input, output, rl, shown } = terminal();
    const signals = { on: () => {}, off: () => {}, kill: () => {}, listenerCount: () => 0, pid: 0 };
    const paste = bracketedPaste(rl, input as never, output as never, () => {}, signals as never);
    rl.on('line', (line) => { paste.take(line); });
    input.write('\x1b[200~tok-123456\rand tok-123456 again\r\x1b[201~');
    await Bun.sleep(30);
    const answer = askHidden(rl, output, 'DISCORD_TOKEN (the bot token)', paste);
    input.write('tok-123456\r');
    expect(await answer).toBe('tok-123456');
    expect(shown()).toContain('2 pasted lines held what you just entered hidden, so they were taken out.\n');
    expect(paste.take('')).toBe('');
    paste.end();
    rl.close();
  });

  test('a listener the conversation had for its next line alone still fires once, after a hidden question', async () => {
    const { input, output, rl } = terminal();
    let fired = 0;
    rl.once('line', () => { fired++; });
    const answer = askHidden(rl, output, 'DISCORD_TOKEN (the bot token)');
    input.write('s3cret-value\r');
    expect(await answer).toBe('s3cret-value');
    input.write('one\r');
    input.write('two\r');
    await Bun.sleep(20);
    expect(fired).toBe(1);
    rl.close();
  });

  test('a bracketed paste that opens with a line break and pauses before the rest is one answer, none of it left for the conversation', async () => {
    const { input, output, rl, lines, nextLine, shown } = terminal();
    const answer = askHidden(rl, output, 'DISCORD_TOKEN (the bot token)');
    input.write('\x1b[200~\r');
    await Bun.sleep(PASTE_QUIET_MS + 100);
    input.write('pasted-token\r\x1b[201~');
    expect(await answer).toBe('pasted-token');
    const after = nextLine();
    input.write('after\r');
    await after;
    expect(lines).toEqual(['after']);
    expect(shown()).not.toContain('pasted-token');
    rl.close();
  });

  test('asks nothing where readline keeps its kill ring or its history where setup can\'t find them, and says so', async () => {
    for (const hide of ['kill ring', 'history']) {
      const { output, rl, shown } = terminal();
      const held = rl as unknown as Record<string | symbol, unknown>;
      if (hide === 'history') delete held.history;
      else for (const key of Object.getOwnPropertySymbols(rl)) if (key.description === '_killRing') delete held[key];
      let refused = '';
      await askHidden(rl, output, 'DISCORD_TOKEN (the bot token)').catch((error: Error) => { refused = error.message; });
      expect({ hide, refused }).toEqual({ hide, refused: 'setup can\'t find this terminal\'s readline history or kill ring, so it couldn\'t keep what\'s typed out of them' });
      expect(shown()).not.toContain('DISCORD_TOKEN');
      rl.close();
    }
  });

  test('keeps a hidden answer out of reach of the keys typed after it in the same input, Up recalling nothing', async () => {
    const { input, output, rl, lines, nextLine } = terminal();
    const hello = nextLine();
    input.write('hello\r');
    await hello;
    const answer = askHidden(rl, output, 'DISCORD_TOKEN (the bot token)');
    input.write('s3cret-value\r\x1b[A\r');
    expect(await answer).toBe('s3cret-value');
    const after = nextLine();
    input.write('after\r');
    await after;
    expect(lines).toEqual(['hello', 'after']);
    expect((rl as unknown as { history: string[] }).history).toEqual(['after', 'hello']);
    rl.close();
  });

  test("text killed while it asks can't be yanked into the conversation after, and the kill ring is as it was before", async () => {
    const { input, output, rl, lines, nextLine, shown } = terminal();
    const killed = nextLine();
    input.write('earlier\x15\r');
    await killed;
    const answer = askHidden(rl, output, 'DISCORD_TOKEN (the bot token)');
    input.write('wrong-paste\x15s3cret-value\r');
    expect(await answer).toBe('s3cret-value');
    const yanked = nextLine();
    input.write('\x19\r');
    await yanked;
    expect(lines).toEqual(['', 'earlier']);
    expect(shown()).not.toContain('wrong-paste');
    expect(shown()).not.toContain('s3cret-value');
    rl.close();
  });

  test('Up and Enter with nothing typed answer nothing, and the history is there again after', async () => {
    const { input, output, rl, lines, nextLine } = terminal();
    const hello = nextLine();
    input.write('hello\r');
    await hello;
    const answer = askHidden(rl, output, 'DISCORD_TOKEN (the bot token)');
    input.write('\x1b[A\r');
    expect(await answer).toBe('');
    expect(lines).toEqual(['hello']);
    expect((rl as unknown as { history: string[] }).history).toEqual(['hello']);
    rl.close();
  });

  test('takes a token pasted in a bracketed paste, with or without a line break of its own, as exactly the token', async () => {
    const { input, output, rl, lines } = terminal();
    const bare = askHidden(rl, output, 'DISCORD_TOKEN (the bot token)');
    input.write('\x1b[200~the-pasted.token-1\x1b[201~\r');
    expect(await bare).toBe('the-pasted.token-1');
    const broken = askHidden(rl, output, 'DISCORD_TOKEN (the bot token)');
    input.write('\x1b[200~the-pasted.token-2\r\x1b[201~');
    expect(await broken).toBe('the-pasted.token-2');
    expect(lines).toEqual([]);
    rl.close();
  });

  test('takes a pasted text of several lines as one answer, none of which reaches the conversation or its history', async () => {
    const { input, output, rl, lines, nextLine } = terminal();
    const answer = askHidden(rl, output, 'DISCORD_TOKEN (the bot token)');
    input.write('first-line-of-it\rsecond-line-of-it\r');
    expect(await answer).toBe('first-line-of-it\nsecond-line-of-it');
    const after = nextLine();
    input.write('after\r');
    await after;
    expect(lines).toEqual(['after']);
    expect((rl as unknown as { history: string[] }).history).toEqual(['after']);
    rl.close();
  });

  test("takes a pasted text's last line though no line break ends it, and none of it reaches the conversation after", async () => {
    const { input, output, rl, lines, nextLine, shown } = terminal();
    const answer = askHidden(rl, output, 'DISCORD_TOKEN (the bot token)');
    input.write('first-line-of-it\rsecond-line-of-it');
    expect(await answer).toBe('first-line-of-it\nsecond-line-of-it');
    const after = nextLine();
    input.write('after\r');
    await after;
    expect(lines).toEqual(['after']);
    expect((rl as unknown as { history: string[] }).history).toEqual(['after']);
    expect(shown()).not.toContain('second-line-of-it');
    rl.close();
  });

  test('text typed but not sent when it asks isn\'t part of the answer, and is back on the prompt once the question is answered', async () => {
    const { input, output, rl, lines, nextLine, shown } = terminal();
    input.write('half-typed\x1b[D\x1b[D');
    const pending = rl as unknown as { line: string; cursor: number };
    for (const until = performance.now() + 5_000; pending.cursor !== 8 && performance.now() < until;) await Bun.sleep(5);
    expect([pending.line, pending.cursor]).toEqual(['half-typed', 8]);
    const answer = askHidden(rl, output, 'DISCORD_TOKEN (the bot token)');
    input.write('s3cret-value\r');
    expect(await answer).toBe('s3cret-value');
    expect(pending.line).toBe('half-typed');
    const after = nextLine();
    input.write(' and after\r');
    await after;
    expect(lines).toEqual(['half-typed and after']);
    expect(shown()).not.toContain('s3cret-value');
    rl.close();
  });

  test('an Enter more after the answer changes nothing in it', async () => {
    const { input, output, rl, lines } = terminal();
    const answer = askHidden(rl, output, 'DISCORD_TOKEN (the bot token)');
    input.write('s3cret-value\r\r');
    expect(await answer).toBe('s3cret-value');
    expect(lines).toEqual([]);
    rl.close();
  });

  test('answers nothing when the terminal closes while it asks, before any line and after one', async () => {
    const before = terminal();
    const nothing = askHidden(before.rl, before.output, 'DISCORD_TOKEN (the bot token)');
    before.rl.close();
    expect(await nothing).toBe('');
    const after = terminal();
    const answer = askHidden(after.rl, after.output, 'DISCORD_TOKEN (the bot token)');
    const taken = new Promise<void>((resolve) => after.rl.once('line', () => resolve()));
    after.input.write('first-line-of-it\r');
    await taken;
    after.rl.close();
    expect(await answer).toBe('');
    expect(after.lines).toEqual([]);
  });

  test('asks nothing where readline offers no way to hide what is typed', async () => {
    const { output, rl, shown } = terminal();
    (rl as unknown as { _writeToOutput: unknown })._writeToOutput = undefined;
    await expect(askHidden(rl, output, 'DISCORD_TOKEN (the bot token)')).rejects.toThrow('no way to keep');
    expect(shown()).not.toContain('DISCORD_TOKEN');
    rl.close();
  });
});

describe('setup--ask_secret with a provider key, and setup--check_model', () => {
  const typed = (value: string) => ({ ask: async () => value });
  const said = (module: ReturnType<typeof install>, result: ToolResult) => `${String(result.data ?? '')} ${result.error ?? ''} ${module.shown.join('\n')}`;
  const checkModel = (module: SetupModule, input: Record<string, unknown>) =>
    module.handleToolCall({ id: 'c3', name: 'check_model', input } as ToolCall);
  const models = (...ids: string[]) => Response.json({ data: ids.map((id) => ({ id })) });

  test('an OPENAI_API_KEY is checked at the OPENAI_BASE_URL .env names, which is named for what answered, before it is stored, and stored once accepted', async () => {
    const requests: Array<{ url: string; headers: Headers; storedThen: string | undefined }> = [];
    const made = install({
      envFile: 'OPENAI_BASE_URL=https://gateway.example/v1/\n',
      asker: typed('sk-openai-key'),
      fetch: (async (url: string, init: RequestInit) => {
        requests.push({ url: String(url), headers: new Headers(init.headers), storedThen: readEnvFile(join(made.dir, '.env')).get('OPENAI_API_KEY') });
        return models('gpt-6.1-terra');
      }) as unknown as typeof fetch,
    });
    const result = await askSecret(made.module, { name: 'OPENAI_API_KEY', purpose: 'the OpenAI key' });
    expect(result.success, result.error).toBe(true);
    expect(requests.map((r) => r.url)).toEqual(['https://gateway.example/v1/models']);
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer sk-openai-key');
    expect(requests[0]!.storedThen).toBeUndefined();
    expect(String(result.data)).toBe(`stored as OPENAI_API_KEY in ${join(made.dir, '.env')}. OPENAI_BASE_URL's server accepted it: it listed the models the key can use, which shows the key is accepted, not that a call to one of them succeeds.`);
    expect(made.shown).toEqual(['Checking it with OPENAI_BASE_URL\'s server.', 'OPENAI_BASE_URL\'s server accepted it.']);
    expect(readEnvFile(join(made.dir, '.env')).get('OPENAI_API_KEY')).toBe('sk-openai-key');
  });

  test('a base URL is joined with the models path as the SDK joins it, a base ending in / taking the path without its first /', async () => {
    const requests: string[] = [];
    const made = install({
      envFile: 'ANTHROPIC_BASE_URL=https://gateway.example//\n',
      asker: typed('sk-ant-key'),
      fetch: (async (url: string) => { requests.push(String(url)); return models('claude-opus-5-5'); }) as unknown as typeof fetch,
    });
    expect((await askSecret(made.module, { name: 'ANTHROPIC_API_KEY', purpose: 'a key' })).success).toBe(true);
    expect(requests).toEqual(['https://gateway.example//v1/models?limit=1000']);
  });

  test('a provider\'s answer that quotes a stored base URL, which can carry a credential, shows it by its name', async () => {
    const url = 'https://openai-gateway.example/v1?key=openai-gateway-key';
    const made = install({
      envFile: `OPENAI_BASE_URL="${url}"\n`,
      asker: typed('sk-openai-key'),
      fetch: (async () => Response.json({ error: { message: `no route to ${url}/models` } }, { status: 529 })) as unknown as typeof fetch,
    });
    const result = await askSecret(made.module, { name: 'OPENAI_API_KEY', purpose: 'a key' });
    expect(said(made, result)).not.toContain('openai-gateway-key');
    expect(String(result.data)).toContain('OPENAI_BASE_URL\'s server answered 529: no route to <OPENAI_BASE_URL>/models');
  });

  test('a key refused where .env names a base URL is said to be refused by that URL\'s server, not the provider, at ask_secret and at check_model', async () => {
    const refusing = (async () => Response.json({ error: { message: 'no' } }, { status: 401 })) as unknown as typeof fetch;
    const asked = install({ envFile: 'OPENAI_BASE_URL=https://gateway.example/v1\n', asker: typed('sk-openai-gated'), fetch: refusing });
    const stored = await askSecret(asked.module, { name: 'OPENAI_API_KEY', purpose: 'a key' });
    expect(stored.error).toStartWith('OPENAI_BASE_URL\'s server refused this key (401) when setup asked it for its list of models, so nothing was stored as OPENAI_API_KEY');
    expect(asked.shown).toEqual(['Checking it with OPENAI_BASE_URL\'s server.', 'OPENAI_BASE_URL\'s server refused it (401): nothing was stored.']);
    const checked = install({ envFile: 'OPENAI_BASE_URL=https://gateway.example/v1\nOPENAI_API_KEY=sk-openai-gated\n', fetch: refusing });
    const model = await checkModel(checked.module, { name: 'OPENAI_API_KEY', model: 'gpt-6.1-terra' });
    expect(model.error).toStartWith('OPENAI_BASE_URL\'s server refused the key stored as OPENAI_API_KEY (401)');
    expect(said(checked, model)).not.toContain('OpenAI');
    const plain = install({ envFile: 'OPENAI_API_KEY=sk-openai-plain\n', fetch: refusing });
    expect((await checkModel(plain.module, { name: 'OPENAI_API_KEY', model: 'gpt-6.1-terra' })).error).toStartWith('OpenAI refused the key stored as OPENAI_API_KEY (401)');
  });

  test('check_model asked while a secret is being asked for waits for it, and checks the key stored then', async () => {
    let answer: ((value: string) => void) | undefined;
    const made = install({
      asker: { ask: () => new Promise<string>((resolve) => { answer = resolve; }) },
      fetch: (async () => models('gpt-6.1-terra')) as unknown as typeof fetch,
    });
    const asked = askSecret(made.module, { name: 'OPENAI_API_KEY', purpose: 'a key' });
    while (answer === undefined) await Bun.sleep(1);
    const reached = heldAt(made.module);
    const checked = checkModel(made.module, { name: 'OPENAI_API_KEY', model: 'gpt-6.1-terra' });
    await Promise.race([reached, checked.then(() => { throw new Error('the check ended without waiting for the question'); })]);
    answer('sk-openai-key');
    expect((await asked).success).toBe(true);
    const result = await checked;
    expect(result.success, result.error).toBe(true);
  });

  test('a model check_model is given, or a purpose ask_secret is given, is shown with each stored value in it replaced by its name', async () => {
    const purposes: string[] = [];
    const made = install({
      envFile: 'ANTHROPIC_API_KEY="sk-ant-stored-key"\nOPENAI_API_KEY="sk-openai-key"\n',
      asker: { ask: async (_name: string, purpose: string) => { purposes.push(purpose); return 'other-token-value'; } },
      fetch: (async () => models('gpt-6.1-terra')) as unknown as typeof fetch,
    });
    const asked = await askSecret(made.module, { name: 'OTHER_TOKEN', purpose: 'the token beside sk-ant-stored-key' });
    expect(asked.success, asked.error).toBe(true);
    expect(purposes).toEqual(['the token beside <ANTHROPIC_API_KEY>']);
    await checkModel(made.module, { name: 'OPENAI_API_KEY', model: 'gpt-sk-ant-stored-key' });
    expect(made.shown.join('\n')).not.toContain('sk-ant-stored-key');
    expect(made.shown).toContain('Checking gpt-<ANTHROPIC_API_KEY> with OpenAI.');
  });

  test('once the module is stopping, check_model asks the provider nothing, and says so, even waiting behind an open question', async () => {
    const asked: string[] = [];
    const fetchFn = (async (url: string) => { asked.push(String(url)); return models('gpt-6.1-terra'); }) as unknown as typeof fetch;
    const stopped = install({ envFile: 'OPENAI_API_KEY="sk-openai-key"\n', fetch: fetchFn });
    await stopped.module.stop();
    const refused = await checkModel(stopped.module, { name: 'OPENAI_API_KEY', model: 'gpt-6.1-terra' });
    expect(refused.error).toBe('The host is stopping, so setup--check_model checks nothing, and calling it again won\'t change that.');
    let answer: ((value: string | null) => void) | undefined;
    const waiting = install({ envFile: 'OPENAI_API_KEY="sk-openai-key"\n', fetch: fetchFn, asker: { ask: () => new Promise<string | null>((resolve) => { answer = resolve; }) } });
    const open = askSecret(waiting.module, { name: 'OTHER_TOKEN', purpose: 'x' });
    const behind = checkModel(waiting.module, { name: 'OPENAI_API_KEY', model: 'gpt-6.1-terra' });
    while (answer === undefined) await Bun.sleep(1);
    await waiting.module.stop();
    answer(null);
    await open;
    expect((await behind).error).toBe('The host is stopping, so setup--check_model checks nothing, and calling it again won\'t change that.');
    expect(asked).toEqual([]);
  });

  test('a provider key the provider refuses is not stored, leaving what was stored before', async () => {
    for (const [name, provider, status] of [['OPENAI_API_KEY', 'OpenAI', 401], ['ANTHROPIC_API_KEY', 'Anthropic', 401], ['OPENROUTER_API_KEY', 'OpenRouter', 403]] as const) {
      const made = install({
        envFile: `${name}="the-old-key"\n`,
        asker: typed('a-refused-key'),
        fetch: (async () => Response.json({ error: { message: 'invalid x-api-key' } }, { status })) as unknown as typeof fetch,
      });
      const result = await askSecret(made.module, { name, purpose: 'a key' });
      expect(result.success).toBe(false);
      expect(result.error).toBe(name === 'OPENROUTER_API_KEY'
        ? `${provider} refused this key (${status}), so nothing was stored as ${name}, and what was stored as it before stays as it was. Tell the person, and ask them to copy it again, or make a new one, then call again.`
        : `${provider} refused this key (${status}) when setup asked it for its list of models, so nothing was stored as ${name}, and what was stored as it before stays as it was. The key may be wrong or revoked, or it may not be allowed to list models, or to be used from where this machine is. Tell the person, and ask them to check what the key is allowed, or to copy it again, or to make a new one, then call again.`);
      expect(readEnvFile(join(made.dir, '.env')).get(name)).toBe('the-old-key');
      expect(made.shown).toEqual([`Checking it with ${provider}.`, `${provider} refused it (${status}): nothing was stored.`]);
      expect(said(made, result)).not.toContain('a-refused-key');
    }
  });

  test('a provider key the provider answered otherwise, or couldn\'t be asked about, is stored as not known to work, with what to do next, never with the key in the words', async () => {
    const answered = install({
      asker: typed('key-one'),
      fetch: (async () => Response.json({ error: { message: 'overloaded' } }, { status: 529 })) as unknown as typeof fetch,
    });
    const first = await askSecret(answered.module, { name: 'ANTHROPIC_API_KEY', purpose: 'a key' });
    expect(String(first.data)).toBe(`stored as ANTHROPIC_API_KEY in ${join(answered.dir, '.env')}, but it isn't known to work: Anthropic answered 529: overloaded. Call setup--check_model in a minute, to check the key again.`);
    expect(readEnvFile(join(answered.dir, '.env')).get('ANTHROPIC_API_KEY')).toBe('key-one');
    expect(answered.shown.at(-1)).toBe('It\'s stored as ANTHROPIC_API_KEY, though whether it works isn\'t known.');
    const unasked = install({
      asker: typed('key-two'),
      fetch: (async () => { throw new Error('connect ECONNREFUSED, sending Bearer key-two'); }) as unknown as typeof fetch,
    });
    const second = await askSecret(unasked.module, { name: 'OPENROUTER_API_KEY', purpose: 'a key' });
    expect(String(second.data)).toBe(`stored as OPENROUTER_API_KEY in ${join(unasked.dir, '.env')}, but it isn't known to work: OpenRouter couldn't be asked (connect ECONNREFUSED, sending Bearer <OPENROUTER_API_KEY>). Check it again with setup--check_model, or go on with it unchecked.`);
    expect(said(unasked, second)).not.toContain('key-two');
    const otherwise = install({
      asker: typed('key-three'),
      fetch: (async () => Response.json({ error: { message: 'bad request' } }, { status: 400 })) as unknown as typeof fetch,
    });
    const third = await askSecret(otherwise.module, { name: 'ANTHROPIC_API_KEY', purpose: 'a key' });
    expect(String(third.data)).toBe(`stored as ANTHROPIC_API_KEY in ${join(otherwise.dir, '.env')}, but it isn't known to work: Anthropic answered 400: bad request. Check it again with setup--check_model, or go on with it unchecked.`);
  });

  test('a provider key a request header can\'t carry is refused unsent and unstored', async () => {
    let called = 0;
    const made = install({ asker: typed('sk-\u2028broken'), fetch: (async () => { called += 1; return models(); }) as unknown as typeof fetch });
    const result = await askSecret(made.module, { name: 'ANTHROPIC_API_KEY', purpose: 'a key' });
    expect(result.error).toBe('What the person typed for ANTHROPIC_API_KEY holds a character a request header can\'t carry, so it can\'t be a key, and nothing was stored. Ask them to check what they copied, then call again.');
    expect(called).toBe(0);
    expect(readEnvFile(join(made.dir, '.env')).get('ANTHROPIC_API_KEY')).toBeUndefined();
  });

  modeTest('a provider key isn\'t sent, or stored, where .env became unreadable while it was typed, since where to ask about it isn\'t known', async () => {
    let called = 0;
    let envFile = '';
    const made = install({
      envFile: 'ANTHROPIC_BASE_URL=https://gateway.example\n',
      asker: { ask: async () => { chmodSync(envFile, 0o000); return 'sk-ant-key'; } },
      fetch: (async () => { called += 1; return models(); }) as unknown as typeof fetch,
    });
    envFile = join(made.dir, '.env');
    try {
      const result = await askSecret(made.module, { name: 'ANTHROPIC_API_KEY', purpose: 'a key' });
      expect(result.error).toBe(`Nothing was stored as ANTHROPIC_API_KEY: ${join(made.dir, '.env')} can't be read (EACCES), so where Anthropic is to be asked about the key isn't known. Ask the person to put that right, then call again.`);
      expect(called).toBe(0);
    } finally {
      chmodSync(join(made.dir, '.env'), 0o600);
    }
    expect(readFileSync(join(made.dir, '.env'), 'utf-8')).toBe('ANTHROPIC_BASE_URL=https://gateway.example\n');
  });

  test('a provider key isn\'t sent, or stored, where the list of stored secrets was damaged while it was typed, and the answer says which file', async () => {
    let called = 0;
    let dir = '';
    const made = install({
      asker: {
        ask: async () => {
          mkdirSync(join(dir, '.setup'), { recursive: true });
          writeFileSync(join(dir, '.setup', 'stored-secrets.json'), '{"not": "a list"}');
          return 'sk-ant-key';
        },
      },
      fetch: (async () => { called += 1; return models(); }) as unknown as typeof fetch,
    });
    dir = made.dir;
    const result = await askSecret(made.module, { name: 'ANTHROPIC_API_KEY', purpose: 'a key' });
    expect(result.success).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.error).toStartWith('Nothing was stored as ANTHROPIC_API_KEY: ');
    expect(result.error).toContain(join(dir, '.setup', 'stored-secrets.json'));
    expect(result.error).not.toContain('sk-ant-key');
    expect(called).toBe(0);
    expect(existsSync(join(dir, '.env'))).toBe(false);
  });

  test('a 2xx JSON answer that isn\'t the provider\'s list stores the key as not known to work, not as accepted', async () => {
    for (const body of ['{}', '{"data":null}', '{"data":{"id":"gpt-6.1"}}', '{"data":"error"}', '{"data":[{"name":"error"}]}']) {
      const made = install({ asker: typed('sk-openai-key'), fetch: (async () => new Response(body)) as unknown as typeof fetch });
      const result = await askSecret(made.module, { name: 'OPENAI_API_KEY', purpose: 'a key' });
      expect(String(result.data), body).toBe(`stored as OPENAI_API_KEY in ${join(made.dir, '.env')}, but it isn't known to work: OpenAI answered 200. Check it again with setup--check_model, or go on with it unchecked.`);
      expect(made.shown, body).toEqual(['Checking it with OpenAI.', 'OpenAI didn\'t say whether it works: it answered 200.', 'It\'s stored as OPENAI_API_KEY, though whether it works isn\'t known.']);
    }
  });

  test('Anthropic accepts a key by listing models under data, even none, and nothing else 2xx', async () => {
    const accepted = install({ asker: typed('sk-ant-key'), fetch: (async () => Response.json({ data: [] })) as unknown as typeof fetch });
    expect(String((await askSecret(accepted.module, { name: 'ANTHROPIC_API_KEY', purpose: 'a key' })).data)).toBe(`stored as ANTHROPIC_API_KEY in ${join(accepted.dir, '.env')}. Anthropic accepted it: it listed the models the key can use, which shows the key is accepted, not that a call to one of them succeeds.`);
    for (const body of ['{"data":null}', '{"data":{}}', '{}', '{"data":[{"name":"error"}]}']) {
      const made = install({ asker: typed('sk-ant-key'), fetch: (async () => new Response(body)) as unknown as typeof fetch });
      expect(String((await askSecret(made.module, { name: 'ANTHROPIC_API_KEY', purpose: 'a key' })).data), body).toBe(`stored as ANTHROPIC_API_KEY in ${join(made.dir, '.env')}, but it isn't known to work: Anthropic answered 200. Check it again with setup--check_model, or go on with it unchecked.`);
    }
  });

  test('OpenRouter accepts a key by answering for it with an object, as its /api/v1/key does, and nothing else 2xx', async () => {
    const accepted = install({ asker: typed('sk-or-key'), fetch: (async () => Response.json({ data: { label: 'sk-or-v1-abc', usage: 0 } })) as unknown as typeof fetch });
    expect(String((await askSecret(accepted.module, { name: 'OPENROUTER_API_KEY', purpose: 'a key' })).data)).toBe(`stored as OPENROUTER_API_KEY in ${join(accepted.dir, '.env')}. OpenRouter accepted it: it answered for the key.`);
    for (const body of ['{"data":null}', '{"data":[]}', '{}']) {
      const made = install({ asker: typed('sk-or-key'), fetch: (async () => new Response(body)) as unknown as typeof fetch });
      expect(String((await askSecret(made.module, { name: 'OPENROUTER_API_KEY', purpose: 'a key' })).data), body).toBe(`stored as OPENROUTER_API_KEY in ${join(made.dir, '.env')}, but it isn't known to work: OpenRouter answered 200. Check it again with setup--check_model, or go on with it unchecked.`);
    }
  });

  test('check_model checks nothing where .env is a link or outside setup\'s form', async () => {
    let called = 0;
    const counting = (async () => { called += 1; return models('gpt-6.1'); }) as unknown as typeof fetch;
    const linkedTo = install({ fetch: counting });
    writeFileSync(join(linkedTo.dir, 'real.env'), 'OPENAI_API_KEY=sk-openai\n');
    symlinkSync(join(linkedTo.dir, 'real.env'), join(linkedTo.dir, '.env'));
    const viaLink = await checkModel(linkedTo.module, { name: 'OPENAI_API_KEY', model: 'gpt-6.1' });
    expect(viaLink.success).toBe(false);
    expect(String(viaLink.error)).toStartWith('Nothing was checked: ');
    const formless = install({ envFile: 'OPENAI_API_KEY=sk-openai\nexport OPENAI_BASE_URL=https://elsewhere.example\n', fetch: counting });
    const outside = await checkModel(formless.module, { name: 'OPENAI_API_KEY', model: 'gpt-6.1' });
    expect(outside.success).toBe(false);
    expect(String(outside.error)).toStartWith('Nothing was checked: ');
    expect(String(outside.error)).toEndWith('Ask the person to put that right, then call again.');
    expect(called).toBe(0);
  });

  test('check_model says whether the provider offers a model isn\'t known where it answered otherwise or couldn\'t be asked', async () => {
    const overloaded = install({ envFile: 'ANTHROPIC_API_KEY=sk-ant\n', fetch: (async () => Response.json({ error: { message: 'overloaded' } }, { status: 529 })) as unknown as typeof fetch });
    const answered = await checkModel(overloaded.module, { name: 'ANTHROPIC_API_KEY', model: 'claude-opus-5-5' });
    expect(answered.error).toBe('Whether Anthropic offers claude-opus-5-5 to the key stored as ANTHROPIC_API_KEY isn\'t known: Anthropic answered 529: overloaded. Call setup--check_model again in a minute, and if it answers the same, tell the person what it says.');
    const down = install({ envFile: 'ANTHROPIC_API_KEY=sk-ant\n', fetch: (async () => { throw new Error('connect ECONNREFUSED'); }) as unknown as typeof fetch });
    const unasked = await checkModel(down.module, { name: 'ANTHROPIC_API_KEY', model: 'claude-opus-5-5' });
    expect(unasked.error).toBe('Whether Anthropic offers claude-opus-5-5 to the key stored as ANTHROPIC_API_KEY isn\'t known: Anthropic couldn\'t be asked (connect ECONNREFUSED). Call setup--check_model again in a minute, and if it answers the same, tell the person what it says.');
  });

  test('check_model passes on the wait a provider asks for with Retry-After, in seconds or as a date, in place of a minute', async () => {
    const limited = (after: string) => install({
      envFile: 'ANTHROPIC_API_KEY=sk-ant\n',
      fetch: (async () => Response.json({ error: { message: 'rate limited' } }, { status: 429, headers: { 'retry-after': after } })) as unknown as typeof fetch,
    });
    const seconds = await checkModel(limited('3600').module, { name: 'ANTHROPIC_API_KEY', model: 'claude-opus-5-5' });
    expect(seconds.error).toBe('Whether Anthropic offers claude-opus-5-5 to the key stored as ANTHROPIC_API_KEY isn\'t known: Anthropic answered 429: rate limited. It asks for a wait of 3600 s before the next call: call setup--check_model again once that has passed, and if that\'s longer than the person would wait, tell them what it says and how long it asks them to wait.');
    const date = await checkModel(limited('Fri, 06 Nov 2026 16:00:00 GMT').module, { name: 'ANTHROPIC_API_KEY', model: 'claude-opus-5-5' });
    expect(date.error).toEndWith('It asks for no call before Fri, 06 Nov 2026 16:00:00 GMT: call setup--check_model again once that has passed, and if that\'s longer than the person would wait, tell them what it says and how long it asks them to wait.');
    const guessed = install({
      envFile: 'ANTHROPIC_API_KEY=sk-ant\nNOT_SETUPS=0\n',
      fetch: (async () => Response.json({ error: { message: 'rate limited' } }, { status: 429, headers: { 'retry-after': '60' } })) as unknown as typeof fetch,
    });
    const hiddenDigits = await checkModel(guessed.module, { name: 'ANTHROPIC_API_KEY', model: 'claude-opus-5-5' });
    expect(hiddenDigits.error).not.toContain('<NOT_SETUPS>');
    expect(hiddenDigits.error).toEndWith('Anthropic answered 429: rate limited. It asks for a wait setup can\'t show without what may be a secret, so when to call setup--check_model again isn\'t known: tell the person what it says.');
    const neither = await checkModel(limited('ask again later').module, { name: 'ANTHROPIC_API_KEY', model: 'claude-opus-5-5' });
    expect(neither.error).toEndWith('Anthropic answered 429: rate limited. Call setup--check_model again in a minute, and if it answers the same, tell the person what it says.');
  });

  test('a key answered 429 or 5xx at ask_secret gives the wait asked for, and says to check it again with setup--check_model', async () => {
    const answering = (status: number, after?: string) => (async () => Response.json({ error: { message: 'busy' } },
      { status, headers: after === undefined ? {} : { 'retry-after': after } })) as unknown as typeof fetch;
    const waited = install({ asker: typed('sk-ant-waited'), fetch: answering(429, '60') });
    expect(String((await askSecret(waited.module, { name: 'ANTHROPIC_API_KEY', purpose: 'a key' })).data)).toEndWith(
      'but it isn\'t known to work: Anthropic answered 429: busy. It asks for a wait of 60 s before the next call: call ' +
      'setup--check_model once that has passed, to check the key again.');
    expect(waited.shown).toContain('Anthropic didn\'t say whether it works: it answered 429 (busy). It asks for a wait of 60 s before the next call.');
    const down = install({ asker: typed('sk-ant-down'), fetch: answering(503) });
    expect(String((await askSecret(down.module, { name: 'ANTHROPIC_API_KEY', purpose: 'a key' })).data)).toEndWith(
      'but it isn\'t known to work: Anthropic answered 503: busy. Call setup--check_model in a minute, to check the key again.');
    const guessed = install({ asker: typed('sk-ant-guessed'), envFile: 'NOT_SETUPS=0\n', fetch: answering(429, '60') });
    expect(String((await askSecret(guessed.module, { name: 'ANTHROPIC_API_KEY', purpose: 'a key' })).data)).toEndWith(
      'but it isn\'t known to work: Anthropic answered 429: busy. It asks for a wait setup can\'t show without what may be a ' +
      'secret, so when setup--check_model can check the key again isn\'t known.');
    expect(guessed.shown).toContain('Anthropic didn\'t say whether it works: it answered 429 (busy). It asks for a wait setup can\'t show without what may be a secret.');
    const other = install({ asker: typed('sk-ant-other'), fetch: answering(400) });
    expect(String((await askSecret(other.module, { name: 'ANTHROPIC_API_KEY', purpose: 'a key' })).data)).toEndWith(
      'but it isn\'t known to work: Anthropic answered 400: busy. Check it again with setup--check_model, or go on with it unchecked.');
  });

  test('a refusal whose type isn\'t JSON is said not to say it\'s JSON, and a 2xx typed JSON whose body isn\'t is said not to be JSON', async () => {
    const page = (async () => new Response('<html>Sign in</html>', { status: 401, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
    const key = install({ asker: typed('sk-ant-page'), fetch: page });
    expect(String((await askSecret(key.module, { name: 'ANTHROPIC_API_KEY', purpose: 'a key' })).data))
      .toContain('but it couldn\'t be checked: its answer didn\'t say it was JSON, as Anthropic\'s do: a network\'s sign-in page is one such answer.');
    expect(key.shown).toContain('It couldn\'t be checked: its answer didn\'t say it was JSON, as Anthropic\'s do: a network\'s sign-in page is one such answer.');
    const token = install({ asker: typed('a-page-token'), fetch: page });
    expect(String((await askSecret(token.module, { name: 'DISCORD_TOKEN', purpose: 'the bot token' })).data))
      .toContain('but it couldn\'t be checked: its answer didn\'t say it was JSON, as Discord\'s do: a network\'s sign-in page is one such answer.');
    const typedJson = (async () => new Response('<html>', { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const mislabelled = install({ asker: typed('sk-ant-mislabelled'), fetch: typedJson });
    expect(String((await askSecret(mislabelled.module, { name: 'ANTHROPIC_API_KEY', purpose: 'a key' })).data))
      .toContain('but it couldn\'t be checked: its answer wasn\'t JSON, as Anthropic\'s are: a network\'s sign-in page is one such answer.');
  });

  test('a 2xx that isn\'t JSON, such as a sign-in page, is said to be no check, of a key, a token and a model, with what to tell the person', async () => {
    const portal = (async () => new Response('<html>Sign in to this network</html>', { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
    const key = install({ asker: typed('sk-ant-portal'), fetch: portal });
    const stored = await askSecret(key.module, { name: 'ANTHROPIC_API_KEY', purpose: 'a key' });
    expect(String(stored.data)).toBe(`stored as ANTHROPIC_API_KEY in ${join(key.dir, '.env')}, but it couldn't be checked: its answer wasn't JSON, as Anthropic's are: a network's sign-in page is one such answer. Tell the person: their connection to it is theirs to check. Check it again with setup--check_model, or go on with it unchecked.`);
    expect(key.shown).toContain('It couldn\'t be checked: its answer wasn\'t JSON, as Anthropic\'s are: a network\'s sign-in page is one such answer.');
    const token = install({ asker: typed('a-portal-token'), fetch: portal });
    const told = await askSecret(token.module, { name: 'DISCORD_TOKEN', purpose: 'the bot token' });
    expect(String(told.data)).toBe(`stored as DISCORD_TOKEN in ${join(token.dir, '.env')}, but it couldn't be checked: its answer wasn't JSON, as Discord's are: a network's sign-in page is one such answer. Tell the person: their connection to it is theirs to check. Ask for it again with setup--ask_secret to check it again, or go on with it unchecked.`);
    const model = await checkModel(install({ envFile: 'ANTHROPIC_API_KEY=sk-ant\n', fetch: portal }).module, { name: 'ANTHROPIC_API_KEY', model: 'claude-opus-5-5' });
    expect(model.error).toBe('Whether Anthropic offers claude-opus-5-5 to the key stored as ANTHROPIC_API_KEY isn\'t known: its answer wasn\'t JSON, as Anthropic\'s are: a network\'s sign-in page is one such answer. Tell the person: their connection to it is theirs to check.');
  });

  test('a token answered with an error that isn\'t JSON is said not to say it\'s JSON, and a 429 or 5xx says, in place of the connection advice, that setup--discord checks it again, to the agent, and doctor, to the person', async () => {
    const BUSY = ' It may be busy: `connectome doctor` checks the token again when it runs.';
    const AGENT_BUSY = ' It may be busy: call setup--discord in a minute, which checks the stored token first.';
    const CONNECTION = ' Tell the person: their connection to it is theirs to check. Ask for it again with setup--ask_secret to ' +
      'check it again, or go on with it unchecked.';
    for (const [status, after] of [[503, AGENT_BUSY], [429, AGENT_BUSY], [403, CONNECTION]] as const) {
      const page = (async () => new Response('<html>error</html>', { status, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
      const token = install({ asker: typed('a-page-token'), fetch: page });
      const told = await askSecret(token.module, { name: 'DISCORD_TOKEN', purpose: 'the bot token' });
      const unrecognized = 'its answer didn\'t say it was JSON, as Discord\'s do: a network\'s sign-in page is one such answer.';
      expect(String(told.data), String(status)).toBe(`stored as DISCORD_TOKEN in ${join(token.dir, '.env')}, but it couldn't be ` +
        `checked: ${unrecognized}${after}`);
      expect(token.shown, String(status)).toContain(`It couldn't be checked: ${unrecognized}${after === AGENT_BUSY ? BUSY : ''}`);
    }
  });

  test('a token Discord answered 429 or 5xx in JSON is said with its status and Discord\'s words, then, in place of asking for it again, that setup--discord checks it again after any wait Discord asks, to the agent, and that doctor does, to the person', async () => {
    const BUSY = ' It may be busy: `connectome doctor` checks the token again when it runs.';
    const AGAIN = ' Ask for it again with setup--ask_secret to check it again, or go on with it unchecked.';
    const AGENT_BUSY = ' It may be busy: call setup--discord in a minute, which checks the stored token first.';
    const WAIT = ' It asks for 3 s: call setup--discord once that has passed, which checks the stored token first.';
    for (const [status, words, after] of [[503, 'Service Unavailable', AGENT_BUSY], [429, 'You are being rate limited', WAIT], [403, 'Missing Access', AGAIN]] as const) {
      const answering = (async () => Response.json({ message: words, retry_after: 2.5 }, { status })) as unknown as typeof fetch;
      const token = install({ asker: typed('a-busy-token'), fetch: answering });
      const told = await askSecret(token.module, { name: 'DISCORD_TOKEN', purpose: 'the bot token' });
      expect(String(told.data), String(status)).toBe(`stored as DISCORD_TOKEN in ${join(token.dir, '.env')}, but it isn't known to ` +
        `work: Discord answered ${status}: ${words}.${after}`);
      expect(token.shown, String(status)).toContain(`Discord didn't say whether it works: it answered ${status} (${words}).` +
        (after === AGAIN ? '' : BUSY));
    }
  });

  test('a token Discord answered 200 with something other than a bot\'s user is said so, to the agent and the person, with what may be answering in its place', async () => {
    const odd = (async () => Response.json({})) as unknown as typeof fetch;
    const token = install({ asker: typed('a-strange-token'), fetch: odd });
    const told = await askSecret(token.module, { name: 'DISCORD_TOKEN', purpose: 'the bot token' });
    expect(String(told.data)).toBe(`stored as DISCORD_TOKEN in ${join(token.dir, '.env')}, but it isn't known to work: Discord answered GET /users/@me with something other than the bot's user. Tell the person: something between this machine and Discord may be answering in its place. Ask for it again with setup--ask_secret to check it again, or go on with it unchecked.`);
    expect(token.shown).toContain('It isn\'t known to work: Discord answered with something other than the bot\'s user, so something between this machine and Discord may be answering in its place.');
  });

  test('a redirect is named, with the server it leads to, and what to set where a base URL can be set, for a key, a token and a model', async () => {
    const redirecting = (async (_url: string, init?: RequestInit) => init?.redirect === 'manual'
      ? new Response(null, { status: 307, headers: { location: 'https://api.example.test/v1/models?from=old' } })
      : Response.json({ data: [] })) as unknown as typeof fetch;
    const openai = install({ asker: typed('sk-openai-moved'), fetch: redirecting });
    const stored = await askSecret(openai.module, { name: 'OPENAI_API_KEY', purpose: 'a key' });
    expect(String(stored.data)).toBe(`stored as OPENAI_API_KEY in ${join(openai.dir, '.env')}, but it isn't known to work: OpenAI answered 307, a redirect to https://api.example.test, which setup doesn't follow with a secret. If OPENAI_BASE_URL in .env is meant to lead to that server, ask the person for the base URL its API is under, the one its own instructions give for OPENAI_BASE_URL, with setup--ask_secret as OPENAI_BASE_URL, since a base URL can carry a credential, then call again. Check it again with setup--check_model, or go on with it unchecked.`);
    expect(openai.shown).toContain('It isn\'t known to work: OpenAI answered 307, a redirect to https://api.example.test, which setup doesn\'t follow with a secret.');
    const openrouter = install({ asker: typed('sk-or-moved'), fetch: redirecting });
    const routed = await askSecret(openrouter.module, { name: 'OPENROUTER_API_KEY', purpose: 'a key' });
    expect(String(routed.data)).toEndWith('which setup doesn\'t follow with a secret. If OPENROUTER_BASE_URL in .env is meant to lead to that server, ask the person for the base URL its API is under, the one its own instructions give for OPENROUTER_BASE_URL, with setup--ask_secret as OPENROUTER_BASE_URL, since a base URL can carry a credential, then call again. Check it again with setup--check_model, or go on with it unchecked.');
    const discord = install({ asker: typed('a-moved-token'), fetch: redirecting });
    const token = await askSecret(discord.module, { name: 'DISCORD_TOKEN', purpose: 'the bot token' });
    expect(String(token.data)).toEndWith('Discord answered 307, a redirect to https://api.example.test, which setup doesn\'t follow with a secret. Something between this machine and Discord may have sent it, or Discord itself: tell the person, and that if it wasn\'t Discord, their connection is theirs to check. Ask for it again with setup--ask_secret to check it again, or go on with it unchecked.');
    const model = await checkModel(install({ envFile: 'ANTHROPIC_API_KEY=sk-ant\n', fetch: redirecting }).module, { name: 'ANTHROPIC_API_KEY', model: 'claude-opus-5-5' });
    expect(model.error).toBe('Whether Anthropic offers claude-opus-5-5 to the key stored as ANTHROPIC_API_KEY isn\'t known: Anthropic answered 307, a redirect to https://api.example.test, which setup doesn\'t follow with a secret. If ANTHROPIC_BASE_URL in .env is meant to lead to that server, ask the person for the base URL its API is under, the one its own instructions give for ANTHROPIC_BASE_URL, with setup--ask_secret as ANTHROPIC_BASE_URL, since a base URL can carry a credential, then call again.');
  });

  test('a base URL is taken by setup--ask_secret, as the redirect\'s remedy asks, and stored as a secret is', async () => {
    const made = install({ asker: typed('https://proxy.example/private-token/v1') });
    const result = await askSecret(made.module, { name: 'OPENAI_BASE_URL', purpose: 'the base URL its API is under' });
    expect(result.success, result.error).toBe(true);
    expect(String(result.data)).toBe(`stored as OPENAI_BASE_URL in ${join(made.dir, '.env')}`);
    expect(readEnvFile(join(made.dir, '.env')).get('OPENAI_BASE_URL')).toBe('https://proxy.example/private-token/v1');
    expect(made.module.storedSecrets.names()).toContain('OPENAI_BASE_URL');
  });

  test('a redirect whose Location is relative names the server that was asked, and none of a credential its base URL carries, for a key, a token and a model', async () => {
    const relative = (async (_url: string, init?: RequestInit) => init?.redirect === 'manual'
      ? new Response(null, { status: 302, headers: { location: '/login?next=models' } })
      : Response.json({ data: [] })) as unknown as typeof fetch;
    const openai = install({ asker: typed('sk-openai-moved'), fetch: relative });
    const stored = await askSecret(openai.module, { name: 'OPENAI_API_KEY', purpose: 'a key' });
    expect(String(stored.data)).toContain('OpenAI answered 302, a redirect to https://api.openai.com, which setup doesn\'t follow with a secret.');
    const discord = install({ asker: typed('a-moved-token'), fetch: relative });
    const token = await askSecret(discord.module, { name: 'DISCORD_TOKEN', purpose: 'the bot token' });
    expect(String(token.data)).toContain('Discord answered 302, a redirect to https://discord.com, which setup doesn\'t follow with a secret.');
    const gateway = install({ envFile: 'ANTHROPIC_API_KEY=sk-ant\nANTHROPIC_BASE_URL=https://someone:private-pass@gateway.example.test/anthropic\n', fetch: relative });
    const model = await checkModel(gateway.module, { name: 'ANTHROPIC_API_KEY', model: 'claude-opus-5-5' });
    expect(model.error).toContain('ANTHROPIC_BASE_URL\'s server answered 302, a redirect to https://gateway.example.test, which setup doesn\'t follow with a secret.');
    expect(model.error).not.toContain('private-pass');
  });

  test('a redirect shows no part of a base URL that carries a credential, its path included', async () => {
    const moved = (async (_url: string, init?: RequestInit) => init?.redirect === 'manual'
      ? new Response(null, { status: 302, headers: { location: 'https://other.example/private-token/v1/models' } })
      : Response.json({ data: [] })) as unknown as typeof fetch;
    const made = install({ envFile: 'OPENAI_BASE_URL="https://proxy.example/private-token/v1"\n', asker: typed('sk-openai-moved'), fetch: moved });
    listSecrets(made.module, 'OPENAI_BASE_URL');
    const stored = await askSecret(made.module, { name: 'OPENAI_API_KEY', purpose: 'a key' });
    expect(String(stored.data)).not.toContain('private-token');
    expect(made.shown.join('\n')).not.toContain('private-token');
    expect(String(stored.data)).toContain('a redirect to https://other.example, which setup doesn\'t follow with a secret.');
    const model = await checkModel(install({ envFile: 'OPENAI_BASE_URL="https://proxy.example/private-token/v1"\nOPENAI_API_KEY="sk-openai"\n', fetch: moved }).module, { name: 'OPENAI_API_KEY', model: 'gpt-5' });
    expect(model.error).not.toContain('private-token');
    expect(model.error).toContain('a redirect to https://other.example, which setup doesn\'t follow with a secret');
  });

  test('check_model says whether a model is offered isn\'t known where the list\'s entries carry no ids', async () => {
    const listed = install({
      envFile: 'ANTHROPIC_API_KEY=sk-ant\n',
      fetch: (async () => Response.json({ data: [{ name: 'claude-x' }] })) as unknown as typeof fetch,
    });
    const result = await checkModel(listed.module, { name: 'ANTHROPIC_API_KEY', model: 'claude-x' });
    expect(result.success).toBe(false);
    expect(String(result.error)).toStartWith('Whether Anthropic offers claude-x to the key stored as ANTHROPIC_API_KEY isn\'t known:');
  });

  test('check_model doesn\'t say a model is unlisted where the provider says it lists more than one answer holds', async () => {
    const paged = install({ envFile: 'ANTHROPIC_API_KEY=sk-ant\n', fetch: (async () => Response.json({ data: [{ id: 'claude-haiku-5-5' }], has_more: true })) as unknown as typeof fetch });
    const absent = await checkModel(paged.module, { name: 'ANTHROPIC_API_KEY', model: 'claude-opus-5-5' });
    expect(absent.error).toBe('Whether Anthropic offers claude-opus-5-5 to the key stored as ANTHROPIC_API_KEY isn\'t known: it lists more models than one answer holds, and claude-opus-5-5 isn\'t among the first 1. Ask the person whether claude-opus-5-5 is the one they meant before the recipe names it.');
    const there = await checkModel(paged.module, { name: 'ANTHROPIC_API_KEY', model: 'claude-haiku-5-5' });
    expect(String(there.data)).toBe('Anthropic lists claude-haiku-5-5 among the first 1 models it offers the key stored as ANTHROPIC_API_KEY.');
  });

  test('check_model shows a model the provider lists by a stored secret\'s name where its id holds that secret, the key\'s own included', async () => {
    const echo = install({
      envFile: 'OPENAI_API_KEY=sk-openai-echo\nDISCORD_TOKEN=discord-echo-token\n',
      fetch: (async () => models('gpt-sk-openai-echo', 'gpt-discord-echo-token', 'gpt-6.1')) as unknown as typeof fetch,
    });
    const result = await checkModel(echo.module, { name: 'OPENAI_API_KEY', model: 'gpt-6.1-terra' });
    expect(result.error).toContain('gpt-<OPENAI_API_KEY>');
    expect(result.error).toContain('gpt-<DISCORD_TOKEN>');
    expect(said(echo, result)).not.toContain('sk-openai-echo');
    expect(said(echo, result)).not.toContain('discord-echo-token');
  });

  test('check_model finds a listed model whose id holds a secret\'s value, as a guessed one-digit value can be', async () => {
    const listed = install({
      envFile: 'ANTHROPIC_API_KEY=sk-ant\nDEBUG=7\n',
      fetch: (async () => models('claude-opus-4-7')) as unknown as typeof fetch,
    });
    const result = await checkModel(listed.module, { name: 'ANTHROPIC_API_KEY', model: 'claude-opus-4-7' });
    expect({ success: result.success, data: result.data }).toEqual({
      success: true, data: 'Anthropic lists claude-opus-4-7 among the 1 models it offers the key stored as ANTHROPIC_API_KEY.',
    });
  });

  test('an OPENAI_COMPATIBLE_API_KEY is stored without being checked', async () => {
    let called = 0;
    const made = install({ asker: typed('a-value'), fetch: (async () => { called += 1; return models(); }) as unknown as typeof fetch });
    const result = await askSecret(made.module, { name: 'OPENAI_COMPATIBLE_API_KEY', purpose: 'a key' });
    expect(String(result.data)).toBe(`stored as OPENAI_COMPATIBLE_API_KEY in ${join(made.dir, '.env')}`);
    expect(called).toBe(0);
  });

  test('an OPENROUTER_API_KEY is checked, and its models listed, at the OPENROUTER_BASE_URL .env names', async () => {
    const requests: string[] = [];
    const routing = (async (url: string) => {
      requests.push(String(url));
      return String(url).endsWith('/key') ? Response.json({ data: { label: 'sk-or-…' } }) : models('openai/gpt-6.1-terra');
    }) as unknown as typeof fetch;
    const made = install({ envFile: 'OPENROUTER_BASE_URL=https://router.example/api/v1/\n', asker: typed('sk-or-routed'), fetch: routing });
    const stored = await askSecret(made.module, { name: 'OPENROUTER_API_KEY', purpose: 'a key' });
    expect(stored.success, stored.error).toBe(true);
    const listed = await checkModel(made.module, { name: 'OPENROUTER_API_KEY', model: 'openai/gpt-6.1-terra' });
    expect(listed.success, listed.error).toBe(true);
    expect(requests).toEqual(['https://router.example/api/v1/key', 'https://router.example/api/v1/models']);
  });

  test('check_model says a model the provider lists for the stored key is listed, never showing the key', async () => {
    const requests: string[] = [];
    const made = install({
      envFile: 'OPENROUTER_API_KEY=sk-or-key\n',
      fetch: (async (url: string, init: RequestInit) => {
        requests.push(`${String(url)} ${new Headers(init.headers).get('authorization')}`);
        return models('openai/gpt-6.1-terra', 'anthropic/claude-opus-5-5');
      }) as unknown as typeof fetch,
    });
    const result = await checkModel(made.module, { name: 'OPENROUTER_API_KEY', model: 'openai/gpt-6.1-terra' });
    expect(result.success, result.error).toBe(true);
    expect(requests).toEqual(['https://openrouter.ai/api/v1/models Bearer sk-or-key']);
    expect(String(result.data)).toBe('OpenRouter lists openai/gpt-6.1-terra among the 2 models it offers the key stored as OPENROUTER_API_KEY.');
    expect(made.shown).toEqual(['Checking openai/gpt-6.1-terra with OpenRouter.', 'OpenRouter lists openai/gpt-6.1-terra for this key.']);
    expect(said(made, result)).not.toContain('sk-or-key');
  });

  test('check_model names the listed models of an unlisted model\'s family, or says how many there are where none share it', async () => {
    const made = install({
      envFile: 'OPENAI_API_KEY=sk-openai\n',
      fetch: (async () => models('gpt-6.1', 'gpt-6.1-mini', 'o9', 'gpt.x')) as unknown as typeof fetch,
    });
    const kin = await checkModel(made.module, { name: 'OPENAI_API_KEY', model: 'gpt-6.1-terra' });
    expect(kin.success).toBe(false);
    expect(kin.error).toBe('OpenAI doesn\'t list gpt-6.1-terra among the 4 models it offers the key stored as OPENAI_API_KEY. Of its family, gpt, it lists: gpt-6.1, gpt-6.1-mini, gpt.x. Ask the person which they meant before the recipe names it.');
    const none = await checkModel(made.module, { name: 'OPENAI_API_KEY', model: 'davinci-9' });
    expect(none.error).toBe('OpenAI doesn\'t list davinci-9 among the 4 models it offers the key stored as OPENAI_API_KEY, and none of its family, davinci. Ask the person which they meant before the recipe names it.');
  });

  test('check_model with a stored key a request header can\'t carry asks nothing and says to ask for the key again, saying nothing of storing', async () => {
    let called = 0;
    const made = install({ envFile: 'OPENAI_API_KEY="sk-\u2028broken"\n', fetch: (async () => { called += 1; return models(); }) as unknown as typeof fetch });
    const result = await checkModel(made.module, { name: 'OPENAI_API_KEY', model: 'gpt-6.1-terra' });
    expect(result.error).toBe('The key stored as OPENAI_API_KEY holds a character a request header can\'t carry, so it can\'t be a key: ask the person for it again with setup--ask_secret.');
    expect(made.shown).toEqual(['Checking gpt-6.1-terra with OpenAI.', 'The key stored as OPENAI_API_KEY holds a character a request header can\'t carry, so it can\'t be a key.']);
    expect(called).toBe(0);
  });

  test('check_model with no key stored, a refused key, or a name setup doesn\'t check, asks nothing it can\'t and says why', async () => {
    let called = 0;
    const made = install({ fetch: (async () => { called += 1; return Response.json({}, { status: 401 }); }) as unknown as typeof fetch });
    const missing = await checkModel(made.module, { name: 'OPENAI_API_KEY', model: 'gpt-6.1-terra' });
    expect(missing.error).toBe(`Nothing is stored as OPENAI_API_KEY in ${join(made.dir, '.env')}, so there's no key to check gpt-6.1-terra with. Ask the person for it with setup--ask_secret first.`);
    expect(called).toBe(0);
    const other = await checkModel(made.module, { name: 'AWS_ACCESS_KEY_ID', model: 'anthropic.claude' });
    expect(other.error).toBe('setup--check_model checks models for the keys stored as OPENAI_API_KEY, ANTHROPIC_API_KEY, OPENROUTER_API_KEY, not AWS_ACCESS_KEY_ID: Bedrock\'s requests need AWS\'s signing, Codex runs on a ChatGPT login, and an openai-compatible endpoint is the recipe\'s.');
    writeFileSync(join(made.dir, '.env'), 'ANTHROPIC_API_KEY=sk-ant-old\n', { mode: 0o600 });
    const refused = await checkModel(made.module, { name: 'ANTHROPIC_API_KEY', model: 'claude-opus-5-5' });
    expect(refused.error).toBe('Anthropic refused the key stored as ANTHROPIC_API_KEY (401) when setup asked it for its list of models, so whether it offers claude-opus-5-5 isn\'t known. The key may be wrong or revoked, or it may not be allowed to list models, or to be used from where this machine is. Ask the person to check what the key is allowed, or for a new key with setup--ask_secret.');
    expect(called).toBe(1);
  });
});

describe('the waits in these tests', () => {
  test('measure elapsed time, so a step of the wall clock doesn\'t end one early', async () => {
    const later = join(scratch(), 'later');
    setTimeout(() => writeFileSync(later, 'came\n'), 100);
    const real = Date.now.bind(Date);
    let steps = 0;
    const stepped = spyOn(Date, 'now').mockImplementation(() => real() + 60_000 * ++steps);
    try {
      expect(await waitForFile(later)).toBe('came');
    } finally {
      stepped.mockRestore();
    }
  });
});
