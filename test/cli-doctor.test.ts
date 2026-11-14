import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { doctor, secretsStep, type DoctorParts } from '../src/cli/doctor.js';
import { openHost } from '../src/cli/host-socket.js';
import type { Ran } from '../src/cli/service-manager.js';
import { machine } from '../src/cli/service.js';
import { DotenvReadError } from '../src/setup/secrets.js';
import { plist, serviceUnits, systemdUnit } from '../src/cli/service-unit.js';

const TOKEN = 'discord-token-value-1234';
const KEY = 'sk-provider-key-5678';
const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

interface Install { top: string; work: string; root: string; data: string; home: string; platform: NodeJS.Platform }

function install(opts: { launchd?: true; env?: string; recipe?: string; unit?: false; shell?: true; dataDir?: string } = {}): Install {
  const top = mkdtempSync(join(tmpdir(), 'chost-doctor5-'));
  dirs.push(top);
  const work = join(top, 'ember');
  const root = join(work, 'connectome-host');
  const data = opts.dataDir ?? join(work, 'data');
  mkdirSync(root, { recursive: true });
  mkdirSync(data, { recursive: true });
  mkdirSync(join(work, '.setup'));
  writeFileSync(join(root, 'install.json'), JSON.stringify({ v: 1, dataDir: data, extraState: [] }));
  writeFileSync(join(work, '.env'), opts.env ?? `DISCORD_TOKEN="${TOKEN}"\nANTHROPIC_API_KEY="${KEY}"\nMODEL_NOTE=plain\n`);
  writeFileSync(join(work, '.setup', 'stored-secrets.json'), JSON.stringify(['DISCORD_TOKEN', 'ANTHROPIC_API_KEY']));
  writeFileSync(join(work, 'recipe.json'), opts.recipe
    ?? JSON.stringify({ name: 'Ember', agent: { name: 'ember', model: 'claude-test-model', systemPrompt: 'hello' } }));
  const at: Install = { top, work, root, data, home: join(top, 'home'), platform: opts.launchd ? 'darwin' : 'linux' };
  if (opts.unit !== false) writeUnits(at, opts.shell === true);
  return at;
}

function writeUnits(at: Install, shell: boolean, argv = [process.execPath, join(at.root, 'start.js'), 'recipe.json', '--headless']): void {
  const units = serviceUnits(at.root, at.platform, at.home)!;
  mkdirSync(dirname(units.host.file), { recursive: true });
  const write = (name: string, file: string, args: string[]) => writeFileSync(file, units.manager === 'systemd-user'
    ? systemdUnit('Connectome ember', at.work, args, [['DATA_DIR', at.data]], null)
    : plist(name, at.work, args, [['DATA_DIR', at.data]], join(at.work, 'logs', 'agent.log')));
  write(units.host.name, units.host.file, argv);
  if (shell) write(units.shell.name, units.shell.file, [process.execPath, 'shell-daemon']);
}

type States = Record<string, string | { fails: string }>;

function managerRun(at: Install, states: States): (command: string, args: string[]) => Ran {
  return (command, args) => {
    if (command === 'systemctl' && args[1] === 'show' && args[2] === '--property=ActiveState,SubState') {
      const state = states[args[4]!] ?? 'inactive/dead';
      if (typeof state !== 'string') return { status: 1, stdout: '', stderr: state.fails };
      const [active, sub] = state.split('/');
      return { status: 0, stdout: `ActiveState=${active}\nSubState=${sub}\n`, stderr: '' };
    }
    if (command === 'launchctl' && args[0] === 'list') {
      const state = states[args[1]!] ?? 'unloaded';
      if (typeof state !== 'string') return { status: 1, stdout: '', stderr: state.fails };
      if (state === 'unloaded') return { status: 113, stdout: '', stderr: 'Could not find service' };
      return { status: 0, stdout: state === 'running' ? '{\n\t"PID" = 4242;\n};\n' : '{\n\t"LastExitStatus" = 256;\n};\n', stderr: '' };
    }
    if (command === 'plutil' && args[0] === '-type') return { status: 0, stdout: 'string\n', stderr: '' };
    if (command === 'plutil' && args[0] === '-extract') return { status: 0, stdout: `${at.work}\n`, stderr: '' };
    return { status: 2, stdout: '', stderr: `unexpected: ${command} ${args.join(' ')}` };
  };
}

