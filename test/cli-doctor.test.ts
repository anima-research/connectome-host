import { describe, test, expect, afterAll } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli/connectome.js';
import { doctor, type DoctorParts } from '../src/cli/doctor.js';

const SECRETS = {
  DISCORD_TOKEN: 'tok-secret-value',
  SESSION_SERVER_TOKEN: 'shell-secret-value',
  ANTHROPIC_API_KEY: 'sk-secret-key',
  LONELY_SECRET: 'lonely-secret-value',
};
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

interface Install { work: string; root: string; data: string }

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
  const work = mkdtempSync(join(tmpdir(), opts.prefix ?? 'chost-doctor-'));
  dirs.push(work);
  const root = join(work, 'connectome-host');
  const data = join(work, 'data');
  mkdirSync(root);
  mkdirSync(data);
  mkdirSync(join(work, '.setup'));
  writeFileSync(join(root, 'install.json'), JSON.stringify({ v: 1, dataDir: data, extraState: [] }));
  writeFileSync(join(root, 'service.json'), JSON.stringify({
    v: 1,
    manager: opts.manager ?? 'systemd-user',
    units: { host: { name: 'connectome-test.service', file: '/nowhere/connectome-test.service' } },
    hostArgs: [join(work, 'recipe.json')],
    workingDirectory: work,
    logs: { kind: 'journal' },
  }));
  const env: Record<string, string> = { ...SECRETS, ...opts.env };
  for (const name of opts.drop ?? []) delete env[name];
  writeFileSync(join(work, '.env'), Object.entries(env).map(([k, v]) => `${k}="${v}"`).join('\n') + '\n');
  writeFileSync(join(work, '.setup', 'stored-secrets.json'), JSON.stringify(opts.stored ?? ['DISCORD_TOKEN', 'SESSION_SERVER_TOKEN']));
  writeFileSync(join(work, 'recipe.json'), JSON.stringify(opts.recipe ?? RECIPE(work)));
  if (opts.overlay) writeFileSync(join(work, 'mcpl-servers.agent.json'), JSON.stringify({ mcplServers: opts.overlay }));
  return { work, root, data };
}

interface FakeHost { stop: () => void; received: string[] }

