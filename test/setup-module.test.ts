import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ToolCall, ToolResult } from '@animalabs/agent-framework';
import { SetupModule, commandsShownNote, openingMessage, type SecretAsker } from '../src/modules/setup-module.js';
import { EnvFormError, envForm, readEnvFile, storedSecretRedactor, writeEnvValue } from '../src/setup/secrets.js';
import { PASTE_QUIET_MS, askHidden } from '../src/setup/terminal-secret.js';
import { bracketedPaste } from '../src/readline-paste.js';
import { checkDiscordToken } from '../src/setup/discord-token.js';

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

// For tests that read /proc or run setsid(1): macOS has neither, and a Linux container may not mount /proc.
const linuxTest = test.skipIf(process.platform !== 'linux' || !existsSync('/proc/self/stat'));

function alive(pid: number): boolean {
  try {
    // kill(pid, 0) succeeds for a zombie too, so read the state /proc gives after the name in parentheses.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

const uptime = () => Number(readFileSync('/proc/uptime', 'utf-8').split(' ')[0]);

async function goneWithin(pid: number, ms: number): Promise<boolean> {
  for (const until = Date.now() + ms; alive(pid) && Date.now() < until;) await Bun.sleep(20);
  return !alive(pid);
}

async function waitForFile(path: string): Promise<string> {
  for (const until = Date.now() + 10_000; Date.now() < until; await Bun.sleep(10)) {
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
};

describe('setup--finished', () => {
  const call = (module: SetupModule) => module.handleToolCall({ id: 'f', name: 'finished', input: {} } as ToolCall);
  test('records when setup finished beside its answers, and asks the host to end the conversation', async () => {
    const { dir, module } = install();
    mkdirSync(join(dir, '.setup'), { recursive: true });
    writeFileSync(join(dir, '.setup', 'setup-state.json'), JSON.stringify({ v: 1, shell: true }));
    expect(module.finishedAt()).toBeNull();
    const before = Date.now();
    const result = await call(module);
    expect(result.success).toBe(true);
    const state = JSON.parse(readFileSync(join(dir, '.setup', 'setup-state.json'), 'utf-8')) as { v: number; shell: boolean; finished: string };
    expect(state.v).toBe(1);
    expect(state.shell).toBe(true);
    expect(Date.parse(state.finished)).toBeGreaterThanOrEqual(before - 1000);
    expect(String(result.data)).toBe(`Recorded that setup finished at ${state.finished}. The conversation ends after this turn, once anything the person typed meanwhile has come to you as further turns.`);
    expect(statSync(join(dir, '.setup', 'setup-state.json')).mode & 0o777).toBe(0o600);
    expect(module.finishRequested).toBe(true);
    expect(module.finishedAt()).toBe(state.finished);
  });

  test('with no answers of setup\'s to put it beside, records nothing and leaves the conversation going', async () => {
    const { dir, module } = install();
    const result = await call(module);
    expect(result.success).toBe(false);
    expect(String(result.error)).toBe(`${join(dir, '.setup', 'setup-state.json')} doesn't hold setup's answers, so nothing was recorded and the conversation goes on. Tell the person: running setup again asks its questions again.`);
    expect(module.finishRequested).toBe(false);
  });

  test('where its answers can\'t be written, records nothing, says what stopped it and what to do, and leaves the conversation going', async () => {
    const { dir, module } = install();
    mkdirSync(join(dir, '.setup'), { recursive: true });
    writeFileSync(join(dir, '.setup', 'setup-state.json'), JSON.stringify({ v: 1, shell: true }));
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
    expect(openingMessage(false, 'start')).toBe('From setup, not the person: they\'ve just started setup and are at this terminal.');
  });
});

describe('setup--run', () => {
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

  test('shows the person each command whole before it runs, with a stored secret\'s value as its name and what a terminal would act on as its escape', async () => {
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
    expect(commandsShownNote(dir)).toBe(`Setup's agent runs each command in ${dir.replace('\u202e\t', '\\u202e\\u0009')}, as you. You'll see each command whole before it runs, each of its lines on a line of its own, any character a terminal would hide or act on shown as a code, such as \\u001b for Escape, and each key or token setup knows of shown by its name in place of its value, such as <ANTHROPIC_API_KEY>.`);
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
    for (const started = Date.now(); answer === undefined && Date.now() - started < 5_000; await new Promise((done) => setTimeout(done, 10)));
    expect(answer).toBeDefined();
    const running = run(module, 'touch ran');
    await new Promise((done) => setTimeout(done, 300));
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

  test('a command runs without DATA_DIR, CONNECTOME_UPDATE_CHECK and setup\'s own variables, which are for setup\'s host alone', async () => {
    const { module } = install({
      env: { DATA_DIR: '/setup/data', CONNECTOME_UPDATE_CHECK: '0', CONNECTOME_SETUP_INSTALL: '/setup/root', KEEP_ME: 'kept' },
    });
    const answer = await run(module, 'env | grep -E "^(DATA_DIR|CONNECTOME_[A-Z0-9_]*|KEEP_ME)=" | sort');
    expect(answer.stdout.text).toBe('KEEP_ME=kept\n');
  });

  test('a secret a dotenv file beside .env gives, with the value Bun expands it to, is shown by its name in a command\'s output', async () => {
    const { dir, module } = install({ envFile: 'DISCORD_TOKEN="discord-token-value"\n' });
    writeFileSync(join(dir, '.env.local'), 'BASE=local-base\nMY_TOKEN=${BASE}-suffix\n');
    const answer = await run(module, 'echo "token local-base-suffix"');
    expect(answer.stdout.text).toBe('token <MY_TOKEN>\n');
  });

  test('a secret a dotenv file names as a name every object has, such as constructor, is shown by its name in a command\'s output', async () => {
    const { dir, module } = install({ envFile: 'DISCORD_TOKEN="discord-token-value"\n' });
    writeFileSync(join(dir, '.env.local'), 'constructor=private-token\n');
    const answer = await run(module, 'echo "token private-token"');
    expect(answer.stdout.text).toBe('token <constructor>\n');
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

  test('a stored secret a command changes in .env and prints in that same command is shown by its name', async () => {
    const { module } = install({ envFile: 'DISCORD_TOKEN="old-token-value"\n' });
    listSecrets(module, 'DISCORD_TOKEN');
    const answer = await run(module, 'printf \'DISCORD_TOKEN="new-token-value"\\n\' > .env; cat .env');
    expect(answer.stdout.text).toBe('DISCORD_TOKEN="<DISCORD_TOKEN>"\n');
  });

  linuxTest('stops a command at its limit with every process in its group, says so, and answers', async () => {
    const { dir, module } = install();
    const pidFile = join(dir, 'child.pid');
    const started = Date.now();
    const answer = await run(module, `sleep 30 & echo $! > ${pidFile}; echo begun; sleep 30`, 500);
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(answer.stoppedAtLimit).toBe(true);
    expect(answer.note).toContain('500 ms limit');
    expect(answer.stdout.text).toBe('begun\n');
    expect(await goneWithin(Number(readFileSync(pidFile, 'utf-8')), 3_000)).toBe(true);
  }, 20_000);

  linuxTest('kills a process in its group that outlives its SIGTERM, 5 s after that SIGTERM, even once the command itself has ended', async () => {
    const { dir, module } = install();
    const pidFile = join(dir, 'stubborn.pid');
    const termFile = join(dir, 'term-at');
    const answering = run(module, `(trap 'cut -d" " -f1 /proc/uptime > ${termFile}' TERM; echo $BASHPID > ${pidFile}; while :; do sleep 0.1; done) & while [ ! -s ${pidFile} ]; do sleep 0.01; done; sleep 30`, 3_000);
    const stubborn = Number(await waitForFile(pidFile));
    const termAt = Number(await waitForFile(termFile));
    let goneAt: number | null = null;
    for (const until = termAt + 15; goneAt === null && uptime() < until; await Bun.sleep(20)) {
      if (!alive(stubborn)) goneAt = uptime();
    }
    const answer = await answering;
    expect(answer.stoppedAtLimit).toBe(true);
    expect(goneAt).not.toBeNull();
    expect(Math.round((goneAt! - termAt) * 1000)).toBeGreaterThanOrEqual(4_500);
  }, 30_000);

  linuxTest('stopping the module within 5 s of a limit still stops what that command left in its group, a SIGTERM-ignoring process too', async () => {
    const { dir, module } = install();
    const pidFile = join(dir, 'stubborn.pid');
    const answer = await run(module, `(trap '' TERM; echo $BASHPID > ${pidFile}; exec sleep 60) & while [ ! -s ${pidFile} ]; do sleep 0.01; done; sleep 30`, 500);
    expect(answer.stoppedAtLimit).toBe(true);
    const stubborn = Number(readFileSync(pidFile, 'utf-8'));
    expect(alive(stubborn)).toBe(true);
    await module.stop();
    expect(await goneWithin(stubborn, 1_000)).toBe(true);
  }, 20_000);

  linuxTest('a command that ends before its limit is not stopped at it while its output drains, nor is what it left running', async () => {
    const { dir, module } = install();
    const pidFile = join(dir, 'holder.pid');
    let holder = 0;
    try {
      const answer = await run(module, `sh -c 'echo $$ > ${pidFile}; exec sleep 30' & while [ ! -s ${pidFile} ]; do sleep 0.01; done; echo begun`, 900);
      holder = Number(readFileSync(pidFile, 'utf-8'));
      expect(answer.outputHeldOpen).toBe(true);
      expect(answer.stoppedAtLimit).toBe(false);
      expect(answer.note).not.toContain('limit');
      expect(alive(holder)).toBe(true);
    } finally {
      if (holder) try { process.kill(holder, 'SIGKILL'); } catch {}
    }
  }, 20_000);

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
      const answer = await run(module, `B=$$ setsid sh -c 'echo $$ > ${pidFile}; while kill -0 $B 2>/dev/null; do sleep 0.01; done; date +%s%3N > ${dir}/reaped-at; echo late; exec sleep 30' & while [ ! -s ${pidFile} ]; do sleep 0.01; done; echo begun; date +%s%3N > ${dir}/begun-at; sleep 1.2; date +%s%3N > ${endedAt}; cut -d' ' -f1 /proc/uptime > ${dir}/ended-up`);
      const took = Math.round((uptime() - Number(readFileSync(join(dir, 'ended-up'), 'utf-8'))) * 1000);
      const tookByWallClock = Date.now() - Number(readFileSync(endedAt, 'utf-8'));
      const answeredAfter = Math.round(performance.now() - monoBefore);
      holder = Number(readFileSync(pidFile, 'utf-8'));
      expect(alive(holder)).toBe(true);
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
      expect(answer.stdout.text).toBe('begun\nlate\n');
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

  test('where the list of stored secrets is missing, every name .env or another dotenv file beside it gives that setup doesn\'t know counts as secret, whatever its value, and the answer says why', async () => {
    const { dir, module } = install({
      envFile: 'DISCORD_TOKEN="discord-token-value"\nMY_SERVER_TOKEN="custom-token-value"\nDEBUG=7\n',
      env: { DISCORD_TOKEN: 'discord-token-value', MY_SERVER_TOKEN: 'custom-token-value', DEBUG: '7', KEEP_ME: 'kept' },
    });
    const stripped = await run(module, 'printenv DISCORD_TOKEN MY_SERVER_TOKEN DEBUG; echo "status=$?"; printenv KEEP_ME');
    expect(stripped.stdout.text).toBe('status=1\nkept\n');
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

  test('a link to a list that\'s gone, or a list setup can\'t reach, isn\'t taken for no list: setup--run runs nothing', async () => {
    const { dir, module } = install({ envFile: 'MY_SERVER_TOKEN="custom-token-value"\n' });
    mkdirSync(join(dir, '.setup'));
    symlinkSync(join(dir, 'gone.json'), join(dir, '.setup', 'stored-secrets.json'));
    const linked = await runCall(module, 'echo ran > ran.txt');
    expect(linked.success).toBe(false);
    expect(linked.error).toContain(`setup--run ran nothing: ${join(dir, '.setup', 'stored-secrets.json')} can't be read: ENOENT`);
    rmSync(join(dir, '.setup', 'stored-secrets.json'));
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

  test('replaces a secret stored while its command was running', async () => {
    const { dir, module } = install({ asker: { ask: async () => 'stored-mid-run-value' } });
    const flag = join(dir, 'stored');
    const pending = run(module, `touch started; while [ ! -e ${flag} ]; do sleep 0.02; done; cat .env`);
    for (const begun = Date.now(); !existsSync(join(dir, 'started')) && Date.now() - begun < 10_000; await Bun.sleep(10));
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
      expect(() => storedSecretRedactor(dir, {}), damaged).toThrow(join(dir, '.setup', 'stored-secrets.json'));
    }
  });

  test('a new module on the same install still replaces the secrets an earlier one stored', async () => {
    const { dir, module } = install({ asker: { ask: async () => 'stored-by-the-first' } });
    expect((await askSecret(module, { name: 'DISCORD_TOKEN', purpose: 'the bot token' })).success).toBe(true);
    const again = install({ dir });
    const answer = await run(again.module, 'cat .env');
    expect(answer.stdout.text).toBe('DISCORD_TOKEN="<DISCORD_TOKEN>"\n');
  });

  test('replaces a value stored and then replaced while its command ran', async () => {
    const values = ['first-stored-value', 'second-stored-value'];
    const { dir, module } = install({ asker: { ask: async () => values.shift() ?? null } });
    const [one, done, two] = ['one', 'done', 'two'].map((name) => join(dir, name));
    const pending = run(module, `while [ ! -e ${one} ]; do sleep 0.02; done; cat .env > snapshot; touch ${done}; while [ ! -e ${two} ]; do sleep 0.02; done; cat snapshot`);
    expect((await askSecret(module, { name: 'DISCORD_TOKEN', purpose: 'x' })).success).toBe(true);
    writeFileSync(one, '');
    for (const until = Date.now() + 10_000; !existsSync(done) && Date.now() < until;) await Bun.sleep(10);
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
    await run(module, 'cp .env backup; sed -i s/first-read-value/second-read-value/ .env');
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
      expect(alive(left)).toBe(true);
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
    expect(await goneWithin(stubborn, 3_000)).toBe(true);
  }, 30_000);

  test('a command asked for while a secret is asked for waits for each secret asked for after it too, so nothing it does is shown while the person types', async () => {
    const answers: Array<(value: string) => void> = [];
    const made = install({ asker: { ask: () => new Promise<string>((resolve) => { answers.push(resolve); }) } });
    const first = askSecret(made.module, { name: 'FIRST_TOKEN', purpose: 'a token' });
    const ran = runCall(made.module, 'touch ran');
    const second = askSecret(made.module, { name: 'SECOND_TOKEN', purpose: 'a token' });
    while (answers.length < 1) await Bun.sleep(1);
    answers[0]!('first-value');
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
    await module.stop();
    const answer = await pending;
    expect(answer.signal).toBe('SIGKILL');
    expect(await goneWithin(stubborn, 3_000)).toBe(true);
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
  if (how === 'stop') void module.stop();
});
setInterval(() => {}, 1000);
`);
    const found = (pattern: string) => Bun.spawnSync(['pgrep', '-f', pattern]).stdout.toString().trim();
    const until = async (check: () => boolean, ms: number) => {
      for (const started = Date.now(); !check() && Date.now() - started < ms; await new Promise((done) => setTimeout(done, 25)));
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
          expect(await until(() => said.includes('answered'), 4_500), how).toBe(true);
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

  test('stores a token Discord answered otherwise, or couldn\'t be asked about, saying it isn\'t known to work and why, never with the token in the words', async () => {
    const answered = install({
      asker: typed('token-one'),
      fetch: (async () => Response.json({ message: 'Service Unavailable' }, { status: 503 })) as unknown as typeof fetch,
    });
    const first = await askSecret(answered.module, { name: 'DISCORD_TOKEN', purpose: 'the bot token' });
    expect(String(first.data)).toBe(`stored as DISCORD_TOKEN in ${join(answered.dir, '.env')}, but it isn't known to work: Discord answered 503: Service Unavailable.`);
    expect(answered.shown).toEqual(['Checking it with Discord.', 'Discord didn\'t say whether it works: it answered 503 (Service Unavailable).']);
    expect(readEnvFile(join(answered.dir, '.env')).get('DISCORD_TOKEN')).toBe('token-one');
    const unasked = install({
      asker: typed('token-two'),
      fetch: (async () => { throw new Error('connect ECONNREFUSED, sending Bot token-two'); }) as unknown as typeof fetch,
    });
    const second = await askSecret(unasked.module, { name: 'DISCORD_TOKEN', purpose: 'the bot token' });
    expect(String(second.data)).toBe(`stored as DISCORD_TOKEN in ${join(unasked.dir, '.env')}, but it isn't known to work: Discord couldn't be asked (connect ECONNREFUSED, sending Bot <DISCORD_TOKEN>).`);
    expect(unasked.shown).toEqual(['Checking it with Discord.', 'Discord couldn\'t be asked whether it works (connect ECONNREFUSED, sending Bot <DISCORD_TOKEN>).']);
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

  test('no answer within its limit is unanswered, saying so', async () => {
    const result = await checkDiscordToken('a-token', {
      limitMs: 50,
      fetch: ((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
      })) as unknown as typeof fetch,
    });
    expect(result).toEqual({ kind: 'unanswered', why: 'no answer within 0.05 s' });
  });

  test('a 200 that isn\'t JSON is no answer of Discord\'s, one that isn\'t the bot user is Discord answering otherwise, and Discord\'s own words never show the token', async () => {
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

  test('a user whose answer says it isn\'t a bot is Discord answering otherwise, and one that says it is, is the bot', async () => {
    expect(await checkDiscordToken('a-token', {
      fetch: (async () => Response.json({ id: '900', username: 'person', bot: false })) as unknown as typeof fetch,
    })).toEqual({ kind: 'answered', status: 200, said: null });
    expect(await checkDiscordToken('a-token', {
      fetch: (async () => Response.json({ id: '900', username: 'ember', bot: true })) as unknown as typeof fetch,
    })).toEqual({ kind: 'accepted', name: 'ember', id: '900' });
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

  test('says it isn\'t known whether a value was stored when writing .env ends in an error, and leaves no copy of it beside .env', async () => {
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

  test('says nothing was stored when .env can\'t be read once the person has typed the value, before anything is written', async () => {
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

  test('asks nothing while .env can\'t be read, and says so', async () => {
    for (const unreadable of ['a directory', 'a file this user can\'t read']) {
      let asked = false;
      const { dir, module } = install({ asker: { ask: async () => { asked = true; return 'a-new-secret'; } } });
      if (unreadable === 'a directory') mkdirSync(join(dir, '.env'));
      else writeFileSync(join(dir, '.env'), 'PORT=8080\n', { mode: 0o000 });
      const result = await askSecret(module, { name: 'DISCORD_TOKEN', purpose: 'the bot token' });
      expect(result.isError, unreadable).toBe(true);
      expect(result.error, unreadable).toStartWith('Nothing was asked, so nothing was stored as DISCORD_TOKEN');
      expect(result.error, unreadable).toContain(`${join(dir, '.env')} can't be read`);
      expect(asked, unreadable).toBe(false);
    }
  });

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
    for (const until = Date.now() + 5_000; asked.length === 0 && Date.now() < until;) await Bun.sleep(5);
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

  test('a name that can\'t be recorded stores nothing, and says why', async () => {
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

describe("doctor's redactor", () => {
  test('line-preserving rendering hides a whole multi-line value while the default stays compact', () => {
    const dir = scratch();
    const env = { DISCORD_TOKEN: 'first-part\nmiddle-part\nlast-part' };
    const text = 'before first-part\nmiddle-part\nlast-part after';
    expect(storedSecretRedactor(dir, env)(text)).toEqual({
      text: 'before <DISCORD_TOKEN> after', replaced: ['DISCORD_TOKEN'], guessed: [],
    });
    expect(storedSecretRedactor(dir, env, true)(text)).toEqual({
      text: 'before <DISCORD_TOKEN>\n<DISCORD_TOKEN>\n<DISCORD_TOKEN> after',
      replaced: ['DISCORD_TOKEN'], guessed: [],
    });
  });

  test('replaces the stored secrets, as the list and .env hold them, and the provider credentials, and refuses a damaged list', async () => {
    const { dir, module } = install({ asker: { ask: async () => 'the stored #token' } });
    expect((await askSecret(module, { name: 'DISCORD_TOKEN', purpose: 'x' })).success).toBe(true);
    const redact = storedSecretRedactor(dir, { OPENAI_API_KEY: 'openai-key-value' });
    const env = readFileSync(join(dir, '.env'), 'utf-8');
    expect(redact(`${env}token the stored #token, key openai-key-value`)).toEqual({
      text: 'DISCORD_TOKEN="<DISCORD_TOKEN>"\ntoken <DISCORD_TOKEN>, key <OPENAI_API_KEY>',
      replaced: ['DISCORD_TOKEN', 'OPENAI_API_KEY'],
      guessed: [],
    });
    writeFileSync(join(dir, '.env'), `${env}MY_SERVER_TOKEN="custom-token-value"\n`);
    rmSync(join(dir, '.setup', 'stored-secrets.json'));
    expect(storedSecretRedactor(dir, {})('token the stored #token, custom-token-value')).toEqual({
      text: 'token <DISCORD_TOKEN>, <MY_SERVER_TOKEN>',
      replaced: ['DISCORD_TOKEN', 'MY_SERVER_TOKEN'],
      guessed: ['MY_SERVER_TOKEN'],
    });
    writeFileSync(join(dir, '.setup', 'stored-secrets.json'), 'not a list');
    expect(() => storedSecretRedactor(dir, {})).toThrow(join(dir, '.setup', 'stored-secrets.json'));
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

  test('a line on the prompt that holds the answer just given hidden isn\'t given back, so the secret isn\'t one Enter from the conversation', async () => {
    const { input, output, rl, lines, nextLine, shown } = terminal();
    input.write('tok-123456');
    await Bun.sleep(20);
    const answer = askHidden(rl, output, 'DISCORD_TOKEN (the bot token)');
    input.write('tok-123456\r');
    expect(await answer).toBe('tok-123456');
    expect(rl.line).toBe('');
    const after = nextLine();
    input.write('after\r');
    await after;
    expect(lines).toEqual(['after']);
    expect(shown().split('tok-123456').length - 1).toBe(1);
    rl.close();
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
    for (const until = Date.now() + 5_000; pending.cursor !== 8 && Date.now() < until;) await Bun.sleep(5);
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

  test('an OPENAI_API_KEY is checked with OpenAI, at the OPENAI_BASE_URL .env names, before it is stored, and stored once accepted', async () => {
    const requests: Array<{ url: string; headers: Headers }> = [];
    const made = install({
      envFile: 'OPENAI_BASE_URL=https://gateway.example/v1/\n',
      asker: typed('sk-openai-key'),
      fetch: (async (url: string, init: RequestInit) => {
        requests.push({ url: String(url), headers: new Headers(init.headers) });
        return models('gpt-6.1-terra');
      }) as unknown as typeof fetch,
    });
    const result = await askSecret(made.module, { name: 'OPENAI_API_KEY', purpose: 'the OpenAI key' });
    expect(result.success, result.error).toBe(true);
    expect(requests.map((r) => r.url)).toEqual(['https://gateway.example/v1/models']);
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer sk-openai-key');
    expect(String(result.data)).toBe(`stored as OPENAI_API_KEY in ${join(made.dir, '.env')}. OpenAI accepted it: it listed the models the key can use, which shows the key is accepted, not that a call to one of them succeeds.`);
    expect(made.shown).toEqual(['Checking it with OpenAI.', 'OpenAI accepted it.']);
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
    expect(String(result.data)).toContain('OpenAI answered 529: no route to <OPENAI_BASE_URL>/models');
  });

  test('check_model asked while a secret is being asked for waits for it, and checks the key stored then', async () => {
    let answer: ((value: string) => void) | undefined;
    const made = install({
      asker: { ask: () => new Promise<string>((resolve) => { answer = resolve; }) },
      fetch: (async () => models('gpt-6.1-terra')) as unknown as typeof fetch,
    });
    const asked = askSecret(made.module, { name: 'OPENAI_API_KEY', purpose: 'a key' });
    const checked = checkModel(made.module, { name: 'OPENAI_API_KEY', model: 'gpt-6.1-terra' });
    while (answer === undefined) await Bun.sleep(1);
    answer('sk-openai-key');
    expect((await asked).success).toBe(true);
    const result = await checked;
    expect(result.success, result.error).toBe(true);
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

  test('a provider key the provider answered otherwise, or couldn\'t be asked about, is stored as not known to work, never with the key in the words', async () => {
    const answered = install({
      asker: typed('key-one'),
      fetch: (async () => Response.json({ error: { message: 'overloaded' } }, { status: 529 })) as unknown as typeof fetch,
    });
    const first = await askSecret(answered.module, { name: 'ANTHROPIC_API_KEY', purpose: 'a key' });
    expect(String(first.data)).toBe(`stored as ANTHROPIC_API_KEY in ${join(answered.dir, '.env')}, but it isn't known to work: Anthropic answered 529: overloaded.`);
    expect(readEnvFile(join(answered.dir, '.env')).get('ANTHROPIC_API_KEY')).toBe('key-one');
    const unasked = install({
      asker: typed('key-two'),
      fetch: (async () => { throw new Error('connect ECONNREFUSED, sending Bearer key-two'); }) as unknown as typeof fetch,
    });
    const second = await askSecret(unasked.module, { name: 'OPENROUTER_API_KEY', purpose: 'a key' });
    expect(String(second.data)).toBe(`stored as OPENROUTER_API_KEY in ${join(unasked.dir, '.env')}, but it isn't known to work: OpenRouter couldn't be asked (connect ECONNREFUSED, sending Bearer <OPENROUTER_API_KEY>).`);
    expect(said(unasked, second)).not.toContain('key-two');
  });

  test('a provider key a request header can\'t carry is refused unsent and unstored', async () => {
    let called = 0;
    const made = install({ asker: typed('sk-\u2028broken'), fetch: (async () => { called += 1; return models(); }) as unknown as typeof fetch });
    const result = await askSecret(made.module, { name: 'ANTHROPIC_API_KEY', purpose: 'a key' });
    expect(result.error).toBe('What the person typed for ANTHROPIC_API_KEY holds a character a request header can\'t carry, so it can\'t be a key, and nothing was stored. Ask them to check what they copied, then call again.');
    expect(called).toBe(0);
    expect(readEnvFile(join(made.dir, '.env')).get('ANTHROPIC_API_KEY')).toBeUndefined();
  });

  test('a provider key isn\'t sent, or stored, where .env became unreadable while it was typed, since where to ask about it isn\'t known', async () => {
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
    for (const body of ['{}', '{"data":null}', '{"data":{"id":"gpt-6.1"}}', '{"data":"error"}']) {
      const made = install({ asker: typed('sk-openai-key'), fetch: (async () => new Response(body)) as unknown as typeof fetch });
      const result = await askSecret(made.module, { name: 'OPENAI_API_KEY', purpose: 'a key' });
      expect(String(result.data), body).toBe(`stored as OPENAI_API_KEY in ${join(made.dir, '.env')}, but it isn't known to work: OpenAI answered 200.`);
      expect(made.shown, body).toEqual(['Checking it with OpenAI.', 'OpenAI didn\'t say whether it works: it answered 200.']);
    }
  });

  test('Anthropic accepts a key by listing models under data, even none, and nothing else 2xx', async () => {
    const accepted = install({ asker: typed('sk-ant-key'), fetch: (async () => Response.json({ data: [] })) as unknown as typeof fetch });
    expect(String((await askSecret(accepted.module, { name: 'ANTHROPIC_API_KEY', purpose: 'a key' })).data)).toBe(`stored as ANTHROPIC_API_KEY in ${join(accepted.dir, '.env')}. Anthropic accepted it: it listed the models the key can use, which shows the key is accepted, not that a call to one of them succeeds.`);
    for (const body of ['{"data":null}', '{"data":{}}', '{}']) {
      const made = install({ asker: typed('sk-ant-key'), fetch: (async () => new Response(body)) as unknown as typeof fetch });
      expect(String((await askSecret(made.module, { name: 'ANTHROPIC_API_KEY', purpose: 'a key' })).data), body).toBe(`stored as ANTHROPIC_API_KEY in ${join(made.dir, '.env')}, but it isn't known to work: Anthropic answered 200.`);
    }
  });

  test('OpenRouter accepts a key by answering for it with an object, as its /api/v1/key does, and nothing else 2xx', async () => {
    const accepted = install({ asker: typed('sk-or-key'), fetch: (async () => Response.json({ data: { label: 'sk-or-v1-abc', usage: 0 } })) as unknown as typeof fetch });
    expect(String((await askSecret(accepted.module, { name: 'OPENROUTER_API_KEY', purpose: 'a key' })).data)).toBe(`stored as OPENROUTER_API_KEY in ${join(accepted.dir, '.env')}. OpenRouter accepted it: it answered for the key.`);
    for (const body of ['{"data":null}', '{"data":[]}', '{}']) {
      const made = install({ asker: typed('sk-or-key'), fetch: (async () => new Response(body)) as unknown as typeof fetch });
      expect(String((await askSecret(made.module, { name: 'OPENROUTER_API_KEY', purpose: 'a key' })).data), body).toBe(`stored as OPENROUTER_API_KEY in ${join(made.dir, '.env')}, but it isn't known to work: OpenRouter answered 200.`);
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

  test('a 2xx that isn\'t JSON, such as a sign-in page, is said to be no check, of a key, a token and a model, with what to tell the person', async () => {
    const portal = (async () => new Response('<html>Sign in to this network</html>', { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
    const key = install({ asker: typed('sk-ant-portal'), fetch: portal });
    const stored = await askSecret(key.module, { name: 'ANTHROPIC_API_KEY', purpose: 'a key' });
    expect(String(stored.data)).toBe(`stored as ANTHROPIC_API_KEY in ${join(key.dir, '.env')}, but it couldn't be checked: its answer wasn't JSON, as Anthropic's are: a network's sign-in page is one such answer. Tell the person: their connection to it is theirs to check.`);
    expect(key.shown).toContain('It couldn\'t be checked: its answer wasn\'t JSON, as Anthropic\'s are: a network\'s sign-in page is one such answer.');
    const token = install({ asker: typed('a-portal-token'), fetch: portal });
    const told = await askSecret(token.module, { name: 'DISCORD_TOKEN', purpose: 'the bot token' });
    expect(String(told.data)).toBe(`stored as DISCORD_TOKEN in ${join(token.dir, '.env')}, but it couldn't be checked: its answer wasn't JSON, as Discord's are: a network's sign-in page is one such answer. Tell the person: their connection to it is theirs to check.`);
    const model = await checkModel(install({ envFile: 'ANTHROPIC_API_KEY=sk-ant\n', fetch: portal }).module, { name: 'ANTHROPIC_API_KEY', model: 'claude-opus-5-5' });
    expect(model.error).toBe('Whether Anthropic offers claude-opus-5-5 to the key stored as ANTHROPIC_API_KEY isn\'t known: its answer wasn\'t JSON, as Anthropic\'s are: a network\'s sign-in page is one such answer. Tell the person: their connection to it is theirs to check.');
  });

  test('a redirect is named, with the server it leads to, and what to set where a base URL can be set, for a key, a token and a model', async () => {
    const redirecting = (async () => new Response(null, { status: 307, headers: { location: 'https://api.example.test/v1/models?from=old' } })) as unknown as typeof fetch;
    const openai = install({ asker: typed('sk-openai-moved'), fetch: redirecting });
    const stored = await askSecret(openai.module, { name: 'OPENAI_API_KEY', purpose: 'a key' });
    expect(String(stored.data)).toBe(`stored as OPENAI_API_KEY in ${join(openai.dir, '.env')}, but it isn't known to work: OpenAI answered 307, a redirect to https://api.example.test, which setup doesn't follow with a secret. If OPENAI_BASE_URL in .env is meant to lead to that server, ask the person for the base URL its API is under, the one its own instructions give for OPENAI_BASE_URL, set OPENAI_BASE_URL to it, then call again.`);
    expect(openai.shown).toContain('It isn\'t known to work: OpenAI answered 307, a redirect to https://api.example.test, which setup doesn\'t follow with a secret.');
    const openrouter = install({ asker: typed('sk-or-moved'), fetch: redirecting });
    const routed = await askSecret(openrouter.module, { name: 'OPENROUTER_API_KEY', purpose: 'a key' });
    expect(String(routed.data)).toEndWith('which setup doesn\'t follow with a secret. Something between this machine and OpenRouter sent it: tell the person their connection is theirs to check.');
    const discord = install({ asker: typed('a-moved-token'), fetch: redirecting });
    const token = await askSecret(discord.module, { name: 'DISCORD_TOKEN', purpose: 'the bot token' });
    expect(String(token.data)).toEndWith('Discord answered 307, a redirect to https://api.example.test, which setup doesn\'t follow with a secret. Something between this machine and Discord sent it: tell the person their connection is theirs to check.');
    const model = await checkModel(install({ envFile: 'ANTHROPIC_API_KEY=sk-ant\n', fetch: redirecting }).module, { name: 'ANTHROPIC_API_KEY', model: 'claude-opus-5-5' });
    expect(model.error).toBe('Whether Anthropic offers claude-opus-5-5 to the key stored as ANTHROPIC_API_KEY isn\'t known: Anthropic answered 307, a redirect to https://api.example.test, which setup doesn\'t follow with a secret. If ANTHROPIC_BASE_URL in .env is meant to lead to that server, ask the person for the base URL its API is under, the one its own instructions give for ANTHROPIC_BASE_URL, set ANTHROPIC_BASE_URL to it, then call again.');
  });

  test('a redirect shows no part of a base URL that carries a credential, its path included', async () => {
    const moved = (async () => new Response(null, { status: 302, headers: { location: 'https://other.example/private-token/v1/models' } })) as unknown as typeof fetch;
    const made = install({ envFile: 'OPENAI_BASE_URL="https://proxy.example/private-token/v1"\n', asker: typed('sk-openai-moved'), fetch: moved });
    listSecrets(made.module, 'OPENAI_BASE_URL');
    const stored = await askSecret(made.module, { name: 'OPENAI_API_KEY', purpose: 'a key' });
    expect(String(stored.data)).not.toContain('private-token');
    expect(made.shown.join('\n')).not.toContain('private-token');
    expect(String(stored.data)).toContain('a redirect to https://other.example, which setup doesn\'t follow with a secret.');
    const model = await checkModel(install({ envFile: 'OPENAI_BASE_URL="https://proxy.example/private-token/v1"\nOPENAI_API_KEY="sk-openai"\n', fetch: moved }).module, { name: 'OPENAI_API_KEY', model: 'gpt-5' });
    expect(model.error).not.toContain('private-token');
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

  test('a secret that is no provider key setup knows is stored without being checked', async () => {
    let called = 0;
    const made = install({ asker: typed('a-value'), fetch: (async () => { called += 1; return models(); }) as unknown as typeof fetch });
    const result = await askSecret(made.module, { name: 'OPENAI_COMPATIBLE_API_KEY', purpose: 'a key' });
    expect(String(result.data)).toBe(`stored as OPENAI_COMPATIBLE_API_KEY in ${join(made.dir, '.env')}`);
    expect(called).toBe(0);
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