const BOTS: Record<string, string> = { [`Bot ${TOKEN}`]: 'ember-bot' };

const discordFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
  const name = BOTS[new Headers(init?.headers).get('authorization') ?? ''];
  if (name === undefined) return Response.json({ message: '401: Unauthorized', code: 0 }, { status: 401 });
  return Response.json({ id: '900', username: name, bot: true });
}) as typeof fetch;

const STARTED = Date.parse('2026-11-14T10:00:00.000Z');
const FAILED = Date.parse('2026-11-14T10:05:00.000Z');
type Agent = Record<string, unknown>;
const agent = (name: string, extra: Agent = {}): Agent => ({
  name, consecutiveInferenceFailures: 0, lastInference: { startedAt: STARTED, endedAt: STARTED + 4_000 }, refusalStats: null, ...extra,
});

function fakeHost(at: Install, health: unknown, opts: { agent?: string } = {}) {
  const server = Bun.listen({
    unix: join(at.data, 'ipc.sock'),
    socket: {
      open(socket) {
        socket.write(JSON.stringify({ type: 'lifecycle', phase: 'ready', pid: 4242, recipe: 'Ember', ...opts }) + '\n');
      },
      data(socket, chunk) {
        for (const line of chunk.toString().split('\n').filter(Boolean)) {
          const msg = JSON.parse(line) as { type: string; op?: string; corrId?: string };
          if (msg.type !== 'panel-request') continue;
          if (health === 'silent') continue;
          socket.write(JSON.stringify(health === 'refused'
            ? { type: 'panel-response', corrId: msg.corrId, op: msg.op, ok: false, error: 'unknown panel op: health' }
            : { type: 'panel-response', corrId: msg.corrId, op: msg.op, ok: true, data: health }) + '\n');
        }
      },
    },
  });
  return () => server.stop(true);
}

async function run(at: Install, opts: {
  states?: States; argv?: string[]; uid?: number; owner?: number; fetch?: typeof fetch; env?: Record<string, string>;
  health?: unknown; healthWaitMs?: number; recipeLimitMs?: number;
} = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const parts: DoctorParts = {
    sys: {
      ...machine(),
      platform: at.platform,
      home: at.home,
      uid: opts.uid ?? 1000,
      env: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: '/run/user/1000', ...opts.env },
      run: managerRun(at, opts.states ?? {}),
      owner: () => opts.owner ?? 1000,
    },
    fetch: opts.fetch ?? discordFetch,
    openHost: (root) => openHost(root, 1_000),
    healthWaitMs: opts.healthWaitMs ?? 2_000,
    recipeLimitMs: opts.recipeLimitMs ?? 10_000,
  };
  const stop = opts.health === undefined ? null : fakeHost(at, opts.health);
  try {
    const status = await doctor({ root: at.root, argv: opts.argv ?? [], out: (line) => out.push(line), err: (line) => err.push(line) }, parts);
    return { status, out: out.join('\n'), err: err.join('\n'), lines: out };
  } finally {
    stop?.();
  }
}

const HOST = 'connectome-ember.service';
const SHELL = 'connectome-ember.shell.service';
const LABEL = 'com.animalabs.connectome.ember';
const RUNNING: States = { [HOST]: 'active/running' };
const HEALTHY = { agents: [agent('ember')] };

