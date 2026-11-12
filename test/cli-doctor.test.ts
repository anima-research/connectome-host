import { describe, test, expect, afterAll } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { main } from '../src/cli/connectome.js';
import { doctor, type DoctorParts } from '../src/cli/doctor.js';
import { plist, serviceUnits, systemdUnit } from '../src/cli/service-unit.js';

const SECRETS = {
  DISCORD_TOKEN: 'tok-secret-value',
  SESSION_SERVER_TOKEN: 'shell-secret-value',
  ANTHROPIC_API_KEY: 'sk-secret-key',
  LONELY_SECRET: 'lonely-secret-value',
};
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

interface Install { work: string; root: string; data: string; platform: NodeJS.Platform; home: string; unit: string }

const RECIPE = (work: string) => ({
  name: 'Ember',
  agent: { name: 'ember', model: 'claude-test-model', systemPrompt: 'hello' },
  mcpServers: {
    discord: { command: join(work, 'node_modules/.bin/discord-mcpl'), env: { DISCORD_TOKEN: '${DISCORD_TOKEN}', DISCORD_GUILD_ID: '100' } },
    shell: { command: join(work, 'node_modules/.bin/terminal-sessions-mcp'), env: { SESSION_SERVER_TOKEN: '${SESSION_SERVER_TOKEN}' } },
  },
});

function install(opts: {
  stored?: string[];
  env?: Record<string, string>;
  drop?: string[];
  recipe?: Record<string, unknown>;
  overlay?: Record<string, unknown>;
  manager?: 'systemd-user' | 'launchd';
  prefix?: string;
} = {}): Install {
  const top = mkdtempSync(join(tmpdir(), opts.prefix ?? 'chost-doctor-'));
  dirs.push(top);
  const work = join(top, 'test');
  const root = join(work, 'connectome-host');
  const data = join(work, 'data');
  mkdirSync(root, { recursive: true });
  mkdirSync(data);
  mkdirSync(join(work, '.setup'));
  writeFileSync(join(root, 'install.json'), JSON.stringify({ v: 1, dataDir: data, extraState: [] }));
  const platform: NodeJS.Platform = opts.manager === 'launchd' ? 'darwin' : 'linux';
  const home = join(top, 'home');
  const at: Install = { work, root, data, platform, home, unit: serviceUnits(root, platform, home)!.host.file };
  writeUnit(at, join(work, 'recipe.json'));
  const env: Record<string, string> = { ...SECRETS, ...opts.env };
  for (const name of opts.drop ?? []) delete env[name];
  writeFileSync(join(work, '.env'), Object.entries(env).map(([k, v]) => `${k}="${v}"`).join('\n') + '\n');
  writeFileSync(join(work, '.setup', 'stored-secrets.json'), JSON.stringify(opts.stored ?? ['DISCORD_TOKEN', 'SESSION_SERVER_TOKEN']));
  writeFileSync(join(work, 'recipe.json'), JSON.stringify(opts.recipe ?? RECIPE(work)));
  if (opts.overlay) writeFileSync(join(work, 'mcpl-servers.agent.json'), JSON.stringify({ mcplServers: opts.overlay }));
  return at;
}

function writeUnit(at: Install, recipe: string, work = at.work, bun = process.execPath): void {
  const units = serviceUnits(at.root, at.platform, at.home)!;
  const argv = [bun, join(at.root, 'start.js'), recipe, '--headless'];
  const env = Object.entries(unitEnvironment(at));
  mkdirSync(dirname(units.host.file), { recursive: true });
  writeFileSync(units.host.file, units.manager === 'systemd-user'
    ? systemdUnit('Connectome test', work, argv, env, null)
    : plist(units.host.name, work, argv, env, join(work, 'logs', 'agent.log')));
}

interface FakeHost { stop: () => void; received: string[] }

function fakeHost(at: Install, answers: Record<string, unknown>, opts: { closeOnRequest?: boolean } = {}): FakeHost {
  const received: string[] = [];
  const tails = new Map<unknown, string>();
  const server = Bun.listen({
    unix: join(at.data, 'ipc.sock'),
    socket: {
      open(socket) {
        socket.write(JSON.stringify({ type: 'lifecycle', phase: 'ready', pid: 4242, dataDir: at.data, recipe: 'Ember' }) + '\n');
      },
      data(socket, chunk) {
        const frames = ((tails.get(socket) ?? '') + chunk.toString()).split('\n');
        tails.set(socket, frames.pop()!);
        for (const line of frames.filter(Boolean)) {
          const msg = JSON.parse(line) as { type: string; op?: string; corrId?: string };
          if (msg.type !== 'panel-request') continue;
          received.push(msg.op!);
          if (opts.closeOnRequest) {
            socket.end();
            return;
          }
          if (answers === SILENT) continue;
          const data = msg.op === 'health' && !('health' in answers) ? HEALTH : answers[msg.op!];
          socket.write(JSON.stringify(data === undefined
            ? { type: 'panel-response', corrId: msg.corrId, op: msg.op, ok: false, error: `unknown panel op: ${msg.op}` }
            : { type: 'panel-response', corrId: msg.corrId, op: msg.op, ok: true, data }) + '\n');
        }
      },
    },
  });
  return { stop: () => server.stop(true), received };
}

const SILENT: Record<string, unknown> = {};

const STARTED = Date.parse('2026-11-12T05:00:00.000Z');
const HEALTH = {
  at: '2026-11-12T06:00:00.000Z',
  uptimeSec: 3600,
  agents: [{
    name: 'ember', status: 'idle', consecutiveInferenceFailures: 0,
    lastInference: { startedAt: STARTED, endedAt: STARTED + 4_000 }, refusalStats: null,
  }],
};

const STANDIN_BESIDE = { tokens: null, source: 'preview_failed', error: 'the stand-in host builds no request' };
const COUNTED = {
  agent: { model: 'claude-small-window', countModel: 'claude-small-window', source: 'count_tokens' },
  compression: { model: 'claude-small-window', countModel: 'claude-small-window', source: 'count_tokens' },
  beside: STANDIN_BESIDE,
};
const HEALTHY_HOST = {
  'shell-check': { shells: [{ server: 'shell', answered: true, sessions: 2 }], notConnected: [], closedTabs: [] },
  'count-check': COUNTED,
};

const OTHER_TOKEN = 'other-token-value';
const BOTS: Record<string, { id: string; username: string }> = {
  [`Bot ${SECRETS.DISCORD_TOKEN}`]: { id: '900', username: 'ember' },
  [`Bot ${OTHER_TOKEN}`]: { id: '901', username: 'second' },
};

const discordFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const bot = BOTS[new Headers(init?.headers).get('authorization') ?? ''];
  if (bot === undefined) return Response.json({ message: '401: Unauthorized', code: 0 }, { status: 401 });
  const path = new URL(String(input)).pathname.replace(/^\/api\/v10/, '');
  if (path === '/users/@me') return Response.json(bot);
  if (path === '/applications/@me') return Response.json({ flags: 1 << 19 });
  if (path === '/users/@me/guilds') return Response.json([{ id: '100', name: 'Home' }]);
  if (path === '/guilds/100/roles') return Response.json([{ id: '100', permissions: String(1 << 10) }]);
  if (path === `/guilds/100/members/${bot.id}`) return Response.json({ roles: [] });
  if (path === '/guilds/100/channels') return Response.json([{ id: '101', name: 'general', type: 0, permission_overwrites: [] }]);
  return new Response('not found', { status: 404 });
}) as typeof fetch;

function fakePython(dir: string, opts: { sleep?: number; end?: 'findings' | 'lines' | 'traceback' | 'clean' | 'signal' | 'garbled' | 'silent' | 'misshapen' } = {}): string {
  const end = opts.end ?? 'lines';
  const path = join(dir, opts.sleep ? 'python3-slow' : end !== 'lines' ? `python3-${end}` : 'python3');
  const LINE = '{"text":"a line the ladder only says","counts":false}';
  const COUNTED = '{"text":"a finding the ladder counts","counts":true}';
  const written = (json: string): string[] => [`printf '%s\\n' 'connectome-doctor findings: ${json}'`, 'exit 0'];
  writeFileSync(path, [
    '#!/bin/sh',
    'shift',
    'echo "ladder args: $*"',
    `printf '%s' "$CONNECTOME_DOCTOR_WITHHOLD" > '${join(dir, 'withheld.json')}'`,
    'echo "ladder XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR"',
    `echo "recent failure: Error token=${SECRETS.DISCORD_TOKEN}"`,
    ...(opts.sleep ? [`sleep ${opts.sleep}`] : []),
    ...(end === 'traceback'
      ? ['printf "partial line"', 'echo "Traceback (most recent call last):" >&2', 'exit 1']
      : end === 'signal'
        ? ['kill -TERM $$']
        : end === 'clean'
          ? written('[]')
          : end === 'silent'
            ? ['exit 0']
            : end === 'misshapen'
              ? written('[{"text":"a finding","counts":"false"}]')
            : end === 'garbled'
              ? written('[{"text":')
              : end === 'findings'
                ? written(`[${COUNTED},${LINE}]`)
                : written(`[${LINE}]`)),
  ].join('\n') + '\n');
  chmodSync(path, 0o755);
  return path;
}

let managers = 0;

const unitWords = (data: string): string => `PATH=${process.env.PATH ?? '/usr/bin:/bin'} DATA_DIR=${data} CONNECTOME_SUPERVISED=1`;

