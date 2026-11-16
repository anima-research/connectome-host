import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolCall, ToolResult } from '@animalabs/agent-framework';
import { SetupModule, type SecretAsker } from '../src/modules/setup-module.js';
import { SHOWN_FILE } from '../src/setup/commands-shown.js';
import { readEnvFile } from '../src/setup/secrets.js';
import { processEnded } from './process-ended.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const TOKEN = 'MTA0.discord-bot-token-for-tests';
const KEY = 'sk-test-0123456789abcdef';

function install(opts: {
  answers?: Array<string | null>; asker?: SecretAsker; env?: Record<string, string>; fetch?: typeof fetch;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'setup-module-'));
  dirs.push(dir);
  const answers = [...(opts.answers ?? [])];
  const asked: string[] = [];
  const asker: SecretAsker = opts.asker ??
    { ask: async (name, purpose) => { asked.push(`${name}: ${purpose}`); return answers.shift() ?? null; } };
  const shown: string[] = [];
  const module = new SetupModule({
    dir,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...(opts.env ?? {}) },
    asker: () => asker,
    show: (line) => shown.push(line),
    fetch: opts.fetch ?? ((async () => new Response('{}')) as unknown as typeof fetch),
  });
  return { dir, module, shown, asked };
}

const call = (module: SetupModule, name: string, input: Record<string, unknown>): Promise<ToolResult> =>
  module.handleToolCall({ id: 'c', name, input } as ToolCall);

type Ran = { exitCode: number | null; stoppedAtLimit: boolean; stdout: string; stderr: string };