describe('connectome doctor: the frame', () => {
  test('an argument is a usage error, exit 2', async () => {
    const at = install();
    const r = await run(at, { argv: ['--json'] });
    expect([r.status, r.err, r.out]).toEqual([2, 'connectome: usage: connectome doctor', '']);
  });

  test('run as root on an install another user owns, it prints one refusal and exits 1', async () => {
    const at = install();
    const r = await run(at, { uid: 0, owner: 1000 });
    expect(r.status).toBe(1);
    expect(r.out).toBe('');
    expect(r.err).toContain(`connectome: ${at.work} belongs to uid 1000, and doctor runs as root`);
  });

  test('it names the install first, then five checks, then the closing line', async () => {
    const at = install();
    const r = await run(at, { states: RUNNING, health: HEALTHY });
    expect(r.lines).toEqual([
      `Checking the install at ${at.root}.`,
      `✓ The service ${HOST} runs.`,
      '✓ The host answers: pid 4242, recipe Ember.',
      '✓ The host loaded Ember when it started.',
      '✓ ember: no failed model call in a row.',
      '✓ Discord accepts the token: the bot is ember-bot.',
      'Doctor found no problem.',
      expect.stringMatching(/^Where an incoming message stops, the ladder shows: python3 \S+connectome-doctor \S+ connectome-ember\.service$/),
    ]);
    expect(r.status).toBe(0);
  });

  test('when the stored secrets can\'t be read, it says why with a next step, runs no check and exits 1', async () => {
    const at = install({ env: `DISCORD_TOKEN="${TOKEN}"\r\n` });
    const r = await run(at, { states: RUNNING, health: HEALTHY });
    expect(r.status).toBe(1);
    expect(r.lines[1]).toStartWith(`✗ Doctor can't read the stored secrets that it hides: ${join(at.work, '.env')}, line 1, holds an ASCII control character`);
    expect(r.lines[2]).toBe(`  Next: correct ${join(at.work, '.env')}, then run doctor again.`);
    expect(r.lines[3]).toBe('Doctor stops here and runs no check.');
    expect(r.lines).toHaveLength(4);
  });

  test('where the stored secrets\' list isn\'t one, the next step is to put right what the line names', async () => {
    const at = install();
    writeFileSync(join(at.work, '.setup', 'stored-secrets.json'), '{}');
    const r = await run(at, { states: RUNNING, health: HEALTHY });
    expect(r.lines.slice(1)).toEqual([
      `✗ Doctor can't read the stored secrets that it hides: ${join(at.work, '.setup', 'stored-secrets.json')} isn't the list ` +
        'of the names of the secrets setup stored, such as ["DISCORD_TOKEN"].',
      '  Next: put right what it names, then run doctor again.',
      'Doctor stops here and runs no check.',
    ]);
    expect(r.status).toBe(1);
  });

  test('where Bun couldn\'t read the dotenv files, the next step is the command that shows Bun\'s own error', () => {
    const error = new DotenvReadError('Bun couldn\'t read the dotenv files in /x in its development mode (exit 1)',
      'env -u BUN_OPTIONS -u NODE_ENV /usr/bin/bun --config=/dev/null -e 0');
    expect(secretsStep(error, '/x')).toBe('run `env -u BUN_OPTIONS -u NODE_ENV /usr/bin/bun --config=/dev/null -e 0` in /x ' +
      'to see why, correct what it shows, then run doctor again.');
  });

  test('every line hides the stored secrets by name', async () => {
    const at = install();
    BOTS[`Bot ${TOKEN}`] = `bot-${KEY}`;
    try {
      const r = await run(at, { states: RUNNING, health: HEALTHY });
      expect(r.out).toContain('the bot is bot-<ANTHROPIC_API_KEY>.');
      expect(r.out).not.toContain(KEY);
    } finally {
      BOTS[`Bot ${TOKEN}`] = 'ember-bot';
    }
  });
});