function fakeHost(at: Install, answers: Record<string, unknown>, opts: { closeOnRequest?: boolean } = {}): FakeHost {
  const received: string[] = [];
  const server = Bun.listen({
    unix: join(at.data, 'ipc.sock'),
    socket: {
      open(socket) {
        socket.write(JSON.stringify({ type: 'lifecycle', phase: 'ready', pid: 4242, dataDir: at.data, recipe: 'Ember' }) + '\n');
      },
      data(socket, chunk) {
        for (const line of chunk.toString().split('\n').filter(Boolean)) {
          const msg = JSON.parse(line) as { type: string; op?: string; corrId?: string };
          if (msg.type !== 'panel-request') continue;
          received.push(msg.op!);
          if (opts.closeOnRequest) {
            socket.end();
            return;
          }
          if (answers === SILENT) continue;
          const data = answers[msg.op!];
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

const COUNTED = {
  agent: { model: 'claude-small-window', countModel: 'claude-small-window', source: 'count_tokens' },
  compression: { model: 'claude-small-window', countModel: 'claude-small-window', source: 'count_tokens' },
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
    `case "$CONNECTOME_DOCTOR_WITHHOLD" in *${SECRETS.DISCORD_TOKEN}*) echo "ladder withholds DISCORD_TOKEN's value" ;; esac`,
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

function fakeManager(dir: string, opts: { env?: string[]; launchd?: Record<string, string>; fails?: string; hangs?: true } = {}) {
  const at = join(dir, `manager-${++managers}`);
  mkdirSync(join(at, 'values'), { recursive: true });
  writeFileSync(join(at, 'environment'), (opts.env ?? []).map((line) => `${line}\n`).join(''));
  for (const [name, value] of Object.entries(opts.launchd ?? {})) writeFileSync(join(at, 'values', name), `${value}\n`);
  const path = join(at, 'manager');
  writeFileSync(path, [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${join(at, 'calls')}`,
    ...(opts.hangs ? ['exec sleep 30'] : []),
    ...(opts.fails === undefined ? [] : [`echo '${opts.fails}' >&2`, 'exit 1']),
    `if [ "$*" = "--user show-environment" ]; then cat ${join(at, 'environment')}; exit 0; fi`,
    `if [ "$1" = getenv ] && [ $# -eq 2 ]; then if [ -f "${join(at, 'values')}/$2" ]; then cat "${join(at, 'values')}/$2"; fi; exit 0; fi`,
    'echo "unexpected: $*" >&2',
    'exit 2',
  ].join('\n') + '\n');
  chmodSync(path, 0o755);
  const calls = (): string[] => existsSync(join(at, 'calls'))
    ? readFileSync(join(at, 'calls'), 'utf-8').split('\n').filter(Boolean) : [];
  return { path, calls };
}

async function run(at: Install, parts: Partial<DoctorParts> = {}, argv: string[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  const manager = fakeManager(at.work).path;
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
  test('a healthy install: every whole check passes, the ladder runs with the data directory, the working directory and the unit, withholding the stored values, and the exit is 0', async () => {
    const at = install();
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).toContain('connectome-test.service is active');
    expect(r.out).toContain('pid 4242');
    expect(r.out).toContain('shell reached its daemon: 2 sessions.');
    expect(r.out).toContain('ember (900)');
    expect(r.out).toContain(`ladder args: --findings-json --data-dir ${at.data} ${at.work} connectome-test.service`);
    expect(r.out).toContain('ladder withholds DISCORD_TOKEN\'s value');
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

  test('a compression count refused for its credential names each the host may send and says to replace it', async () => {
    const at = install();
    const r = await withHost(at, {
      ...HEALTHY_HOST,
      'count-check': {
        agent: { model: 'claude-small-window', countModel: 'claude-small-window', source: 'count_tokens_failed_401' },
        compression: { model: 'claude-old', countModel: 'claude-old', source: 'count_tokens_failed_401' },
      },
    }, () => run(at));
    expect(r.out).toContain('✗ count_tokens couldn\'t count with the compression model, claude-old: count_tokens refused ' +
      'the credential the host sent (401): its subscription login when it has one, else ANTHROPIC_AUTH_TOKEN, else ' +
      'ANTHROPIC_API_KEY. Replace that credential where the service gets it, and restart the service.');
    expect(r.status).toBe(1);
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
    expect(asked[2]).toBe(true);
    expect(r.out).toContain(`It's stopped: \`${join(at.root, 'connectome')} service start\` starts it.`);
    expect(r.out).toContain('No host answers, since its service is stopped.');
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
      'count-check': {
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
    expect(lines.out).toMatch(/Doctor found no problem\.$/);
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
    expect(clean.out).toMatch(/Doctor found no problem\.$/);
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
    expect(r.out).toMatch(/✗ Bun exited 1 in .*<LONELY_SECRET>.* as it read the service's environment, and its error isn't shown, since it can hold \.env's values: run `bun -e 0` there to see it\./);
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
      expect(warned.join('\n')).not.toContain(SECRETS.DISCORD_TOKEN);
      expectNoSecret(r.out + r.err);
    } finally {
      console.warn = warn;
    }
  });

  test('a stored DISCORD_TOKEN that no server gets is told to be named in a server\'s env, the one place discord-mcpl reads it', async () => {
    const at = install({ stored: ['DISCORD_TOKEN'], recipe: { ...RECIPE(''), mcpServers: { shell: RECIPE('').mcpServers.shell } } });
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).toMatch(/✗ DISCORD_TOKEN is in setup's list of stored secrets, and no server gets it: .* Name it as "\$\{DISCORD_TOKEN\}" in the recipe entry of the server that needs it: in its env, as "DISCORD_TOKEN": "\$\{DISCORD_TOKEN\}"\. mcpl-servers\.json /);
    expect(r.out).not.toMatch(/DISCORD_TOKEN is in setup's list of stored secrets, and no server gets it[^\n]*or in its args/);
  });

  test('a secret setup stored that no server\'s env maps is a problem, the overlay\'s replacement included', async () => {
    const lonely = install({ stored: ['DISCORD_TOKEN', 'SESSION_SERVER_TOKEN', 'LONELY_SECRET'] });
    const r = await withHost(lonely, HEALTHY_HOST, () => run(lonely));
    expect(r.out).toMatch(/✗.*LONELY_SECRET/);
    expect(r.out).toMatch(/LONELY_SECRET is in setup's list of stored secrets, and no server gets it: no server the host starts is given it in its env or args, no server it dials names it in its token or url, and the recipe names it nowhere outside its servers\. Name it as "\$\{LONELY_SECRET\}" in the recipe entry of the server that needs it: in its env, as "LONELY_SECRET": "\$\{LONELY_SECRET\}", or in its args, or, for a server the host dials, in its token or url\. mcpl-servers\.json and the agent overlay take their values as written, with no \$\{…\} substituted\. For a server mcpl-servers\.json starts, a recipe entry can't set its env or args: move the server's definition out of mcpl-servers\.json into the recipe, or set "inheritEnv": true in its recipe entry, which hands it the host's whole environment, with LONELY_SECRET left out of the file's env, whose value would replace the host's\. An agent overlay entry replaces the recipe's and the file's, so the recipe can't reach a server the overlay defines while that entry is there: take the entry out of the overlay, put the server's definition, with its command or url, in the recipe, or in mcpl-servers\.json with a recipe entry that names it, and follow the steps above for whichever then defines it\. Then restart the service\./);
    expect(r.out).not.toMatch(/✗.*SESSION_SERVER_TOKEN/);
    expectNoSecret(r.out + r.err);
    expect(r.status).toBe(1);

    const shadowed = install({ overlay: { shell: { command: '/elsewhere/terminal-sessions-mcp', env: {} } } });
    const r2 = await withHost(shadowed, HEALTHY_HOST, () => run(shadowed));
    expect(r2.out).toMatch(/✗.*SESSION_SERVER_TOKEN/);
    expect(r2.status).toBe(1);
  });

  test('a DISCORD_TOKEN in .env that setup didn\'t store is withheld too, from doctor\'s lines and the ladder\'s reads', async () => {
    const at = install({ stored: ['SESSION_SERVER_TOKEN'] });
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).toContain('ladder withholds DISCORD_TOKEN\'s value');
    expect(r.out).toContain('<DISCORD_TOKEN>');
    expectNoSecret(r.out + r.err);
  });

  test('with no stored-secrets list, every value of a name setup doesn\'t know is hidden, as setup--run hides it, and doctor says why', async () => {
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
    expect(r.out).toContain('Doctor found no problem, though it couldn\'t check the stored secrets, as said above.');
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
      'problem, though the ladder didn\'t run and it couldn\'t check the stored secrets, as said above.');
    const worded = install({ env: { WORD: 'stored' } });
    rmSync(join(worded.work, '.setup', 'stored-secrets.json'));
    const plain = join(worded.work, 'python3-plain');
    writeFileSync(plain, ['#!/bin/sh', 'printf \'%s\\n\' \'connectome-doctor findings: []\'', 'exit 0'].join('\n'));
    chmodSync(plain, 0o755);
    expect((await withHost(worded, HEALTHY_HOST, () => run(worded, { python: plain }))).out).toContain('Doctor found no ' +
      'problem, though it couldn\'t check the <WORD> secrets, as said above. (it holds a value of `WORD`');
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

  test('a server given the host\'s whole environment (inheritEnv) sees every stored secret without a mapping', async () => {
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
    expect(r.out).toMatch(/✗.*LONELY_SECRET/);
    expect(r.out).toMatch(/✓.*SESSION_SERVER_TOKEN reaches shell/);
  });

  test('a stored secret mapped only as AGENT_TIMEZONE doesn\'t reach the server, since the host sets that variable over every server\'s', async () => {
    const at = install({
      stored: ['DISCORD_TOKEN', 'SESSION_SERVER_TOKEN', 'LONELY_SECRET'],
      recipe: { ...RECIPE(''), mcpServers: { ...RECIPE('').mcpServers, extra: { command: '/x/extra', env: { AGENT_TIMEZONE: '${LONELY_SECRET}' } } } },
    });
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).toMatch(/✗ LONELY_SECRET is in setup's list of stored secrets, and no server gets it/);
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
    expect(r.out).toMatch(/✗ WEBUI_TYPO is in setup's list of stored secrets, and no server gets it: .*, and the recipe names it nowhere outside its servers\./);
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
      expect(r.out).toMatch(/(✓ LONELY_SECRET reaches extra\.|✗ LONELY_SECRET is in setup's list of stored secrets, and no server gets it)/);
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
    expect(r3.out).toMatch(/✗ LONELY_SECRET is in setup's list of stored secrets, and no server gets it/);
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

  test('with no service recorded it says so, and the checks that need its recipe or its unit say why they didn\'t run', async () => {
    const at = install();
    rmSync(join(at.root, 'service.json'));
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).toMatch(/✗ No service is recorded/);
    expect(r.out).toContain('connectome service install');
    expect(r.out).toContain('Which recipe the service runs is in its record, so it isn\'t checked without one.');
    expect(r.out).toContain('The ladder reads the service\'s unit and log, so it runs once a service is recorded.');
    expect(r.out).not.toContain('ladder args');
    expect(r.out).not.toContain('ember (900)');
    expect(r.status).toBe(1);
  });

  test('a service record that can\'t be read is a problem naming how to write it again, and the ladder says why it didn\'t run', async () => {
    const at = install();
    writeFileSync(join(at.root, 'service.json'), '{ "v": 1 }');
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).toMatch(/✗.*service record.*connectome service install <recipe>/);
    expect(r.out).not.toContain('ladder args');
    expect(r.out).toMatch(/ladder .*record can't be read/);
    expect(r.out).toMatch(/Discord isn't checked: .*the service's record can't be read/);
    expect(r.status).toBe(1);
  });

  test('a service record that goes bad after the service check is a problem in words, and the checks after it are made', async () => {
    const at = install();
    const r = await run(at, {
      checkService: async () => {
        writeFileSync(join(at.root, 'service.json'), '{ "v": 1 }');
        return { passed: true, lines: [] };
      },
    });
    expect(r.out).toMatch(/✗ Reading the service record again failed: /);
    expect(r.out).toContain('ember (900)');
    expect(r.out).toContain('ladder args');
    expect(r.status).toBe(1);
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

  test('the shell\'s and the counts\' failures, and a server not connected, are each a problem in words', async () => {
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
      'count-check': {
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
    expect(r.out).toMatch(/✗ count_tokens couldn't count with claude-small-window: .*\. So the context's makeup shows no exact total\. A retired model answers 404, and the endpoint count_tokens asks \(Anthropic's API, or the one ANTHROPIC_BASE_URL names\) may answer it for a model it doesn't serve: set COUNT_TOKENS_MODEL in .*\.env to a current Claude model, and restart the service, since the host reads it when it starts\./);
    expect(r.out).toMatch(/✗.*claude-old.*folding stalls.*: change the recipe's agent\.strategy\.compressionModel to a current model and restart the service\. The endpoint count_tokens asks \(Anthropic's API, or the one ANTHROPIC_BASE_URL names\) may answer 404 for a model it doesn't serve too, and then the 404 doesn't mean it's retired\./);
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
        'count-check': { agent, compression: { model: 'claude-old', countModel: 'claude-old', source: 'count_tokens_failed_404' } },
      }, () => run(at));
      expect(r.out).toMatch(/✗ count_tokens couldn't count with the compression model, claude-old: .*: change the recipe's agent\.strategy\.compressionModel to a current model.* and restart the service\./);
      got.push([what, r.out.includes('or leave it out to compress with the agent\'s model,')]);
    }
    expect(got).toEqual(cases.map(([what, , offered]) => [what, offered]));
  });

  test('a count refused for its credential names each the host may send, and an empty compression model is a problem', async () => {
    const at = install();
    const r = await withHost(at, {
      ...HEALTHY_HOST,
      'count-check': {
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
      'count-check': { agent: { model: 'claude-small-window', countModel: 'claude-small-window', source: 'count_tokens_error' }, compression: null },
    }, () => run(at));
    expect(r.out).toMatch(/✗ count_tokens couldn't count with claude-small-window: the count_tokens request failed, didn't answer within 30 s, or answered with what couldn't be read\./);

    const none = install();
    const r2 = await withHost(none, {
      ...HEALTHY_HOST,
      'count-check': { agent: { model: null, countModel: null, source: 'count_tokens_unsupported_model' }, compression: null },
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
    expect(r.out).toMatch(/older release/);
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
    await uncounted(COUNTED, 'the running host doesn\'t count them: it\'s an older release than this command');
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
    expect(r.received).toEqual(['count-check', 'shell-check']);
    expect(r.out).toMatch(/✗.*didn't answer the token counts within 0\.3 s/);
    expect(r.out).toMatch(/✗.*didn't answer the shell's call/);
    expect(r.out).toContain('ember (900)');
    expect(r.status).toBe(1);
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
    expect(r.out).toMatch(/Doctor found no problem, though the ladder didn't run, as said above\.$/);
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
    expect(r.out).toMatch(/Doctor found no problem, though the ladder didn't run, as said above\.$/);
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
    expect(manager.calls()).toEqual(['--user show-environment']);
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
      const given = fakeManager(at.work, { env: ['CONNECTOME_SUPERVISED=0'], launchd: { CONNECTOME_SUPERVISED: '0' } });
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

  test('the manager the service record names is asked, and no other: none without a record', async () => {
    const none = install();
    rmSync(join(none.root, 'service.json'));
    const unasked = fakeManager(none.work);
    await run(none, { systemctl: unasked.path, launchctl: unasked.path });
    expect(unasked.calls()).toEqual([]);
    const launchd = install({ manager: 'launchd' });
    const asked = fakeManager(launchd.work);
    await run(launchd, { systemctl: asked.path, launchctl: asked.path });
    expect(asked.calls().length).toBeGreaterThan(0);
    expect(asked.calls().every((call) => call.startsWith('getenv '))).toBe(true);
    const systemd = install();
    const user = fakeManager(systemd.work);
    await run(systemd, { systemctl: user.path, launchctl: user.path });
    expect(user.calls()).toEqual(['--user show-environment']);
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
      const record = JSON.parse(readFileSync(join(at.root, 'service.json'), 'utf-8'));
      writeFileSync(join(at.root, 'service.json'), JSON.stringify({ ...record, hostArgs: [url] }));
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
    expect(stopped.out).toMatch(/Doctor found no problem, though the host's checks weren't made, as said above\.$/);
    expect(stopped.status).toBe(0);
    const unladdered = await run(at, {
      checkService: async () => ({ passed: true, lines: ['connectome-test.service is stopped.'], stopped: true }),
      python: null,
    });
    expect(unladdered.out).toMatch(/Doctor found no problem, though the host's checks weren't made and the ladder didn't run, as said above\.$/);
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
      'counted (the recipe doesn\'t load now as it did for the running host, as an edit since its start can leave it), so ' +
      'this is the check the host makes at load, by estimate.');
    expect(r.out).not.toContain('to spare');
  });
});