function fakeManager(dir: string, opts: {
  env?: string[]; launchd?: Record<string, string>; fails?: string; hangs?: true; unit?: string | null; unitFails?: string;
  filesFail?: string;
} = {}) {
  const at = join(dir, `manager-${++managers}`);
  mkdirSync(join(at, 'values'), { recursive: true });
  writeFileSync(join(at, 'environment'), (opts.env ?? []).map((line) => `${line}\n`).join(''));
  const unit = opts.unit === undefined ? unitWords(join(dir, 'data')) : opts.unit ?? '';
  writeFileSync(join(at, 'unit-environment'), `${unit}\n`);
  for (const [name, value] of Object.entries(opts.launchd ?? {})) writeFileSync(join(at, 'values', name), `${value}\n`);
  const path = join(at, 'manager');
  writeFileSync(path, [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${join(at, 'calls')}`,
    ...(opts.hangs ? ['exec sleep 30'] : []),
    ...(opts.fails === undefined ? [] : [`echo '${opts.fails}' >&2`, 'exit 1']),
    `if [ "$*" = "--user show-environment" ]; then cat ${join(at, 'environment')}; exit 0; fi`,
    ...(opts.unitFails === undefined ? [] : [`if [ "$*" = "--user show --property=Environment --value -- connectome-test.service" ]; then echo '${opts.unitFails}' >&2; exit 1; fi`]),
    `if [ "$*" = "--user show --property=Environment --value -- connectome-test.service" ]; then cat ${join(at, 'unit-environment')}; exit 0; fi`,
    `if [ "$1" = getenv ] && [ $# -eq 2 ]; then if [ -f "${join(at, 'values')}/$2" ]; then cat "${join(at, 'values')}/$2"; fi; exit 0; fi`,
    ...(opts.filesFail === undefined ? [] : [`if [ "$*" = "--user show --property=EnvironmentFiles --value -- connectome-test.service" ]; then echo '${opts.filesFail}' >&2; exit 1; fi`]),
    `if [ "$*" = "--user show --property=EnvironmentFiles --value -- connectome-test.service" ]; then if [ -f ${join(at, 'environment-files')} ]; then cat ${join(at, 'environment-files')}; fi; exit 0; fi`,
    'echo "unexpected: $*" >&2',
    'exit 2',
  ].join('\n') + '\n');
  chmodSync(path, 0o755);
  const calls = (): string[] => existsSync(join(at, 'calls'))
    ? readFileSync(join(at, 'calls'), 'utf-8').split('\n').filter(Boolean) : [];
  return { path, calls };
}

const unitEnvironment = (at: Install): Record<string, string> => ({
  PATH: process.env.PATH ?? '/usr/bin:/bin', DATA_DIR: at.data, CONNECTOME_SUPERVISED: '1',
});

let plists = 0;

function fakePlutil(dir: string, variables: Record<string, string> | null): string {
  const path = join(dir, `plutil-${++plists}`);
  const json = join(dir, `plist-environment-${plists}.json`);
  if (variables !== null) writeFileSync(json, JSON.stringify(variables));
  writeFileSync(path, [
    '#!/bin/sh',
    `if [ "$1 $2 $3 $4 $5" = "-extract EnvironmentVariables json -o -" ] && [ -f '${json}' ]; then cat '${json}'; exit 0; fi`,
    'echo "Could not extract value, error: No value at that key path or invalid key path: EnvironmentVariables" >&2',
    'exit 1',
  ].join('\n') + '\n');
  chmodSync(path, 0o755);
  return path;
}

async function run(at: Install, parts: Partial<DoctorParts> = {}, argv: string[] = [], out: string[] = []) {
  const err: string[] = [];
  const manager = fakeManager(at.work, {
    unit: Object.entries(unitEnvironment(at)).map(([name, value]) => `${name}=${value}`).join(' '),
  }).path;
  const status = await doctor({ root: at.root, argv, out: (l) => out.push(l), err: (l) => err.push(l) }, {
    fetch: discordFetch,
    checkService: async () => ({ passed: true, lines: ['The unit connectome-test.service is active, with no restarts.'] }),
    python: fakePython(at.work),
    hostLimitMs: 60_000,
    ladderLimitMs: 60_000,
    systemctl: manager,
    launchctl: manager,
    envLimitMs: 60_000,
    recipeLimitMs: 60_000,
    plutil: fakePlutil(at.work, unitEnvironment(at)),
    servicePid: async () => ({ pid: '4242' }),
    platform: at.platform,
    home: at.home,
    ...parts,
  });
  return { status, out: out.join('\n'), err: err.join('\n') };
}

async function withHost<T>(at: Install, answers: Record<string, unknown>, body: (host: FakeHost) => Promise<T>, opts = {}): Promise<T> {
  const host = fakeHost(at, answers, opts);
  try {
    return await body(host);
  } finally {
    host.stop();
  }
}

async function digestOf(at: Install): Promise<string> {
  const { loadRecipeDocument, readRecipeDocument, recipeDigest } = await import('../src/recipe.js') as unknown as {
    loadRecipeDocument: (document: unknown, path: string, options: { env: Record<string, string> }) => Promise<{ recipe: unknown }>;
    readRecipeDocument: (path: string) => Promise<unknown>;
    recipeDigest: (recipe: unknown) => string;
  };
  const path = join(at.work, 'recipe.json');
  return recipeDigest((await loadRecipeDocument(await readRecipeDocument(path), path, { env: SECRETS })).recipe);
}

const reports = (...lines: string[]): Partial<DoctorParts> => ({ checkService: async () => ({ passed: true, lines }) });

function expectNoSecret(text: string): void {
  for (const value of Object.values(SECRETS)) expect(text).not.toContain(value);
}

describe('connectome doctor', () => {
  test('a healthy install: every check made passes, the fit is said not checked for a model whose window isn\'t known, the ladder runs with the data directory, the working directory and the unit, withholding the stored values, and the exit is 0', async () => {
    const at = install();
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).toContain('connectome-test.service is active');
    expect(r.out).toContain('pid 4242');
    expect(r.out).toContain('shell reached its daemon: 2 sessions.');
    expect(r.out).toContain('ember (900)');
    expect(r.out).toContain(`ladder args: --findings-json --data-dir ${at.data} ${at.work} connectome-test.service`);
    const withheld = JSON.parse(readFileSync(join(at.work, 'withheld.json'), 'utf-8')) as Array<[string, string]>;
    for (const name of ['DISCORD_TOKEN', 'SESSION_SERVER_TOKEN', 'ANTHROPIC_API_KEY'] as const) {
      expect(withheld).toContainEqual([name, SECRETS[name]]);
    }
    expect(r.out).toContain('<DISCORD_TOKEN>');
    expect(r.out).toContain('[fit] Not checked: whether agent.contextBudgetTokens and agent.maxTokens fit claude-test-model\'s window.');
    expectNoSecret(r.out + r.err);
    expect(r.status).toBe(0);
  });

  test('a server kept as a closed tab is said in a plain line, not as a problem, and the exit stays 0', async () => {
    const at = install();
    const r = await withHost(at, {
      ...HEALTHY_HOST,
      'shell-check': { ...HEALTHY_HOST['shell-check'], closedTabs: ['games'] },
    }, () => run(at));
    expect(r.out).toContain('The server games is a closed tab: the host connects it when an agent opens it, so its connection isn\'t checked.');
    expect(r.out).not.toMatch(/✗.*games/);
    expect(r.status).toBe(0);
  });

  test('a shell server the host\'s session switch left unchecked is said in a plain line and named in the closing line, not as a problem', async () => {
    const at = install();
    const r = await withHost(at, {
      ...HEALTHY_HOST,
      'shell-check': { ...HEALTHY_HOST['shell-check'], unchecked: ['other'] },
    }, () => run(at));
    expect(r.out).toContain('The server other wasn\'t checked: the host switched sessions during the check.');
    expect(r.out).not.toMatch(/✗.*other/);
    expect(r.out).toMatch(/Doctor found no problem, though .*a shell server the host's session switch left unchecked, as said above\.$/);
    expect(r.status).toBe(0);
  });

  test('with every shell server unchecked for a session switch, doctor doesn\'t say no server offers listSessions', async () => {
    const at = install();
    const r = await withHost(at, {
      ...HEALTHY_HOST,
      'shell-check': { ...HEALTHY_HOST['shell-check'], shells: [], unchecked: ['shell'] },
    }, () => run(at));
    expect(r.out).toContain('The server shell wasn\'t checked: the host switched sessions during the check.');
    expect(r.out).not.toContain('offers listSessions');
  });

  test('with no connected server offering listSessions, a closed tab is named as one that may be the shell, beside a server that isn\'t connected when there is one', async () => {
    const at = install();
    const r = await withHost(at, {
      ...HEALTHY_HOST,
      'shell-check': { shells: [], notConnected: [], closedTabs: ['shell'] },
    }, () => run(at));
    expect(r.out).toContain('No connected server offers listSessions, so there\'s no shell to call; a closed tab may be the shell.');
    expect(r.status).toBe(0);
    const other = install();
    const both = await withHost(other, {
      ...HEALTHY_HOST,
      'shell-check': { shells: [], notConnected: [{ id: 'down', retrying: false, refused: null }], closedTabs: ['shell'] },
    }, () => run(other));
    expect(both.out).toContain('No connected server offers listSessions, so there\'s no shell to call; a server that isn\'t ' +
      'connected or a closed tab may be the shell.');
    expect(both.status).toBe(1);
  });

  test('a compression count refused for its credential is a line naming each credential the host may send, not a problem', async () => {
    const at = install();
    const r = await withHost(at, {
      ...HEALTHY_HOST,
      'count-check': { beside: STANDIN_BESIDE,
        agent: { model: 'claude-small-window', countModel: 'claude-small-window', source: 'count_tokens' },
        compression: { model: 'claude-old', countModel: 'claude-old', source: 'count_tokens_failed_401' },
      },
    }, () => run(at));
    expect(r.out).toContain('\n  count_tokens couldn\'t count with the compression model, claude-old: count_tokens refused ' +
      'the credential the host sent (401): its subscription login when it has one, else ANTHROPIC_AUTH_TOKEN, else ' +
      'ANTHROPIC_API_KEY. Replace that credential where the service gets it, and restart the service.');
    expect(r.out).not.toContain('✗ count_tokens');
  });

  test('a count that fails short of refusing the resident\'s own credential is a line, not a problem', async () => {
    const sources = ['count_tokens_failed_404', 'count_tokens_failed_500', 'count_tokens_timeout', 'count_tokens_error'];
    for (const source of sources) {
      const at = install();
      const r = await withHost(at, {
        ...HEALTHY_HOST,
        'count-check': { ...COUNTED, agent: { model: 'claude-small-window', countModel: 'claude-small-window', source } },
      }, () => run(at, { python: fakePython(at.work, { end: 'clean' }) }));
      expect([source, r.out]).toEqual([source, expect.stringContaining('\n  count_tokens couldn\'t count with claude-small-window: ')]);
      expect([source, r.out.includes('✗ count_tokens'), r.status]).toEqual([source, false, 0]);
    }
  });

  test('the agent count\'s 401 is a problem where the resident runs on Anthropic, and a line where it runs on another provider', async () => {
    const refused = { ...COUNTED, agent: { model: 'claude-small-window', countModel: 'claude-small-window', source: 'count_tokens_failed_401' } };
    const anthropic = install();
    const own = await withHost(anthropic, { ...HEALTHY_HOST, 'count-check': refused }, () => run(anthropic));
    expect(own.out).toContain('✗ count_tokens couldn\'t count with claude-small-window: count_tokens refused the credential');
    const other = install({ recipe: { ...RECIPE(''), agent: { name: 'ember', provider: 'openrouter', model: 'claude-small-window', systemPrompt: 'hi' } } });
    const elsewhere = await withHost(other, { ...HEALTHY_HOST, 'count-check': refused }, () => run(other));
    expect(elsewhere.out).toContain('\n  count_tokens couldn\'t count with claude-small-window: count_tokens refused the credential');
    expect(elsewhere.out).not.toContain('✗ count_tokens');
    const unloaded = install({ recipe: { ...RECIPE(''), agent: { name: 'ember', provider: 'not-a-provider', model: 'claude-small-window', systemPrompt: 'hi' } } });
    const unknown = await withHost(unloaded, { ...HEALTHY_HOST, 'count-check': refused }, () => run(unloaded));
    expect(unknown.out).toMatch(/✗ \S+recipe\.json doesn't load: /);
    expect(unknown.out).toContain('\n  count_tokens couldn\'t count with claude-small-window: count_tokens refused the credential');
    expect(unknown.out).not.toContain('✗ count_tokens');
  });

  test('a service stopped on purpose is said as stopped, with the command that starts it, and with no host answering is no problem', async () => {
    const at = install();
    let asked: unknown[] = [];
    const r = await run(at, {
      checkService: async (...args: unknown[]) => {
        asked = args;
        return { passed: true, lines: ['connectome-test.service is stopped: systemd shows it inactive (dead).'], stopped: true };
      },
      python: fakePython(at.work, { end: 'clean' }),
    });
    expect([asked[2], asked[4]]).toEqual([true, true]);
    expect(r.out).toContain('It\'s stopped.');
    expect(r.out).toMatch(/No host answers, since its service is stopped: `(XDG_RUNTIME_DIR=\S+ )?systemctl --user start connectome-test\.service` starts it\./);
    expect(r.out).not.toMatch(/✗ (No host answers|The service check)/);
    const failed = await run(at, { checkService: async () => ({ passed: false, lines: ['The unit is failed.'] }) });
    expect(failed.out).toMatch(/✗ The service check above didn't pass/);
    expect(failed.out).toMatch(/✗ No host answers/);
    const closing = Bun.listen({ unix: join(at.data, 'ipc.sock'), socket: { open(socket) { socket.end(); }, data() {} } });
    try {
      const unready = await run(at, {
        checkService: async () => ({ passed: true, lines: ['connectome-test.service is stopped: systemd shows it inactive (dead).'], stopped: true }),
        python: fakePython(at.work, { end: 'clean' }),
      });
      expect(unready.out).toMatch(/✗ No host answers: the socket \S+ closed before a host said it was ready\./);
      expect(unready.out).not.toContain('since its service is stopped');
    } finally {
      closing.stop(true);
    }
  });

  test('a count the host had no credential to send is a line naming where it looks, for the agent and the compression model, and asks to replace nothing', async () => {
    const at = install();
    const r = await withHost(at, {
      ...HEALTHY_HOST,
      'count-check': { beside: STANDIN_BESIDE,
        agent: { model: 'claude-small-window', countModel: 'claude-small-window', source: 'count_tokens_no_credential' },
        compression: { model: 'claude-old', countModel: 'claude-old', source: 'count_tokens_no_credential' },
      },
    }, () => run(at));
    const none = 'count_tokens had no Anthropic credential to send: the host looks for its subscription login, then ' +
      'ANTHROPIC_AUTH_TOKEN, then ANTHROPIC_API_KEY, and has none.';
    expect(r.out).toContain(`\n  ${none} So the context's makeup shows no exact total.\n`);
    expect(r.out).toContain(`\n  ${none} So the compression model, claude-old, isn't checked.\n`);
    expect(r.out).not.toContain('Replace that credential');
    expect(r.out).not.toContain('✗');
    expect(r.status).toBe(0);
  });

  test('the ladder\'s findings are doctor\'s: one that counts is a problem marked ✗, another a line, and the last line counts them all', async () => {
    const at = install();
    const r = await withHost(at, HEALTHY_HOST, () => run(at, { python: fakePython(at.work, { end: 'findings' }) }));
    expect(r.out).toMatch(/^  ✗ a finding the ladder counts$/m);
    expect(r.out).toMatch(/^  a line the ladder only says$/m);
    expect(r.out).not.toContain('ladder\'s, which');
    expect(r.out).toMatch(/Doctor found 1 problem, marked ✗\.$/);
    expect(r.status).toBe(1);
  });

  test('a ladder whose findings are only lines leaves the exit 0, and one whose findings can\'t be read is a problem', async () => {
    const at = install();
    const lines = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(lines.out).toMatch(/^  a line the ladder only says$/m);
    expect(lines.out).not.toContain('✗');
    expect(lines.out).toMatch(/Doctor found no problem, though the fit wasn't checked, as said above\.$/);
    expect(lines.status).toBe(0);
    const garbled = await withHost(at, HEALTHY_HOST, () => run(at, { python: fakePython(at.work, { end: 'garbled' }) }));
    expect(garbled.out).toMatch(/✗ The ladder finished, but its findings can't be read: /);
    expect(garbled.out).not.toContain('connectome-doctor findings:');
    expect(garbled.status).toBe(1);
    const misshapen = await withHost(at, HEALTHY_HOST, () => run(at, { python: fakePython(at.work, { end: 'misshapen' }) }));
    expect(misshapen.out).toMatch(/✗ The ladder finished, but its findings can't be read: they aren't a list of findings\./);
    expect(misshapen.out).not.toMatch(/^  ✗ a finding$/m);
    const silent = await withHost(at, HEALTHY_HOST, () => run(at, { python: fakePython(at.work, { end: 'silent' }) }));
    expect(silent.out).toMatch(/✗ The ladder finished, but its findings can't be read: it printed none\./);
    expect(silent.status).toBe(1);
  });

  test('a ladder that stops before it finishes is a problem, and its partial line and its traceback are each a line', async () => {
    const at = install();
    const r = await withHost(at, HEALTHY_HOST, () => run(at, { python: fakePython(at.work, { end: 'traceback' }) }));
    expect(r.out).toMatch(/^  partial line$/m);
    expect(r.out).toMatch(/^  Traceback \(most recent call last\):$/m);
    expect(r.out.indexOf('partial line')).toBeLessThan(r.out.indexOf('Traceback'));
    expect(r.out).toMatch(/✗ The ladder stopped \(exit 1\) before it finished/);
    expect(r.status).toBe(1);
  });

  test('a ladder that finishes clean leaves the exit 0, and one a signal ends is a problem', async () => {
    const at = install();
    const clean = await withHost(at, HEALTHY_HOST, () => run(at, { python: fakePython(at.work, { end: 'clean' }) }));
    expect(clean.out).not.toContain('✗');
    expect(clean.out).toMatch(/Doctor found no problem, though the fit wasn't checked, as said above\.$/);
    expect(clean.status).toBe(0);
    const ended = await withHost(at, HEALTHY_HOST, () => run(at, { python: fakePython(at.work, { end: 'signal' }) }));
    expect(ended.out).toMatch(/✗ The ladder was ended by SIGTERM/);
    expect(ended.status).toBe(1);
  });

  test('when Bun\'s answer in the working directory isn\'t an environment, doctor stops saying so, and quotes none of it', async () => {
    const at = install();
    writeFileSync(join(at.work, 'bunfig.toml'), 'preload = ["./pre.ts"]\n');
    writeFileSync(join(at.work, 'pre.ts'), 'process.stdout.write("quoted-marker ");\n');
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).toMatch(/✗ Bun's answer in .* wasn't an environment doctor could read: something else wrote to its output, as a bunfig\.toml preload can\./);
    expect(r.out).not.toContain('quoted');
    expect(r.out).toContain('Doctor stops here');
    expect(r.status).toBe(1);
  });

  test('when Bun fails in the working directory, doctor stops quoting none of its error, says how to see it, and withholds the install\'s path', async () => {
    const at = install({ prefix: `chost-${SECRETS.LONELY_SECRET}-`, stored: ['DISCORD_TOKEN', 'SESSION_SERVER_TOKEN', 'LONELY_SECRET'] });
    writeFileSync(join(at.work, 'bunfig.toml'), 'preload = ["./pre.ts"]\n');
    writeFileSync(join(at.work, 'pre.ts'), 'throw new Error(`refused ${process.env.DISCORD_TOKEN}`);\n');
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).toMatch(/^connectome doctor: the install at .*<LONELY_SECRET>/);
    expect(r.out).toMatch(/✗ Bun exited 1 in .*<LONELY_SECRET>.* as it read the service's environment, and its error isn't shown, since it can hold \.env's values: run `bun -e 0` there to see it, though it runs with your shell's environment, not the service's\./);
    expect(r.out + r.err).not.toContain('refused');
    expect(r.out).toContain('Doctor stops here');
    expect(r.out.slice(r.out.indexOf('Doctor stops here')).split('\n').length).toBe(1);
    expectNoSecret(r.out + r.err);
    expect(r.status).toBe(1);
  });

  test('when a signal ends Bun in the working directory, doctor stops saying so', async () => {
    const at = install();
    writeFileSync(join(at.work, 'bunfig.toml'), 'preload = ["./pre.ts"]\n');
    writeFileSync(join(at.work, 'pre.ts'), 'process.kill(process.pid, "SIGTERM");\n');
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).toMatch(/✗ Bun was ended by SIGTERM in .* as it read the service's environment, and its error isn't shown/);
    expect(r.out).toContain('Doctor stops here');
    expectNoSecret(r.out + r.err);
    expect(r.status).toBe(1);
  });

  test('a provider credential only doctor\'s own environment holds is withheld too', async () => {
    const at = install({ drop: ['ANTHROPIC_API_KEY'] });
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-shell-only-key';
    try {
      const r = await withHost(at, HEALTHY_HOST, () => run(at, {
        checkService: async () => ({ passed: true, lines: ['The unit said: key sk-shell-only-key refused.'] }),
      }));
      expect(r.out).toContain('key <ANTHROPIC_API_KEY> refused');
      expect(r.out).not.toContain('sk-shell-only-key');
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  test('a stored secret\'s value as a command run in doctor\'s own environment reads it is withheld too', async () => {
    const at = install({ stored: ['DISCORD_TOKEN', 'SESSION_SERVER_TOKEN', 'MY_TOKEN'] });
    writeFileSync(join(at.work, '.env.local'), 'MY_TOKEN=${DOCTOR_ONLY_PREFIX}z9suffix\n');
    const saved = process.env.DOCTOR_ONLY_PREFIX;
    process.env.DOCTOR_ONLY_PREFIX = 'p7-prefix-';
    try {
      const r = await withHost(at, HEALTHY_HOST, () => run(at, {
        checkService: async () => ({ passed: true, lines: ['The unit said: token p7-prefix-z9suffix refused.'] }),
      }));
      const withheld = JSON.parse(readFileSync(join(at.work, 'withheld.json'), 'utf-8')) as Array<[string, string]>;
      expect(withheld).toContainEqual(['MY_TOKEN', 'p7-prefix-z9suffix']);
      expect(r.out).toContain('token <MY_TOKEN> refused');
      expect(r.out).not.toContain('p7-prefix-');
    } finally {
      if (saved === undefined) delete process.env.DOCTOR_ONLY_PREFIX;
      else process.env.DOCTOR_ONLY_PREFIX = saved;
    }
  });

  test('the install\'s own path is printed through the redactor too', async () => {
    const at = install({ prefix: `chost-${SECRETS.LONELY_SECRET}-`, stored: ['DISCORD_TOKEN', 'SESSION_SERVER_TOKEN', 'LONELY_SECRET'], recipe: { ...RECIPE(''), mcpServers: {} } });
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).toMatch(/^connectome doctor: the install at .*<LONELY_SECRET>/);
    expectNoSecret(r.out + r.err);
  });

  test('a loader warning is a line of the report, redacted, and nothing reaches the console', async () => {
    const at = install({ recipe: { ...RECIPE(''), [SECRETS.DISCORD_TOKEN]: 1 } });
    const warned: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(' ')); };
    try {
      const r = await withHost(at, HEALTHY_HOST, () => run(at));
      expect(r.out).toMatch(/keys the host does not read.*<DISCORD_TOKEN>/);
      expect(warned).toEqual([]);
      expectNoSecret(r.out + r.err);
    } finally {
      console.warn = warn;
    }
  });

  test('a stored DISCORD_TOKEN that no server gets is told to be named in a server\'s env, the one place discord-mcpl reads it', async () => {
    const at = install({ stored: ['DISCORD_TOKEN'], recipe: { ...RECIPE(''), mcpServers: { shell: RECIPE('').mcpServers.shell } } });
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).toMatch(/\n {2}DISCORD_TOKEN is in setup's list of stored secrets, and doctor finds no server given it: .* Name it as "\$\{DISCORD_TOKEN\}" in the recipe entry of the server that needs it: in its env, as "DISCORD_TOKEN": "\$\{DISCORD_TOKEN\}"\. mcpl-servers\.json /);
    expect(r.out).not.toMatch(/DISCORD_TOKEN is in setup's list of stored secrets, and doctor finds no server given it[^\n]*or in its args/);
  });

  test('a secret setup stored that no server\'s env maps is a line saying doctor finds none given it, the overlay\'s replacement included', async () => {
    const lonely = install({ stored: ['DISCORD_TOKEN', 'SESSION_SERVER_TOKEN', 'LONELY_SECRET'] });
    const r = await withHost(lonely, HEALTHY_HOST, () => run(lonely));
    expect(r.out).not.toMatch(/✗.*LONELY_SECRET/);
    expect(r.out).toMatch(/LONELY_SECRET is in setup's list of stored secrets, and doctor finds no server given it: no server the host starts is given it in its env or args, no server it dials names it in its token or url, and the recipe names it nowhere outside its servers\. Name it as "\$\{LONELY_SECRET\}" in the recipe entry of the server that needs it: in its env, as "LONELY_SECRET": "\$\{LONELY_SECRET\}", or in its args, or, for a server the host dials, in its token or url\. mcpl-servers\.json and the agent overlay take their values as written, with no \$\{…\} substituted\. For a server mcpl-servers\.json starts, a recipe entry can't set its env or args: move the server's definition out of mcpl-servers\.json into the recipe, or set "inheritEnv": true in its recipe entry, which hands it the host's whole environment, with LONELY_SECRET left out of the file's env, whose value would replace the host's\. An agent overlay entry replaces the recipe's and the file's, so the recipe can't reach a server the overlay defines while that entry is there: take the entry out of the overlay, put the server's definition, with its command or url, in the recipe, or in mcpl-servers\.json with a recipe entry that names it, and follow the steps above for whichever then defines it\. Then restart the service\./);
    expect(r.out).not.toMatch(/✗.*SESSION_SERVER_TOKEN/);
    expectNoSecret(r.out + r.err);
    expect(r.status).toBe(0);

    const shadowed = install({ overlay: { shell: { command: '/elsewhere/terminal-sessions-mcp', env: {} } } });
    const r2 = await withHost(shadowed, HEALTHY_HOST, () => run(shadowed));
    expect(r2.out).toMatch(/\n {2}SESSION_SERVER_TOKEN is in setup's list of stored secrets, and doctor finds no server given it/);
    expect(r2.out).not.toMatch(/✗.*SESSION_SERVER_TOKEN/);
  });

  test('a DISCORD_TOKEN in .env that setup didn\'t store is withheld too, from doctor\'s lines and the ladder\'s reads', async () => {
    const at = install({ stored: ['SESSION_SERVER_TOKEN'] });
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    const withheld = JSON.parse(readFileSync(join(at.work, 'withheld.json'), 'utf-8')) as Array<[string, string]>;
    expect(withheld).toContainEqual(['DISCORD_TOKEN', SECRETS.DISCORD_TOKEN]);
    expect(r.out).toContain('<DISCORD_TOKEN>');
    expectNoSecret(r.out + r.err);
  });

  test('with no stored-secrets list, every value of a name in its dotenv files that setup doesn\'t know is hidden, as setup--run hides it, and doctor says why', async () => {
    const at = install({ env: { LONELY_SECRET: SECRETS.LONELY_SECRET } });
    rmSync(join(at.work, '.setup', 'stored-secrets.json'));
    const python = join(at.work, 'python3-reads');
    writeFileSync(python, ['#!/bin/sh', `echo "the ladder read ${SECRETS.LONELY_SECRET} and ${SECRETS.DISCORD_TOKEN}"`,
      'echo "the ladder withheld <LONELY_SECRET> itself"', `echo "the ladder read ${SECRETS.DISCORD_TOKEN} alone"`,
      `echo "the ladder read ${SECRETS.SESSION_SERVER_TOKEN} and ${SECRETS.LONELY_SECRET}"`,
      'printf \'%s\\n\' \'connectome-doctor findings: []\'', 'exit 0'].join('\n'));
    chmodSync(python, 0o755);
    const r = await withHost(at, HEALTHY_HOST, () => run(at, { python }));
    const mark = (name: string) => ` (it holds a value of \`${name}\`, which doctor hides while the names list is missing, so it ` +
      'isn\'t shown as a command to run)';
    expect(r.out).toContain(`the ladder read <LONELY_SECRET> and <DISCORD_TOKEN>${mark('LONELY_SECRET')}\n`);
    expect(r.out).toContain(`the ladder withheld <LONELY_SECRET> itself${mark('LONELY_SECRET')}\n`);
    expect(r.out).toContain('the ladder read <DISCORD_TOKEN> alone\n');
    expect(r.out).toContain('the ladder read <SESSION_SERVER_TOKEN> and <LONELY_SECRET> (it holds values of `LONELY_SECRET` ' +
      'and `SESSION_SERVER_TOKEN`, which doctor hides while the names list is missing, so it isn\'t shown as a command to run)\n');
    expect(r.out).toContain('Doctor found no problem, though it couldn\'t check the stored secrets and the fit wasn\'t checked, as said above.');
    expect(r.out).toContain(`  There's no ${join(at.work, '.setup', 'stored-secrets.json')}, so which secrets setup stored ` +
      'isn\'t known and doctor can\'t check them, and it hides every value of a name setup doesn\'t know: LONELY_SECRET, ' +
      'SESSION_SERVER_TOKEN. Write it as a JSON list of the name of every secret, those in .env and any the host is ' +
      'given through its environment, and doctor checks them and shows the other values.');
    expectNoSecret(r.out + r.err);
    const known = install({ drop: ['SESSION_SERVER_TOKEN', 'LONELY_SECRET'] });
    rmSync(join(known.work, '.setup', 'stored-secrets.json'));
    expect((await withHost(known, HEALTHY_HOST, () => run(known))).out).toContain(`  There's no ` +
      `${join(known.work, '.setup', 'stored-secrets.json')}, so which secrets setup stored isn't known and doctor can't ` +
      'check them. Write it as a JSON list of the name of every secret, those in .env and any the host is given through ' +
      'its environment, and doctor checks them.');
    expect((await withHost(at, HEALTHY_HOST, () => run(at, { python: null }))).out).toContain('Doctor found no ' +
      'problem, though the ladder didn\'t run, it couldn\'t check the stored secrets and the fit wasn\'t checked, as said above.');
    const worded = install({ env: { WORD: 'stored' } });
    rmSync(join(worded.work, '.setup', 'stored-secrets.json'));
    const plain = join(worded.work, 'python3-plain');
    writeFileSync(plain, ['#!/bin/sh', 'printf \'%s\\n\' \'connectome-doctor findings: []\'', 'exit 0'].join('\n'));
    chmodSync(plain, 0o755);
    expect((await withHost(worded, HEALTHY_HOST, () => run(worded, { python: plain }))).out).toContain('Doctor found no ' +
      'problem, though it couldn\'t check the <WORD> secrets and the fit wasn\'t checked, as said above. (it holds a value of `WORD`');
    const named = install({ env: { PASSWORD: 'PASSWORD' } });
    rmSync(join(named.work, '.setup', 'stored-secrets.json'));
    const echo = join(named.work, 'python3-echo');
    writeFileSync(echo, ['#!/bin/sh', 'echo "the ladder read PASSWORD"', 'printf \'%s\\n\' \'connectome-doctor findings: []\'',
      'exit 0'].join('\n'));
    chmodSync(echo, 0o755);
    const own = (await withHost(named, HEALTHY_HOST, () => run(named, { python: echo }))).out;
    expect(own).toContain('the ladder read <PASSWORD> (it holds a value of `<PASSWORD>`, which doctor hides');
    expect(own).not.toContain('`PASSWORD`');
  });

  test('a server given the host\'s whole environment (inheritEnv) sees every stored secret its entry or the host doesn\'t replace, without a mapping', async () => {
    const at = install({
      recipe: {
        name: 'Ember',
        agent: { name: 'ember', model: 'claude-test-model', systemPrompt: 'hello' },
        mcpServers: {
          discord: { command: join('/x', 'node_modules/.bin/discord-mcpl'), inheritEnv: true, env: { DISCORD_GUILD_ID: '100' } },
          shell: { command: '/x/terminal-sessions-mcp', inheritEnv: true },
        },
      },
    });
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).not.toContain('✗');
    expect(r.out).toMatch(/✓.*SESSION_SERVER_TOKEN reaches .*shell/);
    expect(r.out).toContain('ember (900)');
    expect(r.status).toBe(0);
  });

  test('a stored secret reaches a server as the framework builds its environment: an entry\'s own value replaces what it inherits', async () => {
    const overridden = install({
      stored: ['DISCORD_TOKEN', 'SESSION_SERVER_TOKEN', 'LONELY_SECRET'],
      recipe: {
        ...RECIPE(''),
        mcpServers: {
          discord: { command: '/x/node_modules/.bin/discord-mcpl', env: { DISCORD_TOKEN: '${DISCORD_TOKEN}', DISCORD_GUILD_ID: '100' } },
          shell: { command: '/x/terminal-sessions-mcp', inheritEnv: true, env: { LONELY_SECRET: 'something else' } },
        },
      },
    });
    const r = await withHost(overridden, HEALTHY_HOST, () => run(overridden));
    expect(r.out).toMatch(/\n {2}LONELY_SECRET is in setup's list of stored secrets, and doctor finds no server given it/);
    expect(r.out).toMatch(/✓.*SESSION_SERVER_TOKEN reaches shell/);
  });

  test('a stored secret mapped only as AGENT_TIMEZONE doesn\'t reach the server, since the host sets that variable over every server\'s', async () => {
    const at = install({
      stored: ['DISCORD_TOKEN', 'SESSION_SERVER_TOKEN', 'LONELY_SECRET'],
      recipe: { ...RECIPE(''), mcpServers: { ...RECIPE('').mcpServers, extra: { command: '/x/extra', env: { AGENT_TIMEZONE: '${LONELY_SECRET}' } } } },
    });
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).toMatch(/\n {2}LONELY_SECRET is in setup's list of stored secrets, and doctor finds no server given it/);
    expect(r.out).not.toMatch(/✗ LONELY_SECRET is in setup's list/);
    expect(r.out).not.toMatch(/LONELY_SECRET reaches/);
  });

  test('a stored secret the recipe names outside its servers, as modules.webui\'s basic auth does, is in use, and doctor says where: as a reference with a default, inside a longer value and in a list too, but not under a key the host doesn\'t read', async () => {
    const at = install({
      stored: ['DISCORD_TOKEN', 'SESSION_SERVER_TOKEN', 'WEBUI_USER', 'WEBUI_PASS', 'WEBUI_ORIGIN', 'WEBUI_TYPO'],
      env: { WEBUI_USER: 'web-user-value', WEBUI_PASS: 'web-pass-value', WEBUI_ORIGIN: 'web-origin-value', WEBUI_TYPO: 'web-typo-value' },
      recipe: {
        ...RECIPE(''),
        modules: {
          webui: {
            host: '127.0.0.1',
            basicAuth: { username: '${WEBUI_USER}', password: 'p-${WEBUI_PASS:-unset}' },
            allowedOrigins: ['https://admin.example', 'https://${WEBUI_ORIGIN}.example'],
          },
          webiu: { basicAuth: { username: '${WEBUI_TYPO}' } },
        },
      },
    });
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).toContain('✓ WEBUI_USER is named in the recipe, at modules.webui.basicAuth.username.');
    expect(r.out).toContain('✓ WEBUI_PASS is named in the recipe, at modules.webui.basicAuth.password.');
    expect(r.out).toContain('✓ WEBUI_ORIGIN is named in the recipe, at modules.webui.allowedOrigins[1].');
    expect(r.out).not.toMatch(/✗ WEBUI_(USER|PASS|ORIGIN)/);
    expect(r.out).toMatch(/keys the host does not read \(ignored\): modules\.webiu/);
    expect(r.out).toMatch(/\n {2}WEBUI_TYPO is in setup's list of stored secrets, and doctor finds no server given it: .*, and the recipe names it nowhere outside its servers\./);
    for (const value of ['web-user-value', 'web-pass-value', 'web-origin-value', 'web-typo-value']) expect(r.out + r.err).not.toContain(value);
  });

  test('a stored value reaches a server the host starts when its env or args hold it, inside a longer value too, and one it dials when its configured token or url holds it', async () => {
    const cases: Array<[string, Record<string, unknown>, boolean]> = [
      ['inside a longer env value', { command: '/x/extra', env: { AUTH: 'Bearer ${LONELY_SECRET}' } }, true],
      ['in its args', { command: '/x/extra', args: ['--token', '${LONELY_SECRET}'] }, true],
      ['in the url of a dialled server with no token', { url: 'wss://mcpl.example.test/ws?key=${LONELY_SECRET}' }, true],
      ['in the url\'s path beside a token', { url: 'wss://mcpl.example.test/s/${LONELY_SECRET}/ws', token: 'other' }, true],
      ['in the url\'s token parameter, beside a token of its own', { url: 'wss://mcpl.example.test/ws?token=${LONELY_SECRET}', token: 'other' }, true],
      ['as its access, an audience', { url: 'wss://mcpl.example.test/ws', access: '${LONELY_SECRET}' }, false],
    ];
    const got: Array<[string, boolean]> = [];
    for (const [what, extra] of cases) {
      const at = install({
        stored: ['DISCORD_TOKEN', 'SESSION_SERVER_TOKEN', 'LONELY_SECRET'],
        recipe: { ...RECIPE(''), mcpServers: { ...RECIPE('').mcpServers, extra } },
      });
      const r = await withHost(at, HEALTHY_HOST, () => run(at));
      expect(r.out).toMatch(/(✓ LONELY_SECRET reaches extra\.|\n {2}LONELY_SECRET is in setup's list of stored secrets, and doctor finds no server given it)/);
      got.push([what, /✓ LONELY_SECRET reaches extra\./.test(r.out)]);
    }
    expect(got).toEqual(cases.map(([what, , reaches]) => [what, reaches]));
  });

  test('a stored secret reaches a server the host dials when its token carries it', async () => {
    const at = install({
      stored: ['DISCORD_TOKEN', 'SESSION_SERVER_TOKEN', 'LONELY_SECRET'],
      recipe: { ...RECIPE(''), mcpServers: { ...RECIPE('').mcpServers, remote: { url: 'wss://mcpl.example.test/ws', token: '${LONELY_SECRET}' } } },
    });
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).toMatch(/✓ LONELY_SECRET reaches remote\./);
  });

  test('a stored secret .env writes empty is a problem, and reaches no server, a provider\'s credential included when the recipe doesn\'t load', async () => {
    const at = install({
      stored: ['DISCORD_TOKEN', 'SESSION_SERVER_TOKEN', 'LONELY_SECRET'],
      env: { LONELY_SECRET: '' },
      recipe: { ...RECIPE(''), mcpServers: { ...RECIPE('').mcpServers, extra: { command: '/x/extra', env: { BLANK: '' } } } },
    });
    const r0 = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r0.out).toMatch(/✗ LONELY_SECRET is in setup's list of stored secrets and is empty in the service's environment: give it its value in .*\.env and restart the service\./);
    expect(r0.out).not.toMatch(/LONELY_SECRET reaches/);
    expect(r0.status).toBe(1);
    const provider = install({ stored: ['ANTHROPIC_API_KEY'], env: { ANTHROPIC_API_KEY: '' } });
    writeFileSync(join(provider.work, 'recipe.json'), '{ not json');
    const r = await withHost(provider, HEALTHY_HOST, () => run(provider));
    expect(r.out).toMatch(/✗ .*recipe\.json doesn't load/);
    expect(r.out).toMatch(/✗ ANTHROPIC_API_KEY is in setup's list of stored secrets and is empty in the service's environment/);
  });

  test('each Discord server the recipe runs is checked with its own token, one named only in its args included', async () => {
    const at = install({
      env: { OTHER_TOKEN },
      recipe: {
        ...RECIPE(''),
        mcpServers: {
          ...RECIPE('').mcpServers,
          second: { command: 'node', args: ['/x/node_modules/discord-mcpl/dist/index.js'], env: { DISCORD_TOKEN: '${OTHER_TOKEN}', DISCORD_GUILD_ID: '100' } },
        },
      },
    });
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).toContain('ember (900)');
    expect(r.out).toContain('second (901)');
  });

  test('a recipe that names the install root, which the install\'s entry point gives the host, loads', async () => {
    const at = install({ recipe: { name: 'Ember', agent: { name: 'ember', model: 'claude-test-model', systemPrompt: 'installed at ${CONNECTOME_INSTALL_ROOT}' } } });
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).toMatch(/✓ .*recipe\.json loads\./);
  });

  test('an empty compressionModel in the recipe is a problem with no host to ask, and counted once with one', async () => {
    const recipe = { name: 'Ember', agent: { name: 'ember', model: 'claude-test-model', systemPrompt: 'hi', strategy: { compressionModel: '' } } };
    const alone = install({ recipe });
    const r = await run(alone);
    expect(r.out).toMatch(/✗ The recipe's agent\.strategy\.compressionModel is empty.*, and restart the service\./);

    const asked = install({ recipe });
    const r2 = await withHost(asked, { ...HEALTHY_HOST, 'count-check': { ...COUNTED, compression: { model: '', countModel: null, source: 'count_tokens_unsupported_model' } } }, () => run(asked));
    expect(r2.out.match(/compressionModel is empty/g)).toHaveLength(1);
  });

  test('a server env value that isn\'t a string counts as its string form', async () => {
    const at = install({
      stored: ['DISCORD_TOKEN', 'SESSION_SERVER_TOKEN', 'PORT_SECRET'],
      env: { PORT_SECRET: '48211' },
      recipe: { ...RECIPE(''), mcpServers: { ...RECIPE('').mcpServers, extra: { command: '/x/extra', env: { PORT_SECRET: 48211 } } } },
    });
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).toMatch(/✓.*PORT_SECRET reaches extra/);
  });

  test('a stored secret no file Bun reads for the service gives is a problem whether or not the recipe loads, a provider\'s credential included', async () => {
    const at = install({
      stored: ['ANTHROPIC_API_KEY', 'LONELY_SECRET'],
      drop: ['ANTHROPIC_API_KEY', 'LONELY_SECRET'],
      recipe: { name: 'Ember', agent: { name: 'ember', systemPrompt: '${NOT_IN_ENV}' } },
    });
    const r = await run(at);
    expect(r.out).toMatch(/✗ ANTHROPIC_API_KEY is in setup's list of stored secrets \(.*\), and no file Bun reads for the service gives it a value, .*\.env included/);
    expect(r.out).toMatch(/✗ LONELY_SECRET is in setup's list of stored secrets \(.*stored-secrets\.json\), and no file Bun reads for the service gives it a value, .*\.env included: put it in .*\.env and restart the service, or, if it isn't a secret, take it out of that list\./);
    expect(r.status).toBe(1);

    const loads = install({ stored: ['DISCORD_TOKEN', 'SESSION_SERVER_TOKEN', 'LONELY_SECRET'], drop: ['LONELY_SECRET'] });
    const r2 = await withHost(loads, HEALTHY_HOST, () => run(loads));
    expect(r2.out).toMatch(/✓ .*recipe\.json loads\./);
    expect(r2.out).toMatch(/✗ LONELY_SECRET is in setup's list of stored secrets \(.*\), and no file Bun reads for the service gives it a value, .*\.env included/);

    const outside = install({ stored: ['DISCORD_TOKEN', 'SESSION_SERVER_TOKEN', 'LONELY_SECRET'], drop: ['LONELY_SECRET'] });
    writeFileSync(join(outside.work, '.env.local'), `LONELY_SECRET=${SECRETS.LONELY_SECRET}\n`);
    const r3 = await withHost(outside, HEALTHY_HOST, () => run(outside));
    expect(r3.out).not.toMatch(/✗ LONELY_SECRET is in setup's list of stored secrets \(/);
    expect(r3.out).toMatch(/\n {2}LONELY_SECRET is in setup's list of stored secrets, and doctor finds no server given it/);
    expectNoSecret(r3.out + r3.err);
  });

  test('a server list that doesn\'t resolve is a problem, and the checks that need it say they weren\'t made', async () => {
    const at = install({ stored: ['DISCORD_TOKEN', 'SESSION_SERVER_TOKEN', 'LONELY_SECRET'] });
    writeFileSync(join(at.work, 'mcpl-servers.json'), '{ not json');
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).toMatch(/✗ The recipe's server list doesn't resolve/);
    expect(r.out).toContain('Which servers see DISCORD_TOKEN, SESSION_SERVER_TOKEN, LONELY_SECRET isn\'t checked: the recipe\'s server list doesn\'t resolve.');
    expect(r.out).not.toMatch(/✗.*LONELY_SECRET/);
    expect(r.out).not.toContain('The recipe has no Discord server');
    expect(r.out).toMatch(/Discord isn't checked/);
  });

  test('with no service installed it says so, and the checks that need its recipe or its unit say why they didn\'t run', async () => {
    const at = install();
    rmSync(at.unit);
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).toContain(`✗ No service is installed for this install: ${at.unit} isn't there. ` +
      `\`${join(at.root, 'connectome')} service install <recipe>\` writes one and checks it.`);
    expect(r.out).toContain('Which recipe the service runs is in its unit, so it isn\'t checked without one.');
    expect(r.out).toContain('The ladder reads the service\'s unit and log, so it runs once a service is installed.');
    expect(r.out).not.toContain('ladder args');
    expect(r.out).not.toContain('ember (900)');
    expect(r.status).toBe(1);
    const nowhere = await withHost(at, HEALTHY_HOST, () => run(at, { platform: 'win32' }));
    expect(nowhere.out).toContain(`✗ No service is installed for this install: \`${join(at.root, 'connectome')} service install\` ` +
      'writes one only on Linux and macOS, for a directory whose name has a letter or digit.');
    rmSync(dirname(at.unit), { recursive: true });
    writeFileSync(dirname(at.unit), '');
    const through = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(through.out).toContain(`✗ No service is installed for this install: ${at.unit} isn't there. `);
    expect(through.out).not.toContain(`${at.unit}, connectome-test.service's unit file, can't be read`);
  });

  test('a unit file install couldn\'t have written, or one that can\'t be read, is a problem naming how to write it anew, and the ladder says why it didn\'t run', async () => {
    const at = install();
    writeFileSync(at.unit, '[Service]\nWorkingDirectory=/x\nExecStart=bun start.js recipe.json\n');
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).toContain(`✗ ${at.unit} isn't the unit file service install writes: `);
    expect(r.out).toContain(`\`${join(at.root, 'connectome')} service install <recipe>\` writes it anew, or says why it can't.`);
    expect(r.out).not.toContain('ladder args');
    const ladder = 'The ladder reads the service\'s unit, so it doesn\'t run while doctor can\'t use that unit.';
    expect(r.out).toContain(ladder);
    expect(r.out).toMatch(/Discord isn't checked: .*the service's unit names, and doctor can't use that unit/);
    expect(r.out).not.toContain('that unit can\'t be read');
    expect(r.status).toBe(1);
    writeUnit(at, join(at.work, 'recipe.json'));
    writeFileSync(at.unit, readFileSync(at.unit, 'utf-8').replace(/"[^"]*start\.js" /, ''));
    const other = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(other.out).toContain(`✗ ${at.unit} doesn't run start.js with a recipe after it, as the one service install writes does.`);
    expect(other.out).not.toContain('ladder args');
    expect(other.out).toContain(ladder);
    rmSync(at.unit);
    mkdirSync(at.unit);
    const unread = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(unread.out).toContain(`✗ ${at.unit}, connectome-test.service's unit file, can't be read: `);
    expect(unread.out).not.toContain('No service is installed');
    expect(unread.out).toContain(ladder);
    expect(unread.status).toBe(1);
  });

  test('a unit that runs in another directory than this install\'s, as another install\'s of the same directory name does, is a problem, and doctor reads nothing there', async () => {
    const at = install();
    const other = install();
    writeUnit(at, join(other.work, 'recipe.json'), other.work);
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).toContain(`✗ ${at.unit} names ${other.work} as the directory it runs in, not this install's, ${at.work}: ` +
      'it\'s another install\'s, or this one\'s from before it moved, and doctor reads nothing there.');
    expect(r.out).not.toContain(join(other.work, 'recipe.json'));
    expect(r.status).toBe(1);
  });

  test('a stored secret only the unit sets is withheld where doctor can\'t use the unit, as systemd still gives its environment', async () => {
    const value = 'unit-only-secret-value';
    const at = install({ prefix: `chost-${value}-`, stored: ['DISCORD_TOKEN', 'SESSION_SERVER_TOKEN', 'UNIT_ONLY'] });
    writeFileSync(at.unit, '[Service]\nWorkingDirectory=/x\nExecStart=bun start.js recipe.json\n');
    const manager = fakeManager(at.work, {
      unit: [...Object.entries(unitEnvironment(at)).map(([name, v]) => `${name}=${v}`), `UNIT_ONLY=${value}`].join(' '),
    });
    const r = await withHost(at, HEALTHY_HOST, () => run(at, { systemctl: manager.path }));
    expect(r.out).toContain('isn\'t the unit file service install writes');
    expect(r.out).toMatch(/^connectome doctor: the install at .*<UNIT_ONLY>/);
    expect(r.out).not.toContain(value);
  });

  test('the service\'s environment is read with the Bun its unit runs, and one that can\'t be run is named', async () => {
    const at = install();
    const ran = join(at.work, 'unit-bun-ran');
    const bun = join(at.work, 'unit-bun');
    writeFileSync(bun, `#!/bin/sh\necho ran >> '${ran}'\nexec '${process.execPath}' "$@"\n`);
    chmodSync(bun, 0o755);
    writeUnit(at, join(at.work, 'recipe.json'), at.work, bun);
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(existsSync(ran)).toBe(true);
    expect(r.out).not.toContain('Doctor stops here');
    const missing = join(at.work, 'no-such-bun');
    writeUnit(at, join(at.work, 'recipe.json'), at.work, missing);
    const gone = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(gone.out).toContain(`✗ ${missing}, the Bun the service's unit runs, couldn't be run in ${at.work} to read the ` +
      'service\'s environment: ');
    expect(gone.out).toContain('Doctor stops here');
    expect(gone.status).toBe(1);
  });

  test('a stored secret the unit sets is withheld from the stop a later step of reading the service\'s environment makes', async () => {
    const value = 'unit-set-secret-value';
    for (const fails of ['files', 'bun'] as const) {
      const at = install({ prefix: `chost-${value}-`, stored: ['DISCORD_TOKEN', 'SESSION_SERVER_TOKEN', 'UNIT_SET'] });
      const manager = fakeManager(at.work, {
        unit: [...Object.entries(unitEnvironment(at)).map(([name, v]) => `${name}=${v}`), `UNIT_SET=${value}`].join(' '),
        ...(fails === 'files' ? { filesFail: 'Failed to get properties: Access denied' } : {}),
      });
      if (fails === 'bun') {
        writeFileSync(join(at.work, 'bunfig.toml'), 'preload = ["./pre.ts"]\n');
        writeFileSync(join(at.work, 'pre.ts'), 'throw new Error("refused");\n');
      }
      const r = await withHost(at, HEALTHY_HOST, () => run(at, { systemctl: manager.path }));
      expect(r.out).toContain('Doctor stops here');
      expect(r.out).toMatch(/^connectome doctor: the install at .*<UNIT_SET>/);
      expect(r.out).not.toContain(value);
    }
  });

  test('whether the service check expects a shell comes from the recipe the unit runs', async () => {
    for (const [recipe, shell] of [[RECIPE(''), true], [{ ...RECIPE(''), mcpServers: { discord: RECIPE('').mcpServers.discord } }, false]] as const) {
      const at = install({ recipe });
      let asked: unknown[] = [];
      await run(at, {
        checkService: async (...args: unknown[]) => {
          asked = args;
          return { passed: true, lines: [] };
        },
      });
      expect([shell, asked[2]]).toEqual([shell, shell]);
    }
    const unread = install();
    rmSync(join(unread.work, 'recipe.json'));
    let given: unknown[] = [];
    await run(unread, {
      checkService: async (...args: unknown[]) => {
        given = args;
        return { passed: true, lines: [] };
      },
    });
    expect(given[2]).toBeNull();
  });

  test('a service check that doesn\'t pass is a problem, and one that throws is a problem too, with the checks after it made', async () => {
    const at = install();
    const failing = await withHost(at, HEALTHY_HOST, () => run(at, { checkService: async () => ({ passed: false, lines: ['The unit is failed.'] }) }));
    expect(failing.out).toMatch(/✗ The service check above didn't pass/);
    expect(failing.status).toBe(1);
    const throwing = await withHost(at, HEALTHY_HOST, () => run(at, { checkService: async () => { throw new Error('systemctl vanished'); } }));
    expect(throwing.out).toMatch(/✗.*systemctl vanished/);
    expect(throwing.out).toContain('ember (900)');
    expect(throwing.out).toContain('ladder args');
    expect(throwing.status).toBe(1);
  });

  test('with no host answering it says why and how to start it, says what needs the host, still checks the rest, and lets the ladder judge the signal', async () => {
    const at = install();
    const r = await run(at);
    expect(r.out).toMatch(/✗.*host/i);
    expect(r.out).toContain('start it: ');
    expect(r.out).toContain('follow its log: journalctl --user -u connectome-test.service -f');
    expect(r.out).toContain('ember (900)');
    expect(r.out).toMatch(/needs? the host/);
    expect(r.out).toContain(`ladder args: --findings-json --data-dir ${at.data} ${at.work} connectome-test.service`);
    expectNoSecret(r.out + r.err);
    expect(r.status).toBe(1);
  });

  test('the shell\'s failure and a server not connected are each a problem in words, and the counts\' failures are lines in words', async () => {
    const at = install();
    const r = await withHost(at, {
      'shell-check': {
        shells: [
          { server: 'shell', answered: false, error: 'Connection lost' },
          { server: 'shell2', answered: false, error: 'Tool call denied by the allowlist' },
          { server: 'shell3', answered: false, error: 'Connection timeout' },
        ],
        notConnected: [
          { id: 'discord', retrying: true, refused: null },
          { id: 'old', retrying: false, refused: 'its command is empty' },
          { id: 'dying', retrying: false, refused: null },
        ],
        closedTabs: [],
      },
      'count-check': { beside: STANDIN_BESIDE,
        agent: { model: 'claude-small-window', countModel: 'claude-small-window', source: 'count_tokens_failed_404' },
        compression: { model: 'claude-old', countModel: 'claude-old', source: 'count_tokens_failed_404' },
      },
    }, () => run(at));
    expect(r.out).toMatch(/✗.*shell.*Connection lost.*SESSION_SERVER_TOKEN/);
    expect(r.out).toMatch(/✗.*shell2.*Tool call denied by the allowlist\.$/m);
    expect(r.out).toMatch(/✗ shell3 didn't reach its daemon: Connection timeout\..*"Connection timeout" a daemon that isn't running/);
    expect(r.out).toMatch(/✗.*discord isn't connected.*still retrying/);
    expect(r.out).toMatch(/✗.*old isn't connected.*its command is empty/);
    expect(r.out).toMatch(/✗ The server dying isn't connected, and the host isn't retrying it\. Its stderr is in the data directory/);
    expect(r.out).toMatch(/\n {2}count_tokens couldn't count with claude-small-window: .*\. So the context's makeup shows no exact total\. A retired model answers 404, and the endpoint count_tokens asks \(Anthropic's API, or the one ANTHROPIC_BASE_URL names\) may answer it for a model it doesn't serve: set COUNT_TOKENS_MODEL in .*\.env to a current Claude model, and restart the service, since the host reads it when it starts\./);
    expect(r.out).toMatch(/\n {2}count_tokens couldn't count with the compression model, claude-old.*folding stalls.*: change the recipe's agent\.strategy\.compressionModel to a current model and restart the service\. The endpoint count_tokens asks \(Anthropic's API, or the one ANTHROPIC_BASE_URL names\) may answer 404 for a model it doesn't serve too, and then the 404 doesn't mean it's retired\./);
    expect(r.out).not.toContain('only a gateway serves');
    expect(r.status).toBe(1);
  });

  test('a 404 for the compression model offers leaving it out only when the agent\'s own model counts and isn\'t the compression model', async () => {
    const cases: Array<[string, Record<string, unknown>, boolean]> = [
      ['the agent\'s model counts', { model: 'claude-live', countModel: 'claude-live', source: 'count_tokens' }, true],
      ['the agent\'s model answers 404 too', { model: 'claude-other-old', countModel: 'claude-other-old', source: 'count_tokens_failed_404' }, false],
      ['it is the agent\'s model', { model: 'claude-old', countModel: 'claude-old', source: 'count_tokens_failed_404' }, false],
      ['COUNT_TOKENS_MODEL\'s model counts, not the agent\'s', { model: 'claude-live', countModel: 'claude-override', source: 'count_tokens' }, false],
    ];
    const got: Array<[string, boolean]> = [];
    for (const [what, agent] of cases) {
      const at = install();
      const r = await withHost(at, {
        ...HEALTHY_HOST,
        'count-check': { beside: STANDIN_BESIDE, agent, compression: { model: 'claude-old', countModel: 'claude-old', source: 'count_tokens_failed_404' } },
      }, () => run(at));
      expect(r.out).toMatch(/\n {2}count_tokens couldn't count with the compression model, claude-old: .*: change the recipe's agent\.strategy\.compressionModel to a current model.* and restart the service\./);
      got.push([what, r.out.includes('or leave it out to compress with the agent\'s model,')]);
    }
    expect(got).toEqual(cases.map(([what, , offered]) => [what, offered]));
  });

  test('a count refused for its credential names each the host may send, and an empty compression model is a problem', async () => {
    const at = install();
    const r = await withHost(at, {
      ...HEALTHY_HOST,
      'count-check': { beside: STANDIN_BESIDE,
        agent: { model: 'claude-small-window', countModel: 'claude-small-window', source: 'count_tokens_failed_401' },
        compression: { model: '', countModel: null, source: 'count_tokens_unsupported_model' },
      },
    }, () => run(at));
    expect(r.out).toMatch(/✗.*401.*its subscription login when it has one, else ANTHROPIC_AUTH_TOKEN, else ANTHROPIC_API_KEY\. So the context's makeup shows no exact total\. Replace that credential where the service gets it, and restart the service\./);
    expect(r.out).toMatch(/✗.*compressionModel.*empty/);
    expect(r.status).toBe(1);
  });

  test('a count that fails, or an agent with no model, is said in words', async () => {
    const at = install();
    const r = await withHost(at, {
      ...HEALTHY_HOST,
      'count-check': { beside: STANDIN_BESIDE, agent: { model: 'claude-small-window', countModel: 'claude-small-window', source: 'count_tokens_error' }, compression: null },
    }, () => run(at));
    expect(r.out).toMatch(/\n {2}count_tokens couldn't count with claude-small-window: the count_tokens request failed, or answered with what couldn't be read or with no count\./);

    const none = install();
    const r2 = await withHost(none, {
      ...HEALTHY_HOST,
      'count-check': { beside: STANDIN_BESIDE, agent: { model: null, countModel: null, source: 'count_tokens_unsupported_model' }, compression: null },
    }, () => run(none));
    expect(r2.out).toContain('count_tokens isn\'t asked: the agent names no model.');
    expect(r2.out).not.toContain('null');
  });

  test('a host answer doctor can\'t read is a problem, and the checks after it are still made', async () => {
    const at = install();
    const r = await withHost(at, { 'count-check': null, 'shell-check': {} }, () => run(at));
    expect(r.out).toMatch(/✗ The token counts failed: /);
    expect(r.out).toMatch(/✗ The shell's call failed: /);
    expect(r.out).toContain('ember (900)');
    expect(r.out).toContain('ladder args');
    expect(r.status).toBe(1);
  });

  test('a host that refuses a check is a problem in its words', async () => {
    const at = install();
    const r = await withHost(at, { 'shell-check': HEALTHY_HOST['shell-check'] }, () => run(at));
    expect(r.out).toMatch(/✗.*token counts.*unknown panel op: count-check/);
    expect(r.out).toMatch(new RegExp('The running host is an older release than this command, so it doesn\'t know this check: ' +
      'restarting the service \\(`(XDG_RUNTIME_DIR=\\S+ )?systemctl --user stop connectome-test\\.service`, then ' +
      '`(XDG_RUNTIME_DIR=\\S+ )?systemctl --user start connectome-test\\.service`\\) starts it on this release\\.'));
    expect(r.status).toBe(1);
  });

  test('the fit is checked for the model the service runs, MODEL in .env included', async () => {
    const at = install({
      env: { MODEL: 'claude-haiku-4-5' },
      recipe: { name: 'Ember', agent: { name: 'ember', model: 'claude-other', contextBudgetTokens: 250_000, systemPrompt: 'hi' } },
    });
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).toMatch(/✗.*claude-haiku-4-5/);
    expect(r.status).toBe(1);
  });

  test('the service\'s environment is Bun\'s: a value Bun reads from .env.local counts, and what the unit sets wins over .env', async () => {
    const local = install({
      recipe: { name: 'Ember', agent: { name: 'ember', model: 'claude-other', contextBudgetTokens: 250_000, systemPrompt: 'hi' } },
    });
    writeFileSync(join(local.work, '.env.local'), 'MODEL=claude-haiku-4-5\n');
    const r = await withHost(local, HEALTHY_HOST, () => run(local));
    expect(r.out).toMatch(/✗.*claude-haiku-4-5/);

    const supervised = install({
      env: { CONNECTOME_SUPERVISED: '0' },
      recipe: { name: 'Ember', agent: { name: 'ember', model: 'claude-test-${CONNECTOME_SUPERVISED}', systemPrompt: 'hi' } },
    });
    const r2 = await withHost(supervised, HEALTHY_HOST, () => run(supervised));
    expect(r2.out).toContain('claude-test-1');
    expect(r2.out).not.toContain('claude-test-0');
  });

  test('the service\'s DATA_DIR is the install\'s data directory, as service install\'s unit sets it, over .env\'s', async () => {
    const at = install({
      env: { DATA_DIR: '/elsewhere' },
      recipe: { name: 'Ember', agent: { name: 'ember', model: 'claude-test-${DATA_DIR}', systemPrompt: 'hi' } },
    });
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).not.toContain('which is not set');
    expect(r.out).toContain(`claude-test-${at.data}`);
    expect(r.out).not.toContain('claude-test-/elsewhere');
  });

  test('a system prompt the recipe gives by URL is fetched, as the host fetches it, and counts in the fit', async () => {
    const prompt = Bun.serve({ port: 0, fetch: () => new Response('word '.repeat(240_000)) });
    const at = install({
      recipe: { name: 'Ember', agent: { name: 'ember', model: 'claude-haiku-4-5', systemPrompt: `http://127.0.0.1:${prompt.port}/prompt.txt` } },
    });
    try {
      const r = await withHost(at, HEALTHY_HOST, () => run(at));
      expect(r.out).toMatch(/✗.*systemPrompt is about [\d,]+ tokens/);
      expect(r.status).toBe(1);
    } finally {
      prompt.stop(true);
    }
  });

  test('with what the host sends beside the conversation counted, the fit says what\'s spare, and a count past the window\'s room is a problem with the numbers', async () => {
    const at = install();
    writeFileSync(join(at.work, 'recipe.json'), JSON.stringify({
      ...RECIPE(at.work), agent: { name: 'ember', model: 'claude-haiku-4-5', systemPrompt: '' },
    }));
    const recipeDigest = await digestOf(at);
    const counted = (tokens: number) => ({ ...HEALTHY_HOST, 'count-check': {
      ...COUNTED, agent: { ...COUNTED.agent, model: 'claude-haiku-4-5' }, beside: { tokens, source: 'count_tokens' }, budget: 168_000,
      recipeDigest,
    } });
    const fits = await withHost(at, counted(20_000), () => run(at));
    expect(fits.out).toContain('✓ It fits claude-haiku-4-5\'s window, with about 28,384 tokens left for the reply and for what ' +
      'modules add at each turn, by context-manager\'s estimate of the conversation: the system prompt and tools the host sends ' +
      'count 20,000.');
    expect(fits.out).not.toContain('a reply that long');
    expect(fits.out).toMatch(/Doctor found no problem\.$/);
    expect(fits.status).toBe(0);
    const tight = await withHost(at, counted(40_000), () => run(at));
    expect(tight.out).toContain('with about 8,384 tokens left for the reply');
    expect(tight.out).toContain('That\'s less than the 16,384 tokens agent.maxTokens lets a reply take, so a reply that long ' +
      'wouldn\'t fit in what\'s left, by this estimate.');
    expect(tight.status).toBe(0);
    const over = await withHost(at, counted(48_385), () => run(at));
    expect(over.out).toContain('✗ The budget the host gives this recipe, 168,000, lets a turn\'s prompt reach 200,001 tokens');
    expect(over.out).toContain('the system prompt and tools the host sends, counted at 48,385, come on top.');
    expect(over.out).toContain('bring the system prompt and tools the host sends to about 48,384 tokens or fewer');
    expect(over.out).toContain('Doctor found 1 problem, marked ✗.');
    expect(over.status).toBe(1);
  });

  test('with what the host sends beside the conversation not counted, the fit is the load\'s, by estimate, and says why', async () => {
    const at = install();
    writeFileSync(join(at.work, 'recipe.json'), JSON.stringify({
      ...RECIPE(at.work), agent: { name: 'ember', model: 'claude-haiku-4-5', systemPrompt: '' },
    }));
    const uncounted = async (answer: Record<string, unknown> | null, why: string) => {
      const r = answer === null ? await run(at)
        : await withHost(at, { ...HEALTHY_HOST, 'count-check': answer }, () => run(at));
      expect([why, r.out]).toEqual([why, expect.stringContaining('✓ It fits claude-haiku-4-5\'s window.\n  The system prompt and ' +
        `tools the host sends weren't counted (${why}), so this is the check the host makes at load, by estimate.`)]);
    };
    const older = await withHost(at, { 'shell-check': HEALTHY_HOST['shell-check'] }, () => run(at));
    expect(older.out).toContain('The system prompt and tools the host sends weren\'t counted (the running host is an older ' +
      'release than this command, so it doesn\'t count them), so this is the check the host makes at load, by estimate.');
    await uncounted({ ...COUNTED, beside: { tokens: null, source: 'session_switched' } },
      'the host was switching sessions while it counted, or had switched since, so which session its count is of can\'t be told');
    await uncounted({ ...COUNTED, beside: { tokens: null, source: 'count_tokens_no_credential' } },
      'count_tokens had no Anthropic credential to send');
    await uncounted({ ...COUNTED, beside: { tokens: null, source: 'preview_failed', error: 'the agent is mid-switch' } },
      'the request a turn sends couldn\'t be built: the agent is mid-switch');
    await uncounted(null, 'no host answers');
    await uncounted({ ...COUNTED, beside: { tokens: 20_000, source: 'count_tokens' }, budget: 168_000 },
      'the running host runs claude-small-window, not claude-haiku-4-5, so its count isn\'t of this recipe as it runs');
    await uncounted({ ...COUNTED, agent: { ...COUNTED.agent, model: 'claude-haiku-4-5' }, beside: { tokens: 20_000, source: 'count_tokens' },
      budget: 150_000 }, 'the running host\'s budget is 150,000, not the 168,000 this recipe gives it, as agent settings or a change ' +
      'since its start can leave it');
  });

  test('the fit is judged in the service\'s environment: a MODEL only the shell running doctor has doesn\'t count', async () => {
    const at = install({
      recipe: { name: 'Ember', agent: { name: 'ember', model: 'claude-opus-4-8', contextBudgetTokens: 250_000, systemPrompt: 'hi' } },
    });
    const shellModel = process.env.MODEL;
    process.env.MODEL = 'claude-haiku-4-5';
    try {
      const r = await withHost(at, HEALTHY_HOST, () => run(at));
      expect(r.out).toMatch(/✓.*fits claude-opus-4-8/);
      expect(r.out).not.toContain('claude-haiku-4-5');
    } finally {
      if (shellModel === undefined) delete process.env.MODEL;
      else process.env.MODEL = shellModel;
    }
  });

  test('a .env outside setup\'s form stops doctor at its start, naming the line and printing none of it, nor any check\'s output, and exits 1', async () => {
    const at = install({ env: { ODD: 'claude-${SIZE}' } });
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    const lines = r.out.trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(`connectome doctor: the install at ${at.root}`);
    expect(lines[1]).toStartWith(`  ✗ ${join(at.work, '.env')}, line ${Object.keys(SECRETS).length + 1}, `);
    expect(lines[2]).toStartWith('Doctor stops here');
    expect(r.out).not.toContain('claude-${SIZE}');
    expectNoSecret(r.out + r.err);
    expect(r.status).toBe(1);
  });

  test('when it stops at its start, the values doctor\'s own environment holds are withheld from what it prints', async () => {
    const at = install({ prefix: 'chost-doctor-own-dtok-own-akey-', env: { ODD: 'claude-${SIZE}' } });
    const before = { DISCORD_TOKEN: process.env.DISCORD_TOKEN, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
    process.env.DISCORD_TOKEN = 'own-dtok';
    process.env.ANTHROPIC_API_KEY = 'own-akey';
    try {
      const r = await withHost(at, HEALTHY_HOST, () => run(at));
      expect(r.out).toContain('Doctor stops here');
      expect(r.out).toContain('chost-doctor-<DISCORD_TOKEN>-<ANTHROPIC_API_KEY>-');
      expect(r.out).not.toContain('own-dtok');
      expect(r.out).not.toContain('own-akey');
      process.env.ANTHROPIC_API_KEY = 'stops';
      const worded = await withHost(at, HEALTHY_HOST, () => run(at));
      expect(worded.out).toContain('Doctor <ANTHROPIC_API_KEY> here: it can');
      expect(worded.out).not.toContain('stops');
    } finally {
      for (const [name, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test('when the stored secrets\' list or .env can\'t be read, it names the file and stops, printing no check\'s output, and exits 1', async () => {
    const list = install();
    writeFileSync(join(list.work, '.setup', 'stored-secrets.json'), '{"DISCORD_TOKEN": true}');
    const dotEnv = install();
    rmSync(join(dotEnv.work, '.env'));
    mkdirSync(join(dotEnv.work, '.env'));
    for (const [at, file] of [[dotEnv, /\.env/], [list, /stored-secrets\.json/]] as const) {
      const r = await withHost(at, HEALTHY_HOST, () => run(at));
      expect(r.out).toMatch(new RegExp(`✗.*${file.source}`));
      expect(r.out).toContain('Doctor stops here');
      const after = r.out.slice(r.out.indexOf('Doctor stops here'));
      expect(after.split('\n').length).toBe(1);
      expect(r.out).not.toMatch(/^(Service|Host|Recipe)$/m);
      expect(r.out).not.toContain('ladder args');
      expectNoSecret(r.out + r.err);
      expect(r.status).toBe(1);
    }
  });

  test('a host that never answers a check is a problem, and doctor still finishes', async () => {
    const at = install();
    const r = await withHost(at, SILENT, async (host) => ({ ...(await run(at, { hostLimitMs: 300 })), received: host.received }));
    expect(r.received).toEqual(['count-check', 'health', 'shell-check']);
    expect(r.out).toMatch(/✗.*didn't answer the token counts within 0\.3 s/);
    expect(r.out).toMatch(/✗.*didn't answer the counts of its model calls within 0\.3 s/);
    expect(r.out).toMatch(/✗.*didn't answer the shell's call/);
    expect(r.out).toContain('ember (900)');
    expect(r.status).toBe(1);
  });

  test('the recipe\'s agent\'s failed turns are a problem with when and how many, never with the failure\'s text; its refusals are a line with how many, since when, the last one\'s time and category; and a refusal in its newest turn is a line', async () => {
    const at = install();
    const failedAt = STARTED + 60_000;
    const lastAt = STARTED + 50_000;
    const health = { ...HEALTH, agents: [{
      ...HEALTH.agents[0], consecutiveInferenceFailures: 2,
      lastInference: { startedAt: STARTED + 40_000, endedAt: STARTED + 41_000, failedAt, lastError: 'provider said: overloaded_error id req_0451' },
      refusalStats: { total: 3, byCategory: { cyber: 3 }, lastAt, lastCategory: 'cyber' },
    }] };
    const r = await withHost(at, { ...HEALTHY_HOST, health }, () => run(at));
    const lines = r.out.split('\n');
    const from = lines.indexOf('Model calls');
    expect(from).toBeGreaterThan(lines.indexOf('Token counts'));
    expect(lines.slice(from + 1, from + 4)).toEqual([
      `  ✗ ember's last turn's model call failed at ${new Date(failedAt).toISOString()}, 2 in a row. Each failure's reason is in ` +
        'a line of the host\'s stderr that starts `[inference-failed] agent=ember`. The service keeps its host\'s stderr in its ' +
        'log: `journalctl --user -u connectome-test.service -f` follows it.',
      `  ember was refused 3 times since this host started or last switched session, the last at ${new Date(lastAt).toISOString()}, in the category cyber.`,
      '  ember\'s newest turn met a refusal, and the host\'s counts don\'t show whether a retry in that turn then answered.',
    ]);
    expect(r.out).not.toContain('overloaded_error');
    expect(r.status).toBe(1);
  });

  test('refusals are never a problem: a resident refused on every turn shows them and no problem for them, and a category that isn\'t one short word isn\'t printed', async () => {
    const at = install();
    const lastAt = STARTED + 30_000;
    const health = { ...HEALTH, agents: [{
      ...HEALTH.agents[0], lastInference: { startedAt: STARTED + 29_000, endedAt: STARTED + 31_000 },
      refusalStats: { total: 1, byCategory: { 'see https://example.com': 1 }, lastAt, lastCategory: 'see https://example.com' },
    }] };
    const r = await withHost(at, { ...HEALTHY_HOST, health }, () => run(at));
    expect(r.out).toContain('  ✓ ember: no failed turns in a row, by the host\'s counts.');
    expect(r.out).toContain(`  ember was refused 1 time since this host started or last switched session, the last at ${new Date(lastAt).toISOString()}, in a category the provider gave in other words.`);
    expect(r.out).toContain('ember\'s newest turn met a refusal');
    expect(r.out).not.toContain('example.com');
    expect(r.status).toBe(0);
  });

  test('a refusal before the newest turn began isn\'t said of the newest turn, the framework\'s unknown is said as no category, and with none there is no refusals line', async () => {
    const at = install();
    const earlier = { ...HEALTH, agents: [{
      ...HEALTH.agents[0], lastInference: { startedAt: STARTED + 10_000, endedAt: STARTED + 12_000 },
      refusalStats: { total: 1, byCategory: { unknown: 1 }, lastAt: STARTED + 9_999, lastCategory: 'unknown' },
    }] };
    const r = await withHost(at, { ...HEALTHY_HOST, health: earlier }, () => run(at));
    expect(r.out).toContain(`ember was refused 1 time since this host started or last switched session, the last at ${new Date(STARTED + 9_999).toISOString()}, with no category given.`);
    expect(r.out).not.toContain('newest turn');
    const clean = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(clean.out).toContain('✓ ember: no failed turns in a row');
    expect(clean.out).not.toContain('was refused');
  });

  test('with no failed turn in a row, the recipe\'s agent\'s line holds whether it has run no turn yet or a turn failed before one completed', async () => {
    const at = install();
    const fresh = await withHost(at, { ...HEALTHY_HOST, health: { ...HEALTH, agents: [{ ...HEALTH.agents[0], lastInference: null }] } }, () => run(at));
    const recovered = await withHost(at, { ...HEALTHY_HOST, health: { ...HEALTH, agents: [{
      ...HEALTH.agents[0], lastInference: { startedAt: STARTED + 20_000, endedAt: STARTED + 21_000, failedAt: STARTED + 10_000 },
    }] } }, () => run(at));
    for (const r of [fresh, recovered]) {
      const lines = r.out.split('\n');
      expect(lines[lines.indexOf('Model calls') + 1]).toBe('  ✓ ember: no failed turns in a row, by the host\'s counts.');
      expect(r.status).toBe(0);
    }
  });

  test('another agent gets lines only with a failed turn or a refusal, and a recipe\'s agent the host doesn\'t list is said, with the closing line saying its model calls weren\'t checked', async () => {
    const at = install();
    const quiet = { name: 'ember-reader', status: 'idle', consecutiveInferenceFailures: 0, lastInference: null, refusalStats: null };
    const failing = { name: 'helper-1', status: 'idle', consecutiveInferenceFailures: 1, lastInference: { startedAt: STARTED, failedAt: STARTED + 5_000 }, refusalStats: null };
    const r = await withHost(at, { ...HEALTHY_HOST, health: { ...HEALTH, agents: [HEALTH.agents[0], quiet, failing] } }, () => run(at));
    expect(r.out).toContain(`✗ helper-1's last turn's model call failed at ${new Date(STARTED + 5_000).toISOString()}, 1 in a row.`);
    expect(r.out).not.toContain('ember-reader');
    const elsewhere = await withHost(at, { ...HEALTHY_HOST, health: { ...HEALTH, agents: [quiet] } }, () => run(at));
    expect(elsewhere.out).toContain('  The host\'s counts list no agent named ember.');
    expect(elsewhere.out).toMatch(/\nDoctor found no problem, though .*ember's model calls weren't checked.*, as said above\.$/);
  });

  test('with no host the counts aren\'t asked, and an answer doctor can\'t read is a problem', async () => {
    const at = install();
    const none = await run(at);
    expect(none.out).toContain('  The host\'s counts of its model calls weren\'t asked: that needs the host running.');
    const odd = await withHost(at, { ...HEALTHY_HOST, health: { agents: 'ember' } }, () => run(at));
    expect(odd.out).toMatch(/✗ The counts of its model calls failed: /);
    expect(odd.out).toContain('ladder args');
  });

  test('a host whose connection closes under a check is a problem, and doctor still finishes', async () => {
    const at = install();
    const r = await withHost(at, HEALTHY_HOST, () => run(at), { closeOnRequest: true });
    expect(r.out).toMatch(/✗.*connection closed first/);
    expect(r.out).toContain('ladder args');
    expect(r.status).toBe(1);
  });

  test('a Discord refusal is a ✗ line of the report and counts toward the exit', async () => {
    const at = install();
    const refusing = (async () => Response.json({ message: '401: Unauthorized', code: 0 }, { status: 401 })) as unknown as typeof fetch;
    const r = await withHost(at, HEALTHY_HOST, () => run(at, { fetch: refusing }));
    expect(r.out).toMatch(/✗ Discord refused the bot token/);
    expect(r.status).toBe(1);
  });

  test('a 401 for a server mcpl-servers.json gives "${DISCORD_TOKEN}" as written says so in its own words', async () => {
    const at = install({ recipe: { ...RECIPE(''), mcpServers: { discord: {}, shell: RECIPE('').mcpServers.shell } } });
    writeFileSync(join(at.work, 'mcpl-servers.json'), JSON.stringify({ mcplServers: { discord: {
      command: 'node', args: ['/x/node_modules/discord-mcpl/dist/index.js'], env: { DISCORD_TOKEN: '${DISCORD_TOKEN}', DISCORD_GUILD_ID: '100' },
    } } }));
    const refusing = (async () => Response.json({ message: '401: Unauthorized', code: 0 }, { status: 401 })) as unknown as typeof fetch;
    const r = await withHost(at, HEALTHY_HOST, () => run(at, { fetch: refusing }));
    expect(r.out).toContain('✗ Discord refused the bot token');
    expect(r.out).not.toContain('"<DISCORD_TOKEN>"');
    expect(r.out).toContain('mcpl-servers.json and the agent overlay take it as written, a "${DISCORD_TOKEN}" included');
  });

  test('a recipe that doesn\'t load is a problem in the loader\'s words', async () => {
    const at = install({ recipe: { name: 'Ember', agent: { name: 'ember', systemPrompt: '${NOT_IN_ENV}' } } });
    const r = await run(at);
    expect(r.out).toMatch(/✗.*doesn't load.*NOT_IN_ENV/);
    expect(r.status).toBe(1);
  });

  test('without python3 it says the ladder needs it, which isn\'t a problem by itself', async () => {
    const at = install();
    const r = await withHost(at, HEALTHY_HOST, () => run(at, { python: null }));
    expect(r.out).toMatch(/ladder needs python3/);
    expect(r.out).toMatch(/Doctor found no problem, though the ladder didn't run and the fit wasn't checked, as said above\.$/);
    expect(r.status).toBe(0);
  });

  test('a ladder that doesn\'t finish within its limit is a problem, and doctor finishes', async () => {
    const at = install();
    const r = await withHost(at, HEALTHY_HOST, () => run(at, { python: fakePython(at.work, { sleep: 5 }), ladderLimitMs: 300 }));
    expect(r.out).toMatch(/✗ The ladder didn't finish within 0\.3 s, so what it would have shown after the lines above isn't known\./);
    expect(r.status).toBe(1);
  });

  test('the ladder runs with XDG_RUNTIME_DIR, the user manager\'s default when doctor\'s shell has none', async () => {
    const at = install();
    const saved = process.env.XDG_RUNTIME_DIR;
    delete process.env.XDG_RUNTIME_DIR;
    try {
      const r = await withHost(at, HEALTHY_HOST, () => run(at));
      expect(r.out).toContain(`ladder XDG_RUNTIME_DIR=/run/user/${process.getuid!()}`);
    } finally {
      if (saved !== undefined) process.env.XDG_RUNTIME_DIR = saved;
    }
  });

  test('a data directory the install record names that isn\'t there is one more problem, with what\'s at stake, wherever the ladder runs or not', async () => {
    const stopped = async () => ({ passed: true, lines: ['connectome-test.service is stopped: systemd shows it inactive (dead).'],
      stopped: true as const });
    const count = (out: string) => Number(/Doctor found (\d+) problems?/.exec(out)?.[1] ?? 0);
    for (const python of [undefined, null]) {
      const at = install();
      const parts = { checkService: stopped, ...(python === null ? { python: null } : { python: fakePython(at.work, { end: 'clean' }) }) };
      const before = await run(at, parts);
      rmSync(at.data, { recursive: true, force: true });
      const r = await run(at, parts);
      expect(r.out).toContain(`✗ The install record names ${at.data} as the resident's data directory, and it isn't there. It ` +
        'holds the resident\'s history and memory, and a host started now would begin on an empty one, so put it back if you ' +
        'have it, or ask for help, before starting the service.');
      expect(count(r.out)).toBe(count(before.out) + 1);
      expect(r.status).toBe(1);
    }
  });

  test('each channel the subscription GC auto-closed is named, its latest close, however much follows and wherever the service runs, and isn\'t a problem', async () => {
    const close = (channelId: string, when: string) => JSON.stringify({ at: when, agent: 'resident', kind: 'subscription-gc-close',
      reason: `subscription-gc auto-closed channel ${channelId} (over 4000 ambient chars since last activation, default budget). ` +
        `Restore: channel_open ${channelId}, or agent_settings channel_idle_limits.`,
      channelId, limitChars: 4000, decisionSource: 'subscription-gc', lease: 'default', restore: `channel_open ${channelId}` });
    const other = JSON.stringify({ at: '2026-11-01T04:40:00.000Z', agent: 'resident', kind: 'refusal', category: 'policy' });
    const named = (channel: string, when: string) => `  Channel ${channel} was auto-closed at ${when}, over 4000 characters of ` +
      'messages that didn\'t mention the resident since it last ran. If it\'s still closed, ask the resident to run its ' +
      `channel_open ${channel} to reopen it; to stop it closing again, ask the resident to raise or turn off that channel's ` +
      'limit with its agent_settings tool (channel_idle_limits).';
    const count = (out: string) => Number(/Doctor found (\d+) problems?/.exec(out)?.[1] ?? 0);
    const nameless = JSON.parse(close('discord:111/555', '2026-11-01T04:25:00.000Z'));
    delete nameless.channelId;
    for (const manager of ['launchd', 'systemd-user'] as const) {
      const at = install({ manager });
      const parts = { checkService: async () => ({ passed: true, lines: [] }), python: null };
      const before = await run(at, parts);
      expect(before.out).not.toContain('Channels the subscription GC closed');
      mkdirSync(join(at.work, 'logs'));
      writeFileSync(join(at.work, 'logs', 'failures.log'), [close('discord:111/222', '2026-11-01T04:10:00.000Z'),
        close('discord:111/333', '2026-11-01T04:20:00.000Z'), close('discord:111/222', '2026-11-01T04:30:00.000Z'),
        JSON.stringify(nameless), ...Array.from({ length: 5000 }, () => other), ''].join('\n'));
      const r = await run(at, parts);
      expect(r.out).toContain(named('discord:111/222', '2026-11-01T04:30:00.000Z'));
      expect(r.out).toContain(named('discord:111/333', '2026-11-01T04:20:00.000Z'));
      expect(r.out).not.toContain('auto-closed at 2026-11-01T04:10:00.000Z');
      expect(r.out).not.toContain('discord:111/555');
      expect(count(r.out)).toBe(count(before.out));
      expect(r.status).toBe(before.status);
      rmSync(join(at.work, 'logs', 'failures.log'));
      mkdirSync(join(at.work, 'logs', 'failures.log'));
      const unreadable = await run(at, parts);
      expect(unreadable.out).toContain(`  ${join(at.work, 'logs', 'failures.log')} can't be read (`);
      expect(unreadable.out).toContain('), so which channels the subscription GC closed isn\'t shown.');
      expect(count(unreadable.out)).toBe(count(before.out));
    }
  });

  test('a data directory the install record doesn\'t name whole leaves the ladder unrun, saying why, and says the record\'s fault once', async () => {
    const at = install();
    writeFileSync(join(at.root, 'install.json'), JSON.stringify({ v: 1, dataDir: 'data', extraState: [] }));
    const r = await run(at);
    expect(r.out).toContain('The ladder reads the host\'s data directory, and where that is can\'t be told (said above), so it doesn\'t run.');
    expect(r.out).not.toContain('ladder args');
    expect(r.out).not.toMatch(/✗ The ladder reads/);
    expect(r.out.split('names its data directory as "data", not an absolute path').length - 1).toBe(1);
    expect(r.out).toMatch(/✗ No host answers: The install record at \S+ names its data directory as "data"/);
  });

  test('an install that runs under launchd gets no ladder, which reads systemd\'s units and journal, and says so', async () => {
    const at = install({ manager: 'launchd' });
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).not.toContain('ladder args');
    expect(r.out).toMatch(/launchd/);
    expect(r.out).toMatch(/Doctor found no problem, though the ladder didn't run and the fit wasn't checked, as said above\.$/);
    expect(r.status).toBe(0);
  });

  test('words after doctor are a usage error', async () => {
    const r = await run(install(), {}, ['now']);
    expect(r.status).toBe(2);
    expect(r.err).toContain('connectome: usage: connectome doctor');
  });

  test('the install\'s command dispatches doctor', async () => {
    const at = install();
    const said: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => { said.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      expect(await main(at.root, ['doctor', 'now'])).toBe(2);
    } finally {
      process.stderr.write = write;
    }
    expect(said.join('')).toBe('connectome: usage: connectome doctor\n');
  });

  test('the install\'s help says the host takes one client at a time, so doctor\'s connection closes another command\'s', async () => {
    const at = install();
    const said: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => { said.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try {
      expect(await main(at.root, ['help'])).toBe(0);
    } finally {
      process.stdout.write = write;
    }
    expect(said.join('')).toContain('The host takes one client at a time, so doctor\'s connection to it closes another command\'s.');
  });
});

describe('connectome doctor: the environment the service gets from its manager', () => {
  test('on systemd, what the user manager gives the service counts: a value only it holds is withheld, a listed name only it gives isn\'t missing, and the recipe loads and is judged with its names and MODEL', async () => {
    const at = install({
      stored: ['DISCORD_TOKEN', 'SESSION_SERVER_TOKEN', 'MANAGER_SECRET'],
      recipe: { ...RECIPE(''), agent: { name: 'ember', model: 'claude-recipe-model', systemPrompt: 'hi ${MANAGER_NAME}' } },
    });
    const manager = fakeManager(at.work, {
      env: ['MANAGER_SECRET=manager-secret-value', 'MANAGER_NAME=from-the-manager', 'MODEL=claude-manager-model'],
    });
    const r = await withHost(at, HEALTHY_HOST, () => run(at, {
      systemctl: manager.path, ...reports('| the journal says manager-secret-value'),
    }));
    expect(manager.calls()).toEqual(['--user show-environment', '--user show --property=Environment --value -- connectome-test.service',
      '--user show --property=EnvironmentFiles --value -- connectome-test.service']);
    expect(r.out).toContain('| the journal says <MANAGER_SECRET>');
    expect(r.out).not.toContain('manager-secret-value');
    expect(r.out).not.toMatch(/MANAGER_SECRET is in setup's list of stored secrets \(.*\), and no file Bun reads/);
    expect(r.out).toMatch(/✓ .*recipe\.json loads\./);
    expect(r.out).toContain('fit claude-manager-model\'s window');
  });

  test('on systemd, a value the manager prints quoted, with escapes, is read as the manager holds it', async () => {
    const quoted = 'it\'s a "quoted" \\ value\twith\na\u0001control and café';
    const at = install({ stored: ['DISCORD_TOKEN', 'SESSION_SERVER_TOKEN', 'QUOTED_SECRET', 'PLAIN_SECRET'] });
    const manager = fakeManager(at.work, {
      env: ['QUOTED_SECRET=$\'it\\\'s a "quoted" \\\\ value\\twith\\na\\001control and café\'', 'PLAIN_SECRET=plain=value'],
    });
    const r = await withHost(at, HEALTHY_HOST, () => run(at, {
      systemctl: manager.path, ...reports(`| the journal says ${quoted} and plain=value`),
    }));
    expect(r.out).toContain('| the journal says <QUOTED_SECRET> and <PLAIN_SECRET>');
    expect(r.out).not.toContain('plain=value');
    expect(r.out).not.toContain('a "quoted"');
  });

  test('on launchd, each name doctor withholds or reads is asked of launchd, and what setenv gives counts as the service\'s', async () => {
    const at = install({
      manager: 'launchd',
      stored: ['DISCORD_TOKEN', 'SESSION_SERVER_TOKEN', 'SETENV_SECRET'],
      recipe: { ...RECIPE(''), agent: { name: 'ember', model: 'claude-recipe-model', systemPrompt: 'hi ${SETENV_NAME}' } },
    });
    const manager = fakeManager(at.work, {
      launchd: { SETENV_SECRET: 'setenv-secret-value', SETENV_NAME: 'from-setenv', MODEL: 'claude-setenv-model' },
    });
    const r = await withHost(at, HEALTHY_HOST, () => run(at, {
      launchctl: manager.path, ...reports('| the log says setenv-secret-value'),
    }));
    const asked = manager.calls();
    for (const name of ['SETENV_SECRET', 'SETENV_NAME', 'MODEL', 'MCPL_AGENT_OVERLAY_FILE', 'ANTHROPIC_API_KEY', 'DISCORD_TOKEN']) {
      expect(asked).toContain(`getenv ${name}`);
    }
    expect(asked).not.toContain('--user show-environment');
    expect(r.out).toContain('| the log says <SETENV_SECRET>');
    expect(r.out).not.toContain('setenv-secret-value');
    expect(r.out).not.toMatch(/SETENV_SECRET is in setup's list of stored secrets \(.*\), and no file Bun reads/);
    expect(r.out).toMatch(/✓ .*recipe\.json loads\./);
    expect(r.out).toContain('fit claude-setenv-model\'s window');
  });

  test('on launchd, a name a dotenv value puts in, and NODE_ENV, are asked of launchd, so a stored secret built from launchd\'s value is withheld', async () => {
    const at = install({ manager: 'launchd', stored: ['DISCORD_TOKEN', 'SESSION_SERVER_TOKEN', 'BUILT_TOKEN'] });
    writeFileSync(join(at.work, '.env.local'), 'BUILT_TOKEN=$TOKEN_PART\n');
    const manager = fakeManager(at.work, { launchd: { TOKEN_PART: 'launchd-part-value' } });
    const r = await withHost(at, HEALTHY_HOST, () => run(at, {
      launchctl: manager.path, ...reports('| the log says launchd-part-value'),
    }));
    expect(manager.calls()).toContain('getenv TOKEN_PART');
    expect(manager.calls()).toContain('getenv NODE_ENV');
    expect(r.out).toContain('| the log says <BUILT_TOKEN>');
    expect(r.out).not.toContain('launchd-part-value');
  });

  test('on launchd, a name put in with a default, and each name its default puts in, are asked of launchd too', async () => {
    const at = install({ manager: 'launchd', stored: ['DISCORD_TOKEN', 'SESSION_SERVER_TOKEN', 'BUILT_TOKEN'] });
    writeFileSync(join(at.work, '.env.local'), [
      'BUILT_TOKEN=${TOKEN_PART:-$FALLBACK_PART}',
      'LITERAL=${NOT_ASKED_A-x}${NOT_ASKED_B:=x}${NOT_ASKED_C:+x}${NOT_ASKED_D:?x}',
      '',
    ].join('\n'));
    const manager = fakeManager(at.work, { launchd: { TOKEN_PART: 'launchd-part-value' } });
    const r = await withHost(at, HEALTHY_HOST, () => run(at, {
      launchctl: manager.path, ...reports('| the log says launchd-part-value'),
    }));
    expect(manager.calls()).toContain('getenv TOKEN_PART');
    expect(manager.calls()).toContain('getenv FALLBACK_PART');
    expect(manager.calls().filter((call) => call.includes('NOT_ASKED'))).toEqual([]);
    expect(r.out).toContain('| the log says <BUILT_TOKEN>');
    expect(r.out).not.toContain('launchd-part-value');
  });

  test('on launchd, the Discord check of a server given the host\'s whole environment reads the scope launchd gives', async () => {
    const at = install({
      manager: 'launchd',
      recipe: { ...RECIPE(''), mcpServers: {
        discord: { command: '/x/node_modules/.bin/discord-mcpl', inheritEnv: true },
        shell: RECIPE('').mcpServers.shell,
      } },
    });
    const manager = fakeManager(at.work, { launchd: { DISCORD_GUILD_ID: '100', DISCORD_FILTERS_FILE: 'filters-from-launchd.json' } });
    const r = await withHost(at, HEALTHY_HOST, () => run(at, { launchctl: manager.path }));
    expect(manager.calls()).toEqual(expect.arrayContaining(['getenv DISCORD_GUILD_ID', 'getenv DISCORD_FILTERS_FILE']));
    expect(r.out).toContain(`${join(at.work, 'filters-from-launchd.json')} (DISCORD_FILTERS_FILE) isn't there.`);
    expect(r.out).toContain('The scope discord-mcpl starts with, from DISCORD_GUILD_ID:');
  });

  test('the service\'s own settings in its unit or plist win over what its manager gives', async () => {
    for (const manager of ['systemd-user', 'launchd'] as const) {
      const at = install({
        manager,
        recipe: { ...RECIPE(''), agent: { name: 'ember', model: 'claude-sup-${CONNECTOME_SUPERVISED}', systemPrompt: 'hi' } },
      });
      const given = fakeManager(at.work, {
        env: ['CONNECTOME_SUPERVISED=0'], launchd: { CONNECTOME_SUPERVISED: '0' }, unit: unitWords(at.data),
      });
      const r = await withHost(at, HEALTHY_HOST, () => run(at, { systemctl: given.path, launchctl: given.path }));
      expect([manager, r.out]).toEqual([manager, expect.stringContaining('fit claude-sup-1\'s window')]);
    }
  });

  test('a manager that can\'t be asked stops doctor, with its own error, as it stops when it can\'t read which values are secret', async () => {
    for (const [manager, asked] of [['systemd-user', 'systemctl --user show-environment'], ['launchd', 'launchctl getenv']] as const) {
      const at = install({ manager });
      const failing = fakeManager(at.work, { fails: 'Failed to connect to bus: No medium found' });
      const r = await run(at, { systemctl: failing.path, launchctl: failing.path });
      expect([manager, r.out]).toEqual([manager, expect.stringContaining(asked)]);
      expect(r.out).toContain('can\'t be read: Failed to connect to bus: No medium found');
      expect(r.out).toContain('Doctor stops here: it can\'t tell which values are secret, so it prints no check\'s output.');
      expect(r.out).not.toContain('The unit connectome-test.service is active');
      expect(r.status).toBe(1);
    }
  });

  test('a manager that doesn\'t answer within the limit stops doctor, saying so', async () => {
    const at = install();
    const slow = fakeManager(at.work, { hangs: true });
    const r = await run(at, { systemctl: slow.path, envLimitMs: 300 });
    expect(r.out).toContain('systemctl --user show-environment failed, so what the user manager gives the service can\'t be ' +
      'read: it didn\'t answer within 0.3 s');
    expect(r.out).toContain('Doctor stops here');
    expect(r.status).toBe(1);
  });

  test('the manager a service here runs under is asked, and no other, with its unit or without one', async () => {
    const none = install();
    rmSync(none.unit);
    const platform = fakeManager(none.work);
    await run(none, { systemctl: platform.path, launchctl: platform.path });
    expect(platform.calls()).toEqual(['--user show-environment']);
    const noPlist = install({ manager: 'launchd' });
    rmSync(noPlist.unit);
    const mac = fakeManager(noPlist.work);
    await run(noPlist, { systemctl: mac.path, launchctl: mac.path });
    expect(mac.calls().length).toBeGreaterThan(0);
    expect(mac.calls().every((call) => call.startsWith('getenv '))).toBe(true);
    const launchd = install({ manager: 'launchd' });
    const asked = fakeManager(launchd.work);
    await run(launchd, { systemctl: asked.path, launchctl: asked.path });
    expect(asked.calls().length).toBeGreaterThan(0);
    expect(asked.calls().every((call) => call.startsWith('getenv '))).toBe(true);
    const systemd = install();
    const user = fakeManager(systemd.work);
    await run(systemd, { systemctl: user.path, launchctl: user.path });
    expect(user.calls()).toEqual(['--user show-environment', '--user show --property=Environment --value -- connectome-test.service',
      '--user show --property=EnvironmentFiles --value -- connectome-test.service']);
  });
});

describe('connectome doctor: its waits, its remedies and its last line', () => {
  test('a Bun that doesn\'t finish reading the service\'s environment within its limit stops doctor, which says so', async () => {
    const at = install();
    writeFileSync(join(at.work, 'hang.ts'), 'Bun.sleepSync(10_000);\n');
    writeFileSync(join(at.work, 'bunfig.toml'), 'preload = ["./hang.ts"]\n');
    const r = await run(at, { envLimitMs: 500 });
    expect(r.out).toContain(`Bun didn't finish reading the service's environment in ${at.work} within 0.5 s`);
    expect(r.out).toContain('Doctor stops here');
    expect(r.status).toBe(1);
  }, 30_000);

  test('a recipe, or its system prompt, fetched from a URL that doesn\'t answer within the limit is a problem, and doctor goes on', async () => {
    const silent = Bun.serve({ port: 0, hostname: '127.0.0.1', idleTimeout: 0, fetch: () => new Promise<Response>(() => {}) });
    try {
      const url = `http://127.0.0.1:${silent.port}/recipe.json`;
      const at = install();
      writeUnit(at, url);
      const r = await withHost(at, HEALTHY_HOST, () => run(at, { recipeLimitMs: 300 }));
      expect(r.out).toContain(`✗ ${url} didn't load within 0.3 s: the fetch of it didn't answer in time.`);
      expect(r.out).toContain('Discord isn\'t checked: which servers run is in the recipe, which didn\'t load.');
      const prompt = install({ recipe: { ...RECIPE(''), agent: { name: 'ember', systemPrompt: `http://127.0.0.1:${silent.port}/prompt` } } });
      const p = await withHost(prompt, HEALTHY_HOST, () => run(prompt, { recipeLimitMs: 300 }));
      expect(p.out).toMatch(/✗ \S+recipe\.json didn't load within 0\.3 s: the fetch of its system prompt didn't answer in time\./);
      expect(p.out).toMatch(/Doctor found \d+ problems?, marked ✗\./);
    } finally {
      silent.stop(true);
    }
  }, 15_000);

  test('a listed secret that a file Bun reads before .env empties is said empty, and the remedy names the files that come before .env', async () => {
    const at = install({ stored: ['DISCORD_TOKEN', 'SESSION_SERVER_TOKEN', 'LONELY_SECRET'] });
    writeFileSync(join(at.work, '.env.local'), 'LONELY_SECRET=\n');
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).toContain(`✗ LONELY_SECRET is in setup's list of stored secrets and is empty in the service's environment: ` +
      `give it its value in ${join(at.work, '.env')} and restart the service. Another of the files Bun reads there, such ` +
      'as .env.local or .env.development, or the service\'s own environment, comes before .env where it sets the name: ' +
      'where one sets it empty, give it its value there.');
  });

  test('the remedy for a COUNT_TOKENS_MODEL that answers 404, and for a listed secret nothing gives, names the files that come before .env', async () => {
    const at = install({ stored: ['DISCORD_TOKEN', 'SESSION_SERVER_TOKEN', 'LONELY_SECRET'], drop: ['LONELY_SECRET'] });
    const r = await withHost(at, { ...HEALTHY_HOST, 'count-check': {
      ...COUNTED, agent: { ...COUNTED.agent, source: 'count_tokens_failed_404' },
    } }, () => run(at));
    const before = 'Another of the files Bun reads there, such as .env.local or .env.development, or the service\'s own ' +
      'environment, comes before .env where it sets the name: ';
    expect(r.out).toContain(`since the host reads it when it starts. ${before}where one sets it, set it there instead.`);
    expect(r.out).toContain(`take it out of that list. ${before}where one sets it empty, give it its value there.`);
  });

  test('a DISCORD_TOKEN stored with its prefix, or with whitespace after it, is withheld in the form Discord is sent too', async () => {
    for (const stored of [`Bot ${SECRETS.DISCORD_TOKEN}`, `${SECRETS.DISCORD_TOKEN}  `]) {
      const at = install({ env: { DISCORD_TOKEN: stored } });
      const quoting = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
        new URL(String(input)).pathname.endsWith('/applications/@me')
          ? Response.json({ message: `Unknown token ${SECRETS.DISCORD_TOKEN}`, code: 50014 }, { status: 400 })
          : discordFetch(input, init)) as typeof fetch;
      const r = await withHost(at, HEALTHY_HOST, () => run(at, { fetch: quoting }));
      expect([stored, r.out]).toEqual([stored, expect.stringContaining('Unknown token <DISCORD_TOKEN>')]);
      expectNoSecret(r.out + r.err);
    }
  });

  test('with no host answering, doctor that finds no problem says the host\'s checks weren\'t made', async () => {
    const at = install();
    const stopped = await run(at, {
      checkService: async () => ({ passed: true, lines: ['connectome-test.service is stopped.'], stopped: true }),
      python: fakePython(at.work, { end: 'clean' }),
    });
    expect(stopped.out).toMatch(/Doctor found no problem, though the host's checks weren't made and the fit wasn't checked, as said above\.$/);
    expect(stopped.status).toBe(0);
    const unladdered = await run(at, {
      checkService: async () => ({ passed: true, lines: ['connectome-test.service is stopped.'], stopped: true }),
      python: null,
    });
    expect(unladdered.out).toMatch(/Doctor found no problem, though the host's checks weren't made, the ladder didn't run and the fit wasn't checked, as said above\.$/);
  });

  test('with the recipe edited since the host started, the fit is the load\'s, by estimate, and says why', async () => {
    const at = install();
    writeFileSync(join(at.work, 'recipe.json'), JSON.stringify({
      ...RECIPE(at.work), agent: { name: 'ember', model: 'claude-haiku-4-5', systemPrompt: '' },
    }));
    const recipeDigest = await digestOf(at);
    writeFileSync(join(at.work, 'recipe.json'), JSON.stringify({
      ...RECIPE(at.work), description: 'edited since the host started, with the same model and budget',
      agent: { name: 'ember', model: 'claude-haiku-4-5', systemPrompt: '' },
    }));
    const r = await withHost(at, { ...HEALTHY_HOST, 'count-check': {
      ...COUNTED, agent: { ...COUNTED.agent, model: 'claude-haiku-4-5' }, beside: { tokens: 20_000, source: 'count_tokens' },
      budget: 168_000, recipeDigest,
    } }, () => run(at));
    expect(r.out).toContain('✓ It fits claude-haiku-4-5\'s window.\n  The system prompt and tools the host sends weren\'t ' +
      'counted (the recipe doesn\'t load for doctor as it did for the running host: an edit since its start, a system ' +
      'prompt its URL now serves differently, or a value doctor\'s rebuilt environment gives otherwise can each leave it ' +
      'so), so this is the check the host makes at load, by estimate.');
    expect(r.out).not.toContain('to spare');
  });
});

describe('connectome doctor, where what it found can mislead or it can\'t look', () => {
  const refusing = (said: string) => ({
    ...HEALTHY_HOST,
    'shell-check': { shells: [], notConnected: [{ id: 'shell', refused: said, retrying: false }], closedTabs: [] },
  });

  test('with no service installed, doctor asks the manager a service here would run under, and withholds what only it gives', async () => {
    const at = install({ stored: ['DISCORD_TOKEN', 'SESSION_SERVER_TOKEN', 'MANAGED_SECRET'] });
    rmSync(at.unit);
    const manager = fakeManager(at.work, {
      env: ['MANAGED_SECRET=managed-secret-value'], launchd: { MANAGED_SECRET: 'managed-secret-value' },
    });
    const r = await withHost(at, refusing('the token managed-secret-value was refused'),
      () => run(at, { systemctl: manager.path, launchctl: manager.path }));
    expect(manager.calls()).toEqual(['--user show-environment']);
    expect(r.out).toContain('the token <MANAGED_SECRET> was refused');
    expect(r.out).not.toContain('managed-secret-value');
  });

  test('with no service installed and a manager that can\'t be read, doctor goes on, naming the step that failed', async () => {
    for (const [manager, asked, step] of [
      ['systemd-user', 'systemd\'s user manager', '`systemctl --user show-environment`'],
      ['launchd', 'launchd', '`launchctl getenv \\w+`'],
    ] as const) {
      const at = install({ manager });
      rmSync(at.unit);
      const failing = fakeManager(at.work, { fails: 'Failed to connect to bus: No medium found' });
      const r = await withHost(at, HEALTHY_HOST, () => run(at, { systemctl: failing.path, launchctl: failing.path }));
      expect([manager, r.out]).toEqual([manager, expect.stringMatching(new RegExp(`With no service installed, doctor asked ${asked}, ` +
        `which a service installed here would run under, and couldn't read it \\(${step} failed: Failed to connect to bus: No ` +
        'medium found\\), so a value only that manager gives isn\'t known to doctor or hidden in what it prints\\.'))]);
      expect(r.out).not.toContain('Then run doctor again');
      expect(r.out).not.toContain('Doctor stops here');
      expect(r.out).toContain('pid 4242');
    }
  });

  test('a host that answers while its service is stopped is a problem naming it, with no advice to start the service until it\'s stopped', async () => {
    const at = install();
    const r = await withHost(at, HEALTHY_HOST, () => run(at, {
      checkService: async () => ({ passed: true, lines: ['connectome-test.service is stopped: systemd shows it inactive (dead).'], stopped: true }),
      python: fakePython(at.work, { end: 'clean' }),
      servicePid: async () => ({ pid: '0' }),
    }));
    expect(r.out).toContain('✗ A host answers, pid 4242, recipe Ember, though the service is stopped, so it isn\'t the service\'s');
    expect(r.out).toMatch(/Stop it before `(XDG_RUNTIME_DIR=\S+ )?systemctl --user start connectome-test\.service`, since a host the service starts takes this install's socket/);
    expect(r.out).not.toMatch(/systemctl --user start connectome-test\.service` starts it/);
    expect(r.out).not.toContain('✓ The host answers');
    expect(r.status).toBe(1);
  });

  test('a literal DISCORD_TOKEN in a server\'s own entry is withheld too', async () => {
    const literal = 'literal-entry-token';
    const at = install();
    writeFileSync(join(at.work, 'mcpl-servers.json'), JSON.stringify({ mcplServers: {
      discord: { command: join(at.work, 'node_modules/.bin/discord-mcpl'), env: { DISCORD_TOKEN: literal, DISCORD_GUILD_ID: '100' } },
    } }));
    const echoing = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
      new URL(String(input)).pathname.endsWith('/users/@me') ? Response.json({ id: '902', username: 'literal' })
        : Response.json({ message: `proxy refused ${new Headers(init?.headers).get('authorization')}`, code: 0 }, { status: 403 })) as typeof fetch;
    const r = await withHost(at, HEALTHY_HOST, () => run(at, { fetch: echoing }));
    expect(r.out).toContain('proxy refused Bot <DISCORD_TOKEN>');
    expect(r.out).not.toContain(literal);
  });

  test('a stored secret only .env.local gives, which the service\'s manager sets empty, is said to be empty there, not missing from every file', async () => {
    const at = install({ stored: ['DISCORD_TOKEN', 'SESSION_SERVER_TOKEN', 'LOCAL_TOKEN'] });
    writeFileSync(join(at.work, '.env.local'), 'LOCAL_TOKEN=local-token-value\n');
    const manager = fakeManager(at.work, { env: ['LOCAL_TOKEN='] });
    const r = await withHost(at, HEALTHY_HOST, () => run(at, { systemctl: manager.path }));
    expect(r.out).toContain('✗ LOCAL_TOKEN is in setup\'s list of stored secrets and is empty in the service\'s environment');
    expect(r.out).not.toMatch(/LOCAL_TOKEN is in setup's list of stored secrets \(.*\), and no file Bun reads/);
  });

  test('lines naming a channel\'s auto-close that can\'t be read as one are counted and said', async () => {
    const at = install();
    mkdirSync(join(at.work, 'logs'));
    writeFileSync(join(at.work, 'logs', 'failures.log'), [
      '{"kind":"subscription-gc-close","channelId":"discord:111/2',
      JSON.stringify({ kind: 'subscription-gc-close', channelId: 'discord:111/333', at: '2026-11-01T04:20:00.000Z', restore: 'channel_open discord:111/333' }),
      '',
    ].join('\n'));
    const r = await run(at, { checkService: async () => ({ passed: true, lines: [] }), python: null });
    expect(r.out).toContain('Channels the subscription GC closed (logs/failures.log):');
    expect(r.out).toContain('2 lines there name a subscription-gc-close but can\'t be read as one, cut short or missing a field, so a ' +
      'channel they would name may have been closed too.');
  });

  test('the closing line names an unchecked fit and a failures.log it couldn\'t read among what wasn\'t checked', async () => {
    const at = install();
    mkdirSync(join(at.work, 'logs'));
    mkdirSync(join(at.work, 'logs', 'failures.log'));
    const r = await withHost(at, HEALTHY_HOST, () => run(at, { python: fakePython(at.work, { end: 'clean' }) }));
    expect(r.out).toContain('[fit] Not checked:');
    expect(r.out).toMatch(/Doctor found no problem, though the fit wasn't checked and the channels the subscription GC closed couldn't be read, as said above\.$/);
    expect(r.status).toBe(0);
  });

  test('a ladder that can\'t be started is a problem, and doctor still ends with its closing line', async () => {
    const at = install();
    writeFileSync(join(at.root, 'install.json'), JSON.stringify({ v: 1, dataDir: `${at.data}\u0000`, extraState: [] }));
    const r = await run(at);
    expect(r.out).toMatch(/✗ The ladder couldn't be started: /);
    expect(r.out).toMatch(/Doctor found \d+ problems?, marked ✗\.$/);
  });

  test('a manager or Bun answer doctor can\'t read stops it with what to do next', async () => {
    const systemd = install();
    const failing = fakeManager(systemd.work, { fails: 'Failed to connect to bus: No medium found' });
    const bus = await run(systemd, { systemctl: failing.path });
    expect(bus.out).toContain('Run `systemctl --user show-environment` as this user to see why: it needs the user\'s manager running and ' +
      'XDG_RUNTIME_DIR naming its directory, as a login session sets it. Then run doctor again.');
    const launchd = install({ manager: 'launchd' });
    const failingLaunchd = fakeManager(launchd.work, { fails: 'launchctl: no such domain' });
    const domain = await run(launchd, { launchctl: failingLaunchd.path });
    expect(domain.out).toMatch(/Run `launchctl getenv \S+` as this user to see why, then run doctor again\./);
    const preloaded = install();
    writeFileSync(join(preloaded.work, 'preload.ts'), 'process.stdout.write("hello from a preload\\n");\n');
    writeFileSync(join(preloaded.work, 'bunfig.toml'), 'preload = ["./preload.ts"]\n');
    const noisy = await run(preloaded);
    expect(noisy.out).toContain('`bun -e 0`, run there, shows what writes, though with your shell\'s environment, not the ' +
      'service\'s; once nothing does, run doctor again.');
  });
});

describe('connectome doctor\'s Discord check, where Discord or the way to it answers oddly', () => {
  const answering = (on: string, answer: () => Response | Promise<Response>) => (async (input: string | URL | Request, init?: RequestInit) =>
    new URL(String(input)).pathname.endsWith(on) ? answer() : discordFetch(input, init)) as typeof fetch;

  test('a 429 names the wait Discord asked for', async () => {
    const at = install();
    const r = await withHost(at, HEALTHY_HOST, () => run(at, {
      fetch: answering('/guilds/100/roles', () => Response.json({ message: 'You are being rate limited.', retry_after: 2.5, global: false }, { status: 429 })),
    }));
    expect(r.out).toContain('Discord answered 429 to GET /guilds/100/roles: You are being rate limited., so the Discord checks after it ' +
      'weren\'t made: Discord asked for 3 s before the next request, so run connectome doctor again after that.');
  });

  test('a request that can\'t reach Discord says to check this machine can reach discord.com', async () => {
    const at = install();
    const r = await withHost(at, HEALTHY_HOST, () => run(at, {
      fetch: answering('/applications/@me', () => { throw new TypeError('getaddrinfo ENOTFOUND discord.com'); }),
    }));
    expect(r.out).toContain('Discord couldn\'t be asked GET /applications/@me: getaddrinfo ENOTFOUND discord.com, so the Discord checks ' +
      'after it weren\'t made: check that this machine can resolve and reach discord.com, then run connectome doctor again.');
  });

  test('a redirect or an answer that isn\'t JSON says something between this machine and Discord may be answering', async () => {
    const at = install();
    const between = 'Something between this machine and Discord, such as a proxy, may be answering in its place.';
    const redirected = await withHost(at, HEALTHY_HOST, () => run(at, {
      fetch: answering('/applications/@me', () => new Response(null, { status: 307, headers: { location: 'http://proxy.example/' } })),
    }));
    expect(redirected.out).toContain(`a redirect, which doctor doesn't follow with the token, so the Discord checks after it weren't made. ${between}`);
    const html = await withHost(at, HEALTHY_HOST, () => run(at, {
      fetch: answering('/applications/@me', () => new Response('<html>sign in</html>', { status: 200, headers: { 'content-type': 'text/html' } })),
    }));
    expect(html.out).toContain(`with something other than JSON, so the Discord checks after it weren't made. ${between}`);
  });

  test('a filters file that isn\'t there says a running discord-mcpl that had read it keeps the last filters it read', async () => {
    const at = install({ recipe: { ...RECIPE(''), mcpServers: { discord: { command: '/x/node_modules/.bin/discord-mcpl', env: {
      DISCORD_TOKEN: '${DISCORD_TOKEN}', DISCORD_GUILD_ID: '100', DISCORD_FILTERS_FILE: 'filters.json' } } } } });
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).toContain('If a running discord-mcpl had read it, and it was removed since, the last filters it read stay in ' +
      'force until the file is back.');
  });
});

describe('connectome doctor, its round on the review of 4a79597ff', () => {
  test('a host answering while the service runs, with a pid other than the service\'s main process, is a problem naming it', async () => {
    const at = install();
    const r = await withHost(at, HEALTHY_HOST, () => run(at, { servicePid: async () => ({ pid: '5151' }) }));
    expect(r.out).toContain('✗ A host answers, pid 4242, recipe Ember, but connectome-test.service\'s main process is 5151, so ' +
      'it isn\'t the service\'s: it was started some other way, such as by hand, and the checks below are of it.');
    expect(r.out).toContain('Stop it, since a host the service starts takes this install\'s socket from one that holds it, and the ' +
      'service\'s own host can\'t be reached while it does: `kill 4242` stops it.');
    expect(r.out).not.toContain('✓ The host answers');
    expect(r.status).toBe(1);
  });

  test('a host answering while the service has no main process is a problem saying so', async () => {
    const at = install();
    const r = await withHost(at, HEALTHY_HOST, () => run(at, { servicePid: async () => ({ pid: '0' }) }));
    expect(r.out).toContain('✗ A host answers, pid 4242, recipe Ember, but connectome-test.service has no main process, so it ' +
      'isn\'t the service\'s');
  });

  test('a host answering while the manager can\'t say the service\'s pid is said, and the closing line names it unmade', async () => {
    const at = install();
    const r = await withHost(at, HEALTHY_HOST, () => run(at, {
      servicePid: async () => ({ why: 'systemd couldn\'t be asked about connectome-test.service: Failed to connect to bus' }),
      python: fakePython(at.work, { end: 'clean' }),
    }));
    expect(r.out).toContain('The host answers: pid 4242, recipe Ember. Whether it\'s the service\'s host can\'t be told: systemd ' +
      'couldn\'t be asked about connectome-test.service: Failed to connect to bus.');
    expect(r.out).not.toContain('✓ The host answers');
    expect(r.out).toMatch(/Doctor found no problem, though .*whether the host that answers is the service's couldn't be told, as said above\.$/);
    const thrown = await withHost(at, HEALTHY_HOST, () => run(at, {
      servicePid: () => { throw new TypeError('The argument \'args[5]\' must be a string without null bytes'); },
    }));
    expect(thrown.out).toContain('Whether it\'s the service\'s host can\'t be told: The argument \'args[5]\' must be a string ' +
      'without null bytes.');
  });

  test('a literal DISCORD_TOKEN in a server\'s entry is withheld from the lines that print before the servers are checked', async () => {
    const literal = 'literal-early-token';
    const at = install({ recipe: { ...RECIPE(''), name: `named ${literal}`, bogus: true, mcpServers: { discord: {
      command: '/x/node_modules/.bin/discord-mcpl', env: { DISCORD_TOKEN: '${DISCORD_TOKEN}', DISCORD_GUILD_ID: '100' } } } } });
    writeFileSync(join(at.work, 'mcpl-servers.json'), JSON.stringify({ mcplServers: {
      discord: { command: '/x/node_modules/.bin/discord-mcpl', env: { DISCORD_TOKEN: literal, DISCORD_GUILD_ID: '100' } },
    } }));
    const r = await withHost(at, HEALTHY_HOST, () => run(at, { ...reports(`the unit logged ${literal}`) }));
    expect(r.out).toContain('the unit logged <DISCORD_TOKEN>');
    expect(r.out).toContain('Recipe "named <DISCORD_TOKEN>" has keys the host does not read');
    expect(r.out).not.toContain(literal);
  });

  test('each mode\'s dotenv files fill their own references, whatever doctor\'s own environment and the service\'s loaded mode give', async () => {
    const at = install();
    writeFileSync(join(at.work, '.env.development'), 'PREFIX=dev\n');
    writeFileSync(join(at.work, '.env.production'), 'PREFIX=prod\nDISCORD_TOKEN=${PREFIX}token\n');
    const before = process.env.PREFIX;
    process.env.PREFIX = 'dev';
    try {
      const r = await withHost(at, HEALTHY_HOST, () => run(at, { ...reports('a production run logged prodtoken') }));
      expect(r.out).toContain('a production run logged <DISCORD_TOKEN>');
      expect(r.out).not.toContain('prodtoken');
    } finally {
      if (before === undefined) delete process.env.PREFIX;
      else process.env.PREFIX = before;
    }
  });

  test('when it stops at its start, each mode\'s files fill their own references, whatever doctor\'s own environment gives', async () => {
    const at = install();
    writeFileSync(join(at.work, '.env.production'), 'PREFIX=prod\nDISCORD_TOKEN=${PREFIX}token\n');
    const failing = fakeManager(at.work, { fails: 'the bus said prodtoken' });
    const before = process.env.PREFIX;
    process.env.PREFIX = 'dev';
    try {
      const r = await withHost(at, HEALTHY_HOST, () => run(at, { systemctl: failing.path }));
      expect(r.out).toContain('Doctor stops here');
      expect(r.out).toContain('the bus said <DISCORD_TOKEN>');
      expect(r.out).not.toContain('prodtoken');
    } finally {
      if (before === undefined) delete process.env.PREFIX;
      else process.env.PREFIX = before;
    }
  });

  test('a mode\'s file filled from the service\'s manager is read with the service\'s own environment, not another mode\'s', async () => {
    const at = install();
    writeFileSync(join(at.work, '.env.development'), 'SUFFIX=devpart\n');
    writeFileSync(join(at.work, '.env.production'), 'DISCORD_TOKEN=${MANAGED}${SUFFIX}\n');
    const manager = fakeManager(at.work, {
      env: ['MANAGED=mgrpart'],
      unit: Object.entries(unitEnvironment(at)).map(([name, value]) => `${name}=${value}`).join(' '),
    });
    const r = await withHost(at, HEALTHY_HOST, () => run(at, { systemctl: manager.path, ...reports('a production run logged mgrpart.') }));
    expect(r.out).toContain('a production run logged <DISCORD_TOKEN>.');
  });

  const SHOWN = 'PATH=/unit/bin "B=has space" "C=dollar\\$\\$sign" "D=semi;colon" "E=back\\\\slash" "F=tab\\there" "G=quo\\"te" ' +
    'H=café "I=single\'q" J= DATA_DIR=/unit/data CONNECTOME_SUPERVISED=1';
  const DECODED = '/unit/bin|has space|dollar$$sign|semi;colon|back\\slash|tab\there|quo"te|café|single\'q||/unit/data';
  const echoing = { ...RECIPE(''), name: '${PATH}|${B}|${C}|${D}|${E}|${F}|${G}|${H}|${I}|${J}|${DATA_DIR}', bogus: true };

  test('the service\'s environment takes what its unit sets over the manager\'s, as systemd 257 prints it', async () => {
    const at = install({ recipe: echoing });
    const manager = fakeManager(at.work, { env: ['PATH=/manager/bin', 'DATA_DIR=/manager/data', 'B=manager'], unit: SHOWN });
    const r = await withHost(at, HEALTHY_HOST, () => run(at, { systemctl: manager.path }));
    expect(r.out).toContain(`Recipe "${DECODED}" has keys the host does not read`);
  });

  test('on launchd the service\'s environment takes what its plist sets, read through plutil', async () => {
    const at = install({ recipe: echoing, manager: 'launchd' });
    const manager = fakeManager(at.work, { launchd: { PATH: '/manager/bin', DATA_DIR: '/manager/data', B: 'manager' } });
    const plutil = fakePlutil(at.work, { PATH: '/unit/bin', B: 'has space', C: 'dollar$$sign', D: 'semi;colon', E: 'back\\slash',
      F: 'tab\there', G: 'quo"te', H: 'café', I: 'single\'q', J: '', DATA_DIR: '/unit/data', CONNECTOME_SUPERVISED: '1' });
    const r = await withHost(at, HEALTHY_HOST, () => run(at, { systemctl: manager.path, launchctl: manager.path, plutil }));
    expect(r.out).toContain(`Recipe "${DECODED}" has keys the host does not read`);
  });

  test('a unit whose environment systemd doesn\'t give stops doctor, saying so and what to do', async () => {
    const at = install();
    const manager = fakeManager(at.work, { unitFails: 'Failed to connect to bus: No such file or directory' });
    const r = await withHost(at, HEALTHY_HOST, () => run(at, { systemctl: manager.path }));
    expect(r.out).toContain('✗ systemd didn\'t say the environment connectome-test.service sets the service (');
    expect(r.out).toContain(`). Run doctor again, or \`${join(at.root, 'connectome')} service install ${join(at.work, 'recipe.json')}\` ` +
      'writes the unit anew.');
    expect(r.out).toContain('Doctor stops here');
    expect(r.out).not.toContain('pid 4242');
    expect(r.status).toBe(1);
  });

  test('a unit doctor can\'t use whose environment systemd doesn\'t give names <recipe> in its remedy, since doctor takes no recipe from it', async () => {
    const at = install();
    writeFileSync(at.unit, '[Service]\nWorkingDirectory=/x\nExecStart=bun start.js recipe.json\n');
    const manager = fakeManager(at.work, { unitFails: 'Failed to connect to bus: No such file or directory' });
    const r = await withHost(at, HEALTHY_HOST, () => run(at, { systemctl: manager.path }));
    expect(r.out).toContain(`Run doctor again, or \`${join(at.root, 'connectome')} service install <recipe>\` writes the unit anew.`);
    expect(r.out).toContain('Doctor stops here');
  });

  test('a unit systemd hasn\'t loaded gives no environment, as systemd answers, so doctor goes on, and the service check is what fails it', async () => {
    const at = install();
    const manager = fakeManager(at.work, { unit: null });
    const unloaded = `systemd has no connectome-test.service loaded (not-found): its unit file may be gone. Run connectome service install again.`;
    const r = await withHost(at, HEALTHY_HOST, () => run(at, {
      systemctl: manager.path,
      checkService: async () => ({ passed: false, lines: [unloaded] }),
    }));
    expect(manager.calls()).toContain('--user show --property=Environment --value -- connectome-test.service');
    expect(r.out).not.toContain('Doctor stops here');
    expect(r.out).not.toContain('systemd didn\'t say');
    expect(r.out).toContain(unloaded);
    expect(r.out).toContain('✗ The service check above didn\'t pass.');
    expect(r.out).toContain('ember (900)');
    expect(r.status).toBe(1);
  });

  test('a plist whose environment plutil gives as something other than JSON stops doctor, saying so', async () => {
    const at = install({ manager: 'launchd' });
    const plutil = join(at.work, 'plutil-garbled');
    writeFileSync(plutil, '#!/bin/sh\necho "<dict>"\n');
    chmodSync(plutil, 0o755);
    const r = await withHost(at, HEALTHY_HOST, () => run(at, { plutil }));
    expect(r.out).toContain(`${at.unit}, com.animalabs.connectome.test's plist, couldn't be read for the environment it sets the ` +
      `service (plutil's answer wasn't JSON). Fix it (\`plutil -lint ${at.unit}\` names what's wrong), or move it aside and run ` +
      `\`${join(at.root, 'connectome')} service install ${join(at.work, 'recipe.json')}\`, which writes it anew.`);
    expect(r.out).toContain('Doctor stops here');
  });

  test('the banner is out before doctor fetches the recipe\'s system prompt, so a fetch that hangs follows a line saying doctor started', async () => {
    const out: string[] = [];
    let printed: string[] | null = null;
    const prompt = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => {
      printed ??= [...out];
      return new Response('You are Ember.');
    } });
    try {
      const at = install({ recipe: { ...RECIPE(''), agent: { name: 'ember', systemPrompt: `http://127.0.0.1:${prompt.port}/prompt` } } });
      await withHost(at, HEALTHY_HOST, () => run(at, {}, [], out));
      expect(printed).toEqual([`connectome doctor: the install at ${at.root}`]);
    } finally {
      prompt.stop(true);
    }
  });

  test('a recipe the unit names by a relative path is read from the unit\'s working directory, as the host reads it', async () => {
    const at = install();
    writeUnit(at, 'recipe.json');
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).toContain(`✓ ${join(at.work, 'recipe.json')} loads.`);
    const link = join(dirname(at.work), 'linked');
    symlinkSync(at.work, link);
    writeUnit(at, 'recipe.json', link);
    const linked = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(linked.out).toContain(`✓ ${join(link, 'recipe.json')} loads.`);
  });

  test('the closing line names the counts no credential let the host make, and a closed tab, among what wasn\'t checked', async () => {
    const at = install();
    const r = await withHost(at, {
      'shell-check': { ...HEALTHY_HOST['shell-check'], closedTabs: ['games'] },
      'count-check': { beside: STANDIN_BESIDE,
        agent: { model: 'claude-small-window', countModel: 'claude-small-window', source: 'count_tokens_no_credential' },
        compression: { model: 'claude-small-window', countModel: 'claude-small-window', source: 'count_tokens_no_credential' },
      },
    }, () => run(at, { python: fakePython(at.work, { end: 'clean' }) }));
    expect(r.out).toMatch(/Doctor found no problem, though .*count_tokens had no credential to count with.* and a closed tab's connection wasn't checked, as said above\.$/);
  });

  test('a non-Claude compression model isn\'t named among what wasn\'t checked, since count_tokens doesn\'t apply to it', async () => {
    const at = install();
    const r = await withHost(at, {
      ...HEALTHY_HOST,
      'count-check': { ...COUNTED, compression: { model: 'gpt-x', countModel: null, source: 'count_tokens_unsupported_model' } },
    }, () => run(at, { python: fakePython(at.work, { end: 'clean' }) }));
    expect(r.out).toMatch(/Doctor found no problem, though the fit wasn't checked, as said above\.$/);
  });
});

describe('connectome doctor\'s Discord check, in its round on the review of 4a79597ff', () => {
  const answering = (on: string, answer: () => Response | Promise<Response>) => (async (input: string | URL | Request, init?: RequestInit) =>
    new URL(String(input)).pathname.endsWith(on) ? answer() : discordFetch(input, init)) as typeof fetch;

  test('a 429 to the token\'s own request names the wait Discord asked for', async () => {
    const at = install();
    const r = await withHost(at, HEALTHY_HOST, () => run(at, {
      fetch: answering('/users/@me', () => Response.json({ message: 'You are being rate limited.', retry_after: 119.2, global: false }, { status: 429 })),
    }));
    expect(r.out).toContain('Discord answered 429 to GET /users/@me: You are being rate limited., so the Discord checks after it ' +
      'weren\'t made: Discord asked for 120 s before the next request, so run connectome doctor again after that.');
  });

  test('a 403 or 404 to a server\'s own reads says Discord listed that server a moment before, and what to do', async () => {
    const at = install();
    const after = 'Discord listed that server for the bot a moment before, so if the bot has been removed from it since, ' +
      'invite it again, and otherwise run connectome doctor again.';
    for (const [on, status] of [['/guilds/100/roles', 403], ['/guilds/100/members/900', 404], ['/guilds/100/channels', 403]] as const) {
      const r = await withHost(at, HEALTHY_HOST, () => run(at, {
        fetch: answering(on, () => Response.json({ message: 'Missing Access', code: 50001 }, { status })),
      }));
      expect([on, r.out]).toEqual([on, expect.stringContaining(`Discord answered ${status} to GET ${on}: Missing Access (code 50001), ` +
        `so the Discord checks after it weren't made. ${after}`)]);
    }
  });

  test('with more than one Discord server, each entry\'s lines come after a line naming it', async () => {
    const at = install({ recipe: { ...RECIPE(''), mcpServers: {
      discord: { command: '/x/node_modules/.bin/discord-mcpl', env: { DISCORD_TOKEN: '${DISCORD_TOKEN}', DISCORD_GUILD_ID: '100' } },
      second: { command: '/x/node_modules/.bin/discord-mcpl', env: { DISCORD_TOKEN: 'bad-second-token', DISCORD_GUILD_ID: '100' } },
    } } });
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    const discord = r.out.slice(r.out.indexOf('\nDiscord\n'));
    expect(discord).toMatch(/\n {2}The entry discord:\n(.*\n)*? {2}The entry second:\n {2}✗ Discord refused/);
  });

  test('with one Discord server, no line names its entry', async () => {
    const at = install();
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).toContain('✓ The token in DISCORD_TOKEN works');
    expect(r.out).not.toContain('The entry discord:');
  });
});

describe('connectome doctor, its round on the review of e9bb852cc', () => {
  test('with a unit file install couldn\'t have written, a manager doctor can\'t read stops it, as with a readable one', async () => {
    const at = install();
    writeFileSync(at.unit, '[Service]\nExecStart=bun\n');
    const failing = fakeManager(at.work, { fails: 'Failed to connect to bus: No medium found' });
    const r = await withHost(at, HEALTHY_HOST, () => run(at, { systemctl: failing.path, launchctl: failing.path }));
    expect(r.out).toContain('Doctor stops here');
    expect(r.out).not.toContain('With no service installed');
    expect(r.status).toBe(1);
  });

  test('a name launchd holds empty is empty in the service\'s environment, though .env gives it a value', async () => {
    const at = install({ manager: 'launchd' });
    const manager = fakeManager(at.work, { launchd: { DISCORD_TOKEN: '' } });
    const r = await withHost(at, HEALTHY_HOST, () => run(at, { systemctl: manager.path, launchctl: manager.path }));
    expect(r.out).toContain('✗ DISCORD_TOKEN is in setup\'s list of stored secrets and is empty in the service\'s environment');
  });
});

describe('connectome doctor, its round on the review of aa87d916b', () => {
  test('a DISCORD_TOKEN in .env is hidden in the form Discord is sent it, even when Bun stops doctor before it reads the service\'s environment', async () => {
    const at = install({ prefix: 'chost-sent-form-token-', env: { DISCORD_TOKEN: 'Bot sent-form-token ' } });
    writeFileSync(join(at.work, 'bunfig.toml'), 'preload = ["./pre.ts"]\n');
    writeFileSync(join(at.work, 'pre.ts'), 'process.exit(1);\n');
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).toContain('Doctor stops here');
    expect(r.out).toContain('chost-<DISCORD_TOKEN>-');
    expect(r.out).not.toContain('sent-form-token');
  });

  test('a DISCORD_TOKEN in doctor\'s own environment is hidden in the form Discord is sent it, even when doctor stops before it reads the service\'s', async () => {
    const before = process.env.DISCORD_TOKEN;
    process.env.DISCORD_TOKEN = 'Bot sent-form-token ';
    try {
      const at = install({ prefix: 'chost-sent-form-token-' });
      writeFileSync(join(at.work, '.setup', 'stored-secrets.json'), 'not json');
      const r = await withHost(at, HEALTHY_HOST, () => run(at));
      expect(r.out).toContain('Doctor stops here');
      expect(r.out).toContain('<DISCORD_TOKEN>');
      expect(r.out).not.toContain('sent-form-token');
    } finally {
      if (before === undefined) delete process.env.DISCORD_TOKEN; else process.env.DISCORD_TOKEN = before;
    }
  });

  test('a stored secret\'s value the manager gives is hidden though the unit sets it otherwise', async () => {
    const at = install({ stored: ['DISCORD_TOKEN', 'SESSION_SERVER_TOKEN', 'MANAGER_SECRET'] });
    const unit = Object.entries(unitEnvironment(at)).map(([name, value]) => `${name}=${value}`).join(' ') +
      ' MANAGER_SECRET=unit-given-value';
    const manager = fakeManager(at.work, { env: ['MANAGER_SECRET=manager-given-value'], unit });
    const r = await withHost(at, HEALTHY_HOST, () => run(at, {
      systemctl: manager.path, ...reports('| the journal says manager-given-value and unit-given-value'),
    }));
    expect(r.out).toContain('| the journal says <MANAGER_SECRET> and <MANAGER_SECRET>');
    expect(r.out).not.toContain('manager-given-value');
  });

  test('a unit that sets a variable named why is read as its environment, not as a failure to give one', async () => {
    const at = install({ stored: ['DISCORD_TOKEN', 'SESSION_SERVER_TOKEN', 'why'] });
    const unit = Object.entries(unitEnvironment(at)).map(([name, value]) => `${name}=${value}`).join(' ') +
      ' why=stored-why-value';
    const manager = fakeManager(at.work, { unit });
    const r = await withHost(at, HEALTHY_HOST, () => run(at, { systemctl: manager.path }));
    expect(r.out).not.toContain('Doctor stops here');
    expect(r.out).not.toContain('systemd didn\'t say the environment');
    expect(r.out).not.toContain('stored-why-value');
    expect(r.out).toContain('✓ The host answers: pid 4242');
  });

  test('a server\'s literal DISCORD_TOKEN that holds a ${NAME} among other text is hidden, since it goes to discord-mcpl as written', async () => {
    const literal = 'prefix${NOT_FILLED}suffix';
    const at = install();
    writeFileSync(join(at.work, 'mcpl-servers.json'), JSON.stringify({ mcplServers: {
      discord: { command: '/x/node_modules/.bin/discord-mcpl', env: { DISCORD_TOKEN: literal, DISCORD_GUILD_ID: '100' } },
    } }));
    const r = await withHost(at, HEALTHY_HOST, () => run(at, { ...reports(`the unit logged ${literal}`) }));
    expect(r.out).toContain('the unit logged <DISCORD_TOKEN>');
    expect(r.out).not.toContain(literal);
  });

  test.skipIf(process.getuid?.() === 0)('a data directory under a directory this user can\'t search is said as one that can\'t be looked at, not as gone', async () => {
    const at = install();
    const locked = join(at.work, 'locked');
    mkdirSync(join(locked, 'data'), { recursive: true });
    writeFileSync(join(at.root, 'install.json'), JSON.stringify({ v: 1, dataDir: join(locked, 'data'), extraState: [] }));
    chmodSync(locked, 0o000);
    try {
      const r = await run(at);
      expect(r.out).toContain(`✗ The install record names ${join(locked, 'data')} as the resident's data directory, and it ` +
        'can\'t be looked at (');
      expect(r.out).toContain('), so whether it\'s there can\'t be told. Give this user search on each directory on the way to ' +
        'it, and run this again.');
      expect(r.out).not.toContain('and it isn\'t there');
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  test('a stored secret no file doctor reads gives, where the unit reads an EnvironmentFile, is said not known, naming the file, not missing', async () => {
    const at = install({ stored: ['DISCORD_TOKEN', 'SESSION_SERVER_TOKEN', 'LONELY_SECRET'], drop: ['LONELY_SECRET'] });
    const manager = fakeManager(at.work, {
      unit: Object.entries(unitEnvironment(at)).map(([name, value]) => `${name}=${value}`).join(' '),
    });
    const listed = join(at.work, 'secrets.env');
    writeFileSync(join(manager.path, '..', 'environment-files'), `${listed} (ignore_errors=no)\n`);
    const r = await withHost(at, HEALTHY_HOST, () => run(at, { systemctl: manager.path }));
    expect(r.out).toContain(`LONELY_SECRET is in setup's list of stored secrets and has no value in what doctor reads of the ` +
      `service's environment, but its unit also reads ${listed}, whose values doctor can't see, so whether the service has ` +
      'one isn\'t known.');
    expect(r.out).not.toContain('✗ LONELY_SECRET is in setup\'s list');
    expect(r.out).toMatch(/Doctor found no problem, though .*the files its unit reads its environment from weren't read/);
    const plain = install({ stored: ['DISCORD_TOKEN', 'SESSION_SERVER_TOKEN', 'LONELY_SECRET'], drop: ['LONELY_SECRET'] });
    const missing = await withHost(plain, HEALTHY_HOST, () => run(plain));
    expect(missing.out).toContain('✗ LONELY_SECRET is in setup\'s list of stored secrets');
  });

  test('a unit that reads an EnvironmentFile is said whatever doctor reads of the stored secrets, since the file\'s values come first', async () => {
    const at = install({ stored: ['DISCORD_TOKEN', 'SESSION_SERVER_TOKEN', 'LONELY_SECRET'] });
    const manager = fakeManager(at.work, {
      unit: Object.entries(unitEnvironment(at)).map(([name, value]) => `${name}=${value}`).join(' '),
    });
    const listed = join(at.work, 'secrets.env');
    writeFileSync(join(manager.path, '..', 'environment-files'), `${listed} (ignore_errors=no)\n`);
    const r = await withHost(at, HEALTHY_HOST, () => run(at, { systemctl: manager.path }));
    expect(r.out).toContain(`The service's unit also reads ${listed}, whose values doctor can't see. Where one sets a stored ` +
      'secret, the service gets that value, not the unit\'s own or .env\'s, so doctor neither checks nor hides it.');
    expect(r.out).not.toContain('LONELY_SECRET is in setup\'s list of stored secrets and has no value');
    expect(r.out).toMatch(/Doctor found no problem, though .*the files its unit reads its environment from weren't read/);
  });

  test('the dotenv files are read without the install root, as the launcher\'s Bun reads them, and the root is set after', async () => {
    const at = install();
    writeFileSync(join(at.work, '.env.local'), 'MODEL=claude-${CONNECTOME_INSTALL_ROOT:-root-unset}\n');
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).toContain('claude-root-unset');
    expect(r.out).not.toContain(`claude-${at.root}`);
  });

  test('a host that isn\'t the service\'s is said with how to find what starts it again, where systemd runs the service', async () => {
    const at = install();
    const r = await withHost(at, HEALTHY_HOST, () => run(at, { servicePid: async () => ({ pid: '5151' }) }));
    expect(r.out).toContain('`kill 4242` stops it. If something starts it again, `systemctl --user status 4242` names the unit ' +
      'it runs in, which is what to stop.');
  });

  test('a host the service\'s pid matches only once, or found while a service read as stopped starts or its pid can\'t be read, is said as changed, with no kill', async () => {
    const at = install();
    for (const second of ['4242', '6161']) {
      let asked = 0;
      const r = await withHost(at, HEALTHY_HOST, () => run(at, { servicePid: async () => ({ pid: ++asked === 1 ? '5151' : second }) }));
      expect(asked).toBe(2);
      expect(r.out).toContain('A host answers, pid 4242, recipe Ember, but the service\'s host changed during the check, so ' +
        'whether it\'s the service\'s can\'t be told: run doctor again.');
      expect(r.out).not.toContain('kill 4242');
      expect(r.out).not.toContain('✗ A host answers');
    }
    for (const answer of [{ pid: '4242' }, { pid: '6161' }, { why: 'systemctl --user show connectome-test.service failed' }]) {
      const started = await withHost(at, HEALTHY_HOST, () => run(at, {
        checkService: async () => ({ passed: true, lines: ['connectome-test.service is stopped: systemd shows it inactive (dead).'], stopped: true }),
        servicePid: async () => answer,
      }));
      expect(started.out).toContain('but the service\'s host changed during the check');
      expect(started.out).not.toContain('though the service is stopped');
    }
  });

  test('the closing line names a count that timed out or got an answer it couldn\'t read, and not one that got an answer', async () => {
    const count = (agent: string, compression: string) => ({
      ...HEALTHY_HOST,
      'count-check': {
        beside: STANDIN_BESIDE,
        agent: { model: 'claude-small-window', countModel: 'claude-small-window', source: agent },
        compression: { model: 'claude-old', countModel: 'claude-old', source: compression },
      },
    });
    const closing = (out: string): string => out.split('\n').filter((line) => line.trim() !== '').at(-1)!;
    for (const [agent, compression] of [['count_tokens_timeout', 'count_tokens'], ['count_tokens', 'count_tokens_error']]) {
      const at = install();
      const r = await withHost(at, count(agent!, compression!), () => run(at));
      expect(closing(r.out)).toContain('a count_tokens count got no answer it could read');
      expect(r.status).toBe(0);
    }
    const at = install();
    const answered = await withHost(at, count('count_tokens_failed_404', 'count_tokens'), () => run(at));
    expect(closing(answered.out)).not.toContain('a count_tokens count got no answer it could read');
  });

  test('the closing line names a subscription-gc-close line in failures.log that couldn\'t be read', async () => {
    const at = install();
    mkdirSync(join(at.work, 'logs'));
    writeFileSync(join(at.work, 'logs', 'failures.log'),
      '{"at":"2026-11-06T00:00:00.000Z","kind":"subscription-gc-close","channelId":"12\n');
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).toContain('A line there names a subscription-gc-close but can\'t be read as one');
    expect(r.out.split('\n').filter((line) => line.trim() !== '').at(-1)).toMatch(
      /^Doctor found no problem, though .*a line naming a channel the subscription GC closed couldn't be read/);
  });
});