describe('connectome doctor: check 1, the service', () => {
  test('where no service can be installed, it is not checked', async () => {
    const at = { ...install({ unit: false }), platform: 'win32' as NodeJS.Platform };
    const r = await run(at);
    expect(r.lines[1]).toBe('– Not checked: no service can be installed here.');
  });

  test('no unit file is no service installed, with service install as the next step', async () => {
    const at = install({ unit: false });
    const r = await run(at);
    expect(r.lines.slice(1, 3)).toEqual([
      '✗ No service is installed for this install.',
      `  Next: \`${join(at.root, 'connectome')} service install <recipe>\``,
    ]);
  });

  test('a stopped systemd service is a problem with its state, the start command and the log command', async () => {
    const at = install();
    const r = await run(at, { states: { [HOST]: 'inactive/dead' } });
    expect(r.lines.slice(1, 3)).toEqual([
      `✗ The service ${HOST} is inactive (dead).`,
      `  Next: start it with \`systemctl --user start ${HOST}\`, and read its log with \`journalctl --user -u ${HOST} -f\`.`,
    ]);
  });

  test('where systemd can\'t be asked, it gives systemd\'s words and the question to ask', async () => {
    const at = install();
    const r = await run(at, { states: { [HOST]: { fails: 'Failed to connect to bus' } } });
    expect(r.lines[1]).toStartWith(`✗ systemd couldn't be asked about ${HOST}: Failed to connect to bus`);
    expect(r.lines[2]).toBe('  Next: ask it yourself, as the user who runs the resident: ' +
      `\`systemctl --user show --property=ActiveState,SubState -- ${HOST}\``);
  });

  test('the shell daemon\'s service gets its own line', async () => {
    const at = install({ shell: true });
    const r = await run(at, { states: { [HOST]: 'active/running', [SHELL]: 'failed/failed' } });
    expect(r.lines.slice(1, 4)).toEqual([
      `✓ The service ${HOST} runs.`,
      `✗ The service ${SHELL} is failed (failed).`,
      `  Next: start it with \`systemctl --user start ${SHELL} ${HOST}\`, and read its log with \`journalctl --user -u ${HOST} -f\`.`,
    ]);
  });

  test('a running launch agent passes, and one loaded and not running is a problem with its last exit', async () => {
    const at = install({ launchd: true });
    expect((await run(at, { states: { [LABEL]: 'running' } })).lines[1]).toBe(`✓ The service ${LABEL} runs.`);
    const stopped = await run(at, { states: { [LABEL]: 'loaded' } });
    expect(stopped.lines[1]).toBe(`✗ The service ${LABEL} is loaded and not running, its last exit 256.`);
    expect(stopped.lines[2]).toStartWith(`  Next: start it with \`launchctl kickstart gui/1000/${LABEL} 2>/dev/null || launchctl bootstrap gui/1000 `);
  });

  test('a launch agent that isn\'t loaded, and a launchctl that fails, are problems', async () => {
    const at = install({ launchd: true });
    expect((await run(at)).lines[1]).toBe(`✗ The service ${LABEL} is not loaded.`);
    const unasked = await run(at, { states: { [LABEL]: { fails: 'launchd is gone' } } });
    expect(unasked.lines[1]).toStartWith(`✗ launchctl list ${LABEL} failed: `);
    expect(unasked.lines[2]).toBe(`  Next: ask it yourself, as the user who runs the resident: \`launchctl list ${LABEL}\``);
  });
});