async function run(module: SetupModule, command: string, timeoutMs?: number): Promise<Ran> {
  const result = await call(module, 'run', { command, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  expect(result.success, result.error).toBe(true);
  return result.data as Ran;
}

const answering = (status: number) => (async () => new Response('{}', { status })) as unknown as typeof fetch;

describe('ask_secret', () => {
  test('stores what the person typed hidden in .env under its name, and gives the agent back no form of it', async () => {
    const { dir, module, asked } = install({ answers: [TOKEN] });
    const result = await call(module, 'ask_secret', { name: 'DISCORD_TOKEN', purpose: 'the bot token' });
    expect(result.success, result.error).toBe(true);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(asked).toEqual(['DISCORD_TOKEN: the bot token']);
    expect(readEnvFile(join(dir, '.env')).get('DISCORD_TOKEN')).toBe(TOKEN);
    expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(dir, '.setup', 'stored-secrets.json'), 'utf-8'))).toEqual(['DISCORD_TOKEN']);
  });

  test('stores nothing for a token Discord refuses, and says so', async () => {
    const { dir, module } = install({ answers: [TOKEN], fetch: answering(401) });
    const result = await call(module, 'ask_secret', { name: 'DISCORD_TOKEN', purpose: 'the bot token' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('refused it (401)');
    expect(readEnvFile(join(dir, '.env')).has('DISCORD_TOKEN')).toBe(false);
  });

  test('stores a key whose check gets a 503, and says whether it works isn\'t known, with the status', async () => {
    const { dir, module } = install({ answers: [KEY], fetch: answering(503) });
    const result = await call(module, 'ask_secret', { name: 'OPENAI_API_KEY', purpose: 'an OpenAI key' });
    expect(result.success, result.error).toBe(true);
    expect(String(result.data)).toContain('isn\'t known');
    expect(String(result.data)).toContain('503');
    expect(readEnvFile(join(dir, '.env')).get('OPENAI_API_KEY')).toBe(KEY);
  });

  test('stores a provider key whose base URL in .env isn\'t a URL, and says why whether it works isn\'t known, without the URL', async () => {
    const { dir, module } = install({ answers: [KEY] });
    writeFileSync(join(dir, '.env'), 'OPENAI_BASE_URL=not-a-valid-secret-url\n');
    const result = await call(module, 'ask_secret', { name: 'OPENAI_API_KEY', purpose: 'an OpenAI key' });
    expect(result.success, result.error).toBe(true);
    expect(String(result.data)).toContain('whether it works isn\'t known: OPENAI_BASE_URL in .env isn\'t a URL.');
    expect(JSON.stringify(result)).not.toContain('not-a-valid-secret-url');
    expect(readEnvFile(join(dir, '.env')).get('OPENAI_API_KEY')).toBe(KEY);
  });

  test('stores a provider key that a gateway .env names answers 403 to, and says whether it works isn\'t known', async () => {
    const { dir, module } = install({ answers: [KEY], fetch: answering(403) });
    writeFileSync(join(dir, '.env'), 'ANTHROPIC_BASE_URL=https://gateway.example\n');
    const result = await call(module, 'ask_secret', { name: 'ANTHROPIC_API_KEY', purpose: 'the key' });
    expect(result.success, result.error).toBe(true);
    expect(String(result.data)).toContain('whether it works isn\'t known: gateway.example answered 403');
    expect(readEnvFile(join(dir, '.env')).get('ANTHROPIC_API_KEY')).toBe(KEY);
    const direct = install({ answers: [KEY], fetch: answering(403) });
    expect((await call(direct.module, 'ask_secret', { name: 'ANTHROPIC_API_KEY', purpose: 'the key' })).success).toBe(false);
  });

  test('stores nothing when the person enters nothing', async () => {
    const { dir, module } = install({ answers: [''] });
    const result = await call(module, 'ask_secret', { name: 'MY_TOKEN', purpose: 'a token' });
    expect(result.success).toBe(false);
    expect(readEnvFile(join(dir, '.env')).has('MY_TOKEN')).toBe(false);
  });

  test('stores a value shorter than 8 characters without hiding it, and tells the person so once', async () => {
    const { module, shown } = install({ answers: ['pass1'] });
    expect((await call(module, 'ask_secret', { name: 'MY_PASSWORD', purpose: 'a password' })).success).toBe(true);
    expect(shown.filter((line) => line.includes('shorter than 8 characters'))).toHaveLength(1);
    expect((await run(module, 'echo pass1')).stdout).toBe('pass1\n');
  });
});

describe('run', () => {
  test('leaves each stored secret out of the command\'s environment, by name', async () => {
    const { module } = install({ answers: [TOKEN], env: { DISCORD_TOKEN: TOKEN, DATA_DIR: '/setup', KEPT: 'yes' } });
    await call(module, 'ask_secret', { name: 'DISCORD_TOKEN', purpose: 'the bot token' });
    const env = (await run(module, 'env')).stdout;
    expect(env).not.toContain('DISCORD_TOKEN=');
    expect(env).not.toContain('DATA_DIR=');
    expect(env).toContain('KEPT=yes');
  });

  test('leaves out of the command\'s environment a name that holds a stored value under another name', async () => {
    const { module } = install({ answers: [TOKEN], env: { ALIAS: TOKEN, KEPT: 'yes' } });
    await call(module, 'ask_secret', { name: 'DISCORD_TOKEN', purpose: 'the bot token' });
    const env = (await run(module, 'env')).stdout;
    expect(env).not.toContain('ALIAS=');
    expect(env).toContain('KEPT=yes');
  });

  test('gives each stored value back as its name, in what the command prints', async () => {
    const { module } = install({ answers: [TOKEN] });
    await call(module, 'ask_secret', { name: 'DISCORD_TOKEN', purpose: 'the bot token' });
    const ran = await run(module, 'cat .env; cat .env >&2');
    expect(ran.stdout).toBe('DISCORD_TOKEN="<DISCORD_TOKEN>"\n');
    expect(ran.stderr).toBe('DISCORD_TOKEN="<DISCORD_TOKEN>"\n');
  });

  test('stops a command still running at its time limit, with its process group', async () => {
    const { dir, module } = install();
    const ran = await run(module, `sleep 60 & echo $! > child; wait`, 300);
    expect(ran.stoppedAtLimit).toBe(true);
    const child = Number(readFileSync(join(dir, 'child'), 'utf-8'));
    for (let tries = 0; !processEnded(child) && tries < 100; tries++) await Bun.sleep(20);
    expect(processEnded(child)).toBe(true);
  });

  test('stops a running command when the host stops', async () => {
    const { module } = install();
    const running = run(module, 'sleep 60');
    await Bun.sleep(100);
    await module.stop();
    expect((await running).exitCode).not.toBe(0);
  });

  test('leaves running what a command that ended before its time limit left, though the limit comes while its output drains', async () => {
    const { dir, module } = install();
    const ran = await run(module, 'sleep 60 & echo $! > child', 500);
    const child = Number(readFileSync(join(dir, 'child'), 'utf-8'));
    try {
      expect(ran.stoppedAtLimit).toBe(false);
      expect(processEnded(child)).toBe(false);
    } finally {
      try {
        process.kill(child, 'SIGKILL');
      } catch {
      }
    }
  });

  test('waits, when the host stops, for the end of a timed-out command\'s process group that outlives its SIGTERM', async () => {
    const { dir, module } = install();
    const ran = await run(module, `sh -c "trap '' TERM; echo \\$\\$ > child; exec sleep 60" & while [ ! -s child ]; do sleep 0.01; done; wait`, 300);
    const child = Number(readFileSync(join(dir, 'child'), 'utf-8'));
    try {
      expect(ran.stoppedAtLimit).toBe(true);
      await module.stop();
      for (let tries = 0; !processEnded(child) && tries < 10; tries++) await Bun.sleep(20);
      expect(processEnded(child)).toBe(true);
    } finally {
      try {
        process.kill(child, 'SIGKILL');
      } catch {
      }
    }
  }, 20_000);

  test('kills, when the host stops, what in a command\'s process group outlives SIGTERM after the command ends', async () => {
    const { dir, module } = install();
    const running = run(module, `sh -c "trap '' TERM; echo \\$\\$ > child; exec sleep 60" & wait`);
    const written = () => existsSync(join(dir, 'child')) && readFileSync(join(dir, 'child'), 'utf-8').endsWith('\n');
    for (let tries = 0; !written() && tries < 100; tries++) await Bun.sleep(20);
    const child = Number(readFileSync(join(dir, 'child'), 'utf-8'));
    try {
      await module.stop();
      await running;
      for (let tries = 0; !processEnded(child) && tries < 100; tries++) await Bun.sleep(20);
      expect(processEnded(child)).toBe(true);
    } finally {
      try {
        process.kill(child, 'SIGKILL');
      } catch {
      }
    }
  }, 20_000);

  test('gives back the first and last 4 KiB of a longer output, and says how much it left out', async () => {
    const { module } = install();
    const ran = await run(module, `head -c 20000 /dev/zero | tr '\\0' a; echo; echo end`);
    expect(ran.stdout.startsWith('a'.repeat(4096))).toBe(true);
    expect(ran.stdout).toContain('bytes not shown]');
    expect(ran.stdout.endsWith('end\n')).toBe(true);
    expect(ran.stdout.length).toBeLessThan(8400);
  });

  test('shows the person each command as it starts, a hidden character as its code', async () => {
    const { module, shown } = install();
    await run(module, 'printf "\\033" > /dev/null # \u001b');
    expect(shown[0]).toBe('Setup\'s agent runs:');
    expect(shown[1]).toBe('  printf "\\033" > /dev/null # \\u001b');
  });

  test('shows the person what a command writes to the file its environment names, as a command of the install does', async () => {
    const { module, shown } = install();
    await run(module, `echo "the service is installed" >> "$${SHOWN_FILE}"`);
    expect(shown.slice(-2)).toEqual(['It said:', '  the service is installed']);
  });

  test('waits for a hidden question to be answered before it starts', async () => {
    let answer: (value: string) => void = () => {};
    const { module, shown } = install({ asker: { ask: () => new Promise((resolve) => { answer = resolve; }) } });
    const asking = call(module, 'ask_secret', { name: 'MY_TOKEN', purpose: 'a token' });
    const running = run(module, 'echo after');
    await Bun.sleep(100);
    expect(shown).toEqual([]);
    answer('a-long-enough-token');
    await asking;
    expect((await running).stdout).toBe('after\n');
  });
});

test('names the list of stored secrets when it isn\'t JSON, and runs nothing', async () => {
  const { dir, module } = install();
  mkdirSync(join(dir, '.setup'));
  writeFileSync(join(dir, '.setup', 'stored-secrets.json'), '["DISCORD_TO');
  const ran = call(module, 'run', { command: 'touch ran' });
  await expect(ran).rejects.toThrow(`${join(dir, '.setup', 'stored-secrets.json')} isn't a JSON list of names`);
  expect(existsSync(join(dir, 'ran'))).toBe(false);
});

test('finished asks for the conversation to end after this turn, and records nothing', async () => {
  const { dir, module } = install();
  expect(module.finishRequested).toBe(false);
  expect((await call(module, 'finished', {})).success).toBe(true);
  expect(module.finishRequested).toBe(true);
  expect(() => statSync(join(dir, '.setup'))).toThrow();
});