describe('connectome doctor: check 2, the host', () => {
  test('a host that answers gives its pid and recipe', async () => {
    const at = install();
    expect((await run(at, { states: RUNNING, health: HEALTHY })).lines[2]).toBe('✓ The host answers: pid 4242, recipe Ember.');
  });

  test('with the service running and no host, it may still be starting: run doctor again, with the log', async () => {
    const at = install();
    const r = await run(at, { states: RUNNING });
    expect(r.lines[2]).toStartWith(`✗ No host answers: `);
    expect(r.lines[3]).toBe(`  Next: it may still be starting, so run doctor again in a minute. Its log: \`journalctl --user -u ${HOST} -f\``);
  });

  test('with the service stopped and no host, the next step starts it', async () => {
    const at = install();
    const r = await run(at, { states: { [HOST]: 'inactive/dead' } });
    expect(r.lines[4]).toBe(`  Next: start the service with \`systemctl --user start ${HOST}\`.`);
  });

  test('where no service can be installed, the next step starts the host with its own start line', async () => {
    const at = { ...install({ unit: false }), platform: 'win32' as NodeJS.Platform };
    const r = await run(at, { env: { PATH: '/nonexistent' } });
    expect(r.lines[2]).toStartWith('✗ No host answers: ');
    expect(r.lines[3]).toBe(`  Next: no service can be installed here, so start the host as this machine runs a program, from ${at.work}: ` +
      `\`${process.execPath} ${join(at.root, 'start.js')} <recipe> --headless\``);
  });

  test('where the data directory isn\'t the host\'s own default, the start line sets it', async () => {
    const top = mkdtempSync(join(tmpdir(), 'chost-doctor5-moved-'));
    dirs.push(top);
    const at = { ...install({ unit: false, dataDir: join(top, 'elsewhere') }), platform: 'win32' as NodeJS.Platform };
    const r = await run(at, { env: { PATH: '/nonexistent' } });
    expect(r.lines[3]).toBe(`  Next: no service can be installed here, so start the host as this machine runs a program, from ${at.work}: ` +
      `\`DATA_DIR=${join(top, 'elsewhere')} ${process.execPath} ${join(at.root, 'start.js')} <recipe> --headless\``);
  });

  test('with no service and no host, the next step is service install', async () => {
    const at = install({ unit: false });
    const r = await run(at);
    expect(r.lines[3]).toStartWith('✗ No host answers: ');
    expect(r.lines[4]).toBe(`  Next: \`${join(at.root, 'connectome')} service install <recipe>\``);
  });
});

describe('connectome doctor: check 3, the recipe', () => {
  test('with no host and no service, it is not checked', async () => {
    const at = install({ unit: false });
    expect((await run(at)).lines[5]).toBe('– Not checked: the service\'s unit names the recipe, and no service is installed.');
  });

  test('with no host, the recipe that the unit names loads', async () => {
    const at = install();
    expect((await run(at, { states: { [HOST]: 'inactive/dead' } })).lines[5]).toBe(`✓ ${join(at.work, 'recipe.json')} loads.`);
  });

  test('the loader takes its values from .env, with doctor\'s own environment over them', async () => {
    const recipe = JSON.stringify({ name: 'Ember', agent: { name: 'ember', model: 'claude-test-model', systemPrompt: 'hi', proseRouting: '${ROUTING}' } });
    const at = install({ recipe, env: `DISCORD_TOKEN="${TOKEN}"\nROUTING=from-dotenv\n` });
    const fromDotenv = await run(at, { states: { [HOST]: 'inactive/dead' } });
    expect(fromDotenv.lines[5]).toEndWith('got "from-dotenv".');
    const fromEnv = await run(at, { states: { [HOST]: 'inactive/dead' }, env: { ROUTING: 'from-environment' } });
    expect(fromEnv.lines[5]).toEndWith('got "from-environment".');
  });

  test('a recipe that doesn\'t load gives the loader\'s words, with a stored secret in them hidden, and the next step', async () => {
    const recipe = JSON.stringify({ name: 'Ember', agent: { name: 'ember', model: 'claude-test-model', systemPrompt: 'hi', proseRouting: '${DISCORD_TOKEN}' } });
    const at = install({ recipe });
    const r = await run(at, { states: { [HOST]: 'inactive/dead' } });
    expect(r.lines[5]).toStartWith(`✗ ${join(at.work, 'recipe.json')} doesn't load: `);
    expect(r.lines[5]).toEndWith('got "<DISCORD_TOKEN>".');
    expect(r.out).not.toContain(TOKEN);
    expect(r.lines[6]).toBe(`  Next: correct it, then start the service with \`systemctl --user start ${HOST}\`.`);
  });

  test('a recipe whose JSON is broken doesn\'t load, and the loader quotes none of it', async () => {
    const at = install({ recipe: `{ "name": "Ember", "agent": ${TOKEN} }` });
    const r = await run(at, { states: { [HOST]: 'inactive/dead' } });
    expect(r.lines[5]).toBe(`✗ ${join(at.work, 'recipe.json')} doesn't load: ${join(at.work, 'recipe.json')} isn't valid JSON.`);
  });

  test('a unit file that names no recipe after start.js is not checked, with why', async () => {
    const at = install();
    writeUnits(at, false, [process.execPath, join(at.root, 'start.js')]);
    const bare = await run(at, { states: { [HOST]: 'inactive/dead' } });
    expect(bare.lines[5]).toBe('– Not checked: the service\'s unit isn\'t one that doctor can read the recipe from: it names no ' +
      'recipe after start.js.');
  });

  test.skipIf(process.getuid?.() === 0)('a unit file that can\'t be read is not checked, with why', async () => {
    const at = install();
    const units = serviceUnits(at.root, at.platform, at.home)!;
    chmodSync(units.host.file, 0o000);
    try {
      const unread = await run(at, { states: { [HOST]: 'inactive/dead' } });
      expect(unread.lines[5]).toStartWith('– Not checked: the service\'s unit isn\'t one that doctor can read the recipe from: EACCES');
    } finally {
      chmodSync(units.host.file, 0o644);
    }
  });

  test('a recipe that doesn\'t load within the limit is a problem, with the limit', async () => {
    const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    try {
      const recipe = JSON.stringify({ name: 'Ember', agent: { name: 'ember', model: 'claude-test-model',
        systemPrompt: `http://127.0.0.1:${server.port}/prompt.md` } });
      const at = install({ recipe });
      const r = await run(at, { states: { [HOST]: 'inactive/dead' }, recipeLimitMs: 300 });
      expect(r.lines[5]).toBe(`✗ ${join(at.work, 'recipe.json')} doesn't load: it didn't load within 0.3 s.`);
    } finally {
      server.stop(true);
    }
  });

  test('a unit doctor can\'t read the recipe from is not checked, with why', async () => {
    const at = install();
    const units = serviceUnits(at.root, at.platform, at.home)!;
    writeFileSync(units.host.file, `[Service]\nWorkingDirectory=${at.work}\nExecStart=/bin/true\n`);
    const r = await run(at, { states: { [HOST]: 'inactive/dead' } });
    expect(r.lines[5]).toBe('– Not checked: the service\'s unit isn\'t one that doctor can read the recipe from: its ExecStart ' +
      'line isn\'t the quoted words service install writes.');
  });
});

describe('connectome doctor: check 4, the model calls', () => {
  test('with no host, it is not checked', async () => {
    const at = install();
    expect((await run(at, { states: RUNNING })).lines[5]).toBe('– Not checked: the model calls need the host running.');
  });

  test('an agent with no model call yet is not checked', async () => {
    const at = install();
    const r = await run(at, { states: RUNNING, health: { agents: [agent('ember', { lastInference: null })] } });
    expect(r.lines[4]).toBe('– ember has made no model call since this host started or last switched session.');
  });

  test('failed turns are a problem, with the command that lists them and why doctor doesn\'t print them', async () => {
    const at = install();
    const r = await run(at, { states: RUNNING, health: { agents: [agent('ember', {
      consecutiveInferenceFailures: 3, lastInference: { startedAt: STARTED, failedAt: FAILED },
    })] } });
    expect(r.lines.slice(4, 6)).toEqual([
      '✗ ember\'s last 3 turns failed at the model call, the latest at 2026-11-14T10:05:00.000Z.',
      '  Next: each failure\'s reason is in the host\'s log, in a line that starts `[inference-failed] agent=ember`. They can ' +
        `quote the model provider, so doctor doesn't print them: \`journalctl --user -u ${HOST} -g '\\[inference-failed\\] agent=ember '\` lists them.`,
    ]);
  });

  test('one failed turn reads in the singular, and on launchd the command greps the agent log', async () => {
    const at = install({ launchd: true });
    const r = await run(at, { states: { [LABEL]: 'running' }, health: { agents: [agent('ember', {
      consecutiveInferenceFailures: 1, lastInference: { startedAt: STARTED, failedAt: FAILED },
    })] } });
    expect(r.lines[4]).toBe('✗ ember\'s last turn failed at the model call, the latest at 2026-11-14T10:05:00.000Z.');
    expect(r.lines[5]).toEndWith(`\`grep -F -- '[inference-failed] agent=ember ' ${join(at.work, 'logs', 'agent.log')}\` lists them.`);
  });

  test('refusals give one more line, never a problem, with no category', async () => {
    const at = install();
    const r = await run(at, { states: RUNNING, health: { agents: [agent('ember', {
      refusalStats: { total: 2, lastAt: FAILED, lastCategory: 'cyber' },
    })] } });
    expect(r.lines.slice(4, 6)).toEqual([
      '✓ ember: no failed model call in a row.',
      '  ember was refused 2 times since this host started or last switched session, the last at 2026-11-14T10:05:00.000Z.',
    ]);
    expect(r.status).toBe(0);
  });

  test('another agent gets a line only with a failure or a refusal', async () => {
    const at = install();
    const quiet = await run(at, { states: RUNNING, health: { agents: [agent('ember'), agent('helper')] } });
    expect(quiet.out).not.toContain('helper');
    const failing = await run(at, { states: RUNNING, health: { agents: [agent('ember'), agent('helper', {
      consecutiveInferenceFailures: 2, lastInference: { startedAt: STARTED, failedAt: FAILED },
    })] } });
    expect(failing.out).toContain('✗ helper\'s last 2 turns failed at the model call');
  });

  test('a host that gives no counts leaves the check not made, with why', async () => {
    const at = install();
    expect((await run(at, { states: RUNNING, health: 'refused' })).lines[4])
      .toBe('– Not checked: the host didn\'t give its counts of model calls: unknown panel op: health.');
    expect((await run(at, { states: RUNNING, health: 'silent', healthWaitMs: 200 })).lines[4])
      .toBe('– Not checked: the host didn\'t give its counts of model calls: no answer came within 0.2 s.');
  });

  test('counts not of the form doctor reads leave the check not made, with why', async () => {
    const at = install();
    expect((await run(at, { states: RUNNING, health: {} })).lines[4])
      .toBe('– Not checked: the host didn\'t give its counts of model calls: its answer has no list of agents.');
    expect((await run(at, { states: RUNNING, health: { agents: [{ name: 'ember' }] } })).lines[4])
      .toBe('– Not checked: the host didn\'t give its counts of model calls: an agent in its answer has no name or no count of failed turns.');
  });

  test('a failure with no time, on a host with no service, gives no time and no command', async () => {
    const at = install({ unit: false });
    const r = await run(at, { health: { agents: [agent('ember', {
      consecutiveInferenceFailures: 2, lastInference: { startedAt: STARTED },
    })] } });
    const at4 = r.lines.indexOf('✗ ember\'s last 2 turns failed at the model call.');
    expect(at4).toBeGreaterThan(0);
    expect(r.lines[at4 + 1]).toBe('  Next: each failure\'s reason is in the host\'s log, in a line that starts ' +
      '`[inference-failed] agent=ember`. They can quote the model provider, so doctor doesn\'t print them.');
  });
});

describe('connectome doctor: check 5, the Discord token', () => {
  test('with no token in .env, it is not checked', async () => {
    const at = install({ env: `ANTHROPIC_API_KEY="${KEY}"\n` });
    expect((await run(at, { states: RUNNING, health: HEALTHY })).lines[5]).toBe('– Not checked: .env holds no DISCORD_TOKEN.');
  });

  test('a refused token is a problem, with how to store a new one', async () => {
    const at = install({ env: 'DISCORD_TOKEN="a-wrong-token-value"\n' });
    const r = await run(at, { states: RUNNING, health: HEALTHY });
    expect(r.lines.slice(5, 7)).toEqual([
      '✗ Discord refuses the token.',
      '  Next: store the bot token from the Developer Portal\'s Bot page with ' +
        `\`${join(at.root, 'connectome')} setup discord\`, which stores it in ${join(at.work, '.env')}, then restart the ` +
        `service and run \`${join(at.root, 'connectome')} doctor\` again.`,
    ]);
  });

  test('a token written with its Bot prefix is sent without it', async () => {
    const at = install({ env: `DISCORD_TOKEN="Bot ${TOKEN}"\n` });
    expect((await run(at, { states: RUNNING, health: HEALTHY })).lines[5]).toBe('✓ Discord accepts the token: the bot is ember-bot.');
  });

  test('a token that can\'t be sent is a problem', async () => {
    const at = install({ env: 'DISCORD_TOKEN="tok\u2603en"\n' });
    const r = await run(at, { states: RUNNING, health: HEALTHY });
    expect(r.lines[5]).toBe('✗ The token in .env can\'t be sent: it holds a character that a header can\'t carry.');
  });

  test('an answer doctor can\'t read leaves the check not made, with its kind', async () => {
    const at = install();
    const down = (async () => new Response('busy', { status: 503 })) as unknown as typeof fetch;
    expect((await run(at, { states: RUNNING, health: HEALTHY, fetch: down })).lines[5])
      .toBe('– Discord gave no answer that doctor could read (an answer of 503).');
    const unanswered = (async () => { throw new Error('getaddrinfo ENOTFOUND discord.com'); }) as unknown as typeof fetch;
    expect((await run(at, { states: RUNNING, health: HEALTHY, fetch: unanswered })).lines[5])
      .toBe('– Discord gave no answer that doctor could read (getaddrinfo ENOTFOUND discord.com).');
    const moved = (async () => new Response(null, { status: 301, headers: { location: 'https://discord.com/elsewhere' } })) as unknown as typeof fetch;
    expect((await run(at, { states: RUNNING, health: HEALTHY, fetch: moved })).lines[5])
      .toBe('– Discord gave no answer that doctor could read (a redirect, 301).');
  });
});

describe('connectome doctor: the closing line', () => {
  test('it counts the problems and the checks not made, and exits 1 with a problem', async () => {
    const at = install();
    const r = await run(at, { states: { [HOST]: 'inactive/dead' } });
    expect(r.lines.at(-1)).toBe('Doctor found 2 problems, marked ✗. 1 check wasn\'t made, marked –.');
    expect(r.status).toBe(1);
  });

  test('with no problem and a check not made, it says so and exits 0', async () => {
    const at = install({ env: `ANTHROPIC_API_KEY="${KEY}"\n` });
    const r = await run(at, { states: RUNNING, health: HEALTHY });
    expect(r.lines.slice(-2, -1)).toEqual(['Doctor found no problem. 1 check wasn\'t made, marked –.']);
    expect(r.status).toBe(0);
  });

  test('it counts more than one check not made in the plural', async () => {
    const at = install({ env: `ANTHROPIC_API_KEY="${KEY}"\n` });
    const r = await run(at, { states: RUNNING });
    expect(r.lines.at(-1)).toBe('Doctor found 1 problem, marked ✗. 2 checks weren\'t made, marked –.');
  });

  test('the ladder line passes --data-dir where the install\'s data directory isn\'t INSTALL_DIR/data', async () => {
    const top = mkdtempSync(join(tmpdir(), 'chost-doctor5-data-'));
    dirs.push(top);
    const at = install({ dataDir: join(top, 'elsewhere') });
    const r = await run(at, { states: RUNNING, health: HEALTHY });
    expect(r.lines.at(-1)).toEndWith(` ${at.work} ${HOST} --data-dir ${join(top, 'elsewhere')}`);
  });

  test('on launchd there is no ladder line', async () => {
    const at = install({ launchd: true });
    const r = await run(at, { states: { [LABEL]: 'running' }, health: HEALTHY });
    expect(r.lines.at(-1)).toBe('Doctor found no problem.');
  });
});
