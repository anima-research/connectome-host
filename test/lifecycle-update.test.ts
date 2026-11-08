import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostModeStatus, ModuleContext, ToolResult } from '@animalabs/agent-framework';
import { LifecycleModule } from '../src/modules/lifecycle-module.js';
import { SELF_RESTART_FILE, SelfRestartState } from '../src/self-restart.js';
import { appendJournal, copyLabelPath, installPaths, moveCurrent, readMark, realOrResolved } from '../src/update/contract.js';
import type { InstallOps } from '../src/update/install.js';
import { RELEASE_HOST, shellWord } from '../src/update/launcher.js';
import type { SwitchFleet, SwitchRequest } from '../src/update/quiesce.js';
import { HostUpdate, type SwitchFramework } from '../src/update/update.js';
import { COMMAND_WAYS, PAGE_WAYS, cliWays, statusLines } from '../src/web/update-text.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function placeRelease(root: string, version: string): void {
  const release = join(root, 'releases', version);
  const host = join(release, RELEASE_HOST);
  mkdirSync(join(host, 'src', 'update'), { recursive: true });
  writeFileSync(join(release, 'package.json'), JSON.stringify({ dependencies: { '@animalabs/connectome-host': version } }));
  writeFileSync(join(host, 'package.json'), JSON.stringify({ version }));
  writeFileSync(join(host, 'src', 'index.ts'), '');
  writeFileSync(join(host, 'src', 'update', 'launcher.ts'), 'export function launch() {}');
}

function installRunning0141(others: string[] = []): { root: string; dataDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'lifecycle-update-'));
  dirs.push(root);
  for (const version of ['0.14.1', ...others]) placeRelease(root, version);
  moveCurrent(root, '0.14.1');
  const dataDir = join(root, 'data');
  mkdirSync(dataDir);
  return { root, dataDir };
}

function placeCopyOf0140(root: string, dataDir: string): void {
  const { copy } = installPaths(root);
  mkdirSync(join(copy, '0-data'), { recursive: true });
  placeRelease(root, '0.14.0');
  writeFileSync(copyLabelPath(copy), JSON.stringify({
    v: 1, from: '0.14.0', at: '2026-10-20T10:00:00.000Z', items: [{ path: realOrResolved(dataDir), name: '0-data' }], mark: 'm-0',
  }));
}

function framework(
  holders: string[], scripts: { count: number }, statusFails = { next: false },
  servers = [{ id: 'discord', connected: true }, { id: 'zulip', connected: false }],
) {
  const calls: string[] = [];
  const waits: Array<number | undefined> = [];
  let mode: { quiesced: boolean; reason?: string } = { quiesced: false };
  const status = (): HostModeStatus => {
    if (statusFails.next) { statusFails.next = false; throw new Error('the host\'s status couldn\'t be read'); }
    return statusOf();
  };
  const statusOf = (): HostModeStatus => ({
    ...mode, drained: holders.length === 0, activeTurns: holders.length, parkedAdmissions: 0, gatedRequests: 0,
    backgroundScripts: scripts.count, deferredWrites: 0, activeTurnAgents: holders,
  }) as HostModeStatus;
  const fw: SwitchFramework = {
    quiesce: async (opts = {}) => {
      calls.push('quiesce');
      waits.push(opts.timeoutMs);
      if (!mode.quiesced) mode = { quiesced: true, reason: opts.reason };
      return statusOf();
    },
    resume: async () => { calls.push('resume'); mode = { quiesced: false }; return statusOf(); },
    getHostModeStatus: status,
    listMcplServers: () => servers.map((server) => ({ ...server })),
  };
  return { fw, calls, waits, serving: () => !mode.quiesced, servers };
}

function heldManager(status = 0) {
  let asked = false;
  let finish: () => void = () => { asked = true; };
  const ops: InstallOps = {
    run: (_name, args, cwd) => new Promise((done) => {
      finish = () => {
        if (status === 0) {
          const version = args.at(-1)!.split('@').at(-1)!;
          const host = join(cwd, RELEASE_HOST);
          mkdirSync(join(host, 'src', 'update'), { recursive: true });
          writeFileSync(join(host, 'package.json'), JSON.stringify({ version }));
          writeFileSync(join(host, 'src', 'index.ts'), '');
          writeFileSync(join(host, 'src', 'update', 'launcher.ts'), '');
        }
        done({ status, output: status === 0 ? '' : 'npm error 404 Not Found' });
      };
      if (asked) finish();
    }),
    report: () => {},
  };
  return { ops, finish: () => finish() };
}

type Costs = Record<string, { breaking: boolean; cacheWrite: boolean }>;
const registry = (versions: string[], costs: Costs = {}, bunFloor?: string) => (async () => new Response(JSON.stringify({
  name: '@animalabs/connectome-host',
  versions: Object.fromEntries(versions.map((v) => [v, {
    connectomeRelease: costs[v] ?? { breaking: false, cacheWrite: false },
    ...(bunFloor !== undefined && v !== '0.14.1' ? { engines: { bun: bunFloor } } : {}),
  }])),
}))) as unknown as typeof fetch;

function fleetChild(state: {
  busy: boolean; resumes?: boolean; held?: Promise<void>; resumeHeld?: Promise<void>; scripts?: number; afterLook?: () => void;
  operator?: { reason?: string; fromLook: number }; inFlight?: unknown;
}) {
  const child = { quiesced: false, waits: [] as number[], looks: 0 };
  const fleet: SwitchFleet = {
    runningChildren: () => [{ name: 'kid' }],
    requestSwitch: async (_name, request: SwitchRequest) => {
      if (request.op === 'resume') {
        await state.resumeHeld;
        if (state.resumes === false) return { ok: false, error: 'the socket closed' };
        child.quiesced = false;
        return { ok: true, data: { resumed: true } };
      }
      child.quiesced = true;
      child.waits.push(request.waitMs);
      child.looks += 1;
      await state.held;
      state.afterLook?.();
      const operator = state.operator !== undefined && child.looks >= state.operator.fromLook
        ? { operatorHold: state.operator.reason === undefined ? {} : { reason: state.operator.reason } } : {};
      return { ok: true, data: {
        answered: true, drained: !state.busy, activeTurnAgents: state.busy ? ['kid-agent'] : [], backgroundScripts: state.scripts ?? 0,
        ...operator, ...(state.inFlight !== undefined ? { inFlight: state.inFlight } : {}),
      } };
    },
  };
  return { fleet, child };
}

function residentHost(options: {
  root: string | null; dataDir?: string; supervisedLine?: boolean; holders?: string[]; scripts?: number;
  mode?: 'service' | 'terminal'; versions?: string[]; costs?: Costs; installOps?: InstallOps;
  grants?: { selfRestart?: boolean; selfUpdate?: boolean }; state?: SelfRestartState; fleet?: SwitchFleet;
  clock?: { now: number }; retryMs?: number; stopping?: () => boolean; noStop?: boolean; registryDown?: boolean;
  log?: (line: string) => void; installCommand?: string; bunFloor?: string;
}) {
  const stops: string[] = [];
  const holders = [...(options.holders ?? [])];
  const scripts = { count: options.scripts ?? 0 };
  const statusFails = { next: false };
  const { fw, calls, waits, serving, servers } = framework(holders, scripts, statusFails);
  const session = { fw };
  const update = new HostUpdate();
  update.configure({
    here: options.root === null ? null : { root: options.root, release: '0.14.1' },
    running: '0.14.1',
    host: { framework: () => session.fw, fleet: () => options.fleet ?? null },
    headless: (options.mode ?? 'service') === 'service',
    env: options.supervisedLine === false ? {} : { CONNECTOME_SUPERVISED: '1' },
    bun: '1.4.4',
    fetchManifest: options.registryDown
      ? (async () => { throw new Error('the registry is unreachable'); }) as unknown as typeof fetch
      : registry(options.versions ?? ['0.14.1', '0.15.0'], options.costs, options.bunFloor),
    ...(options.installOps ? { installOps: options.installOps } : {}),
    now: () => new Date(options.clock?.now ?? Date.parse('2026-10-26T20:00:00.000Z')),
    log: options.log ?? (() => {}),
    waits: { restartMs: 50, longerMs: 70, ...(options.retryMs !== undefined ? { armedRetryMs: options.retryMs } : {}) },
  });
  if (!options.noStop) update.attachStop({
    supervised: (options.mode ?? 'service') === 'service',
    stop: (reason) => { stops.push(reason); },
    ...(options.stopping ? { stopping: options.stopping } : {}),
  });
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'lifecycle-update-data-'));
  if (options.dataDir === undefined) dirs.push(dataDir);
  const module = new LifecycleModule({
    dataDir, update, now: () => new Date('2026-10-26T20:00:00.000Z'), hostVersion: '0.14.1',
    headless: (options.mode ?? 'service') === 'service',
    state: options.state ?? new SelfRestartState(), ...(options.grants ?? { selfUpdate: true }),
    ...(options.installCommand !== undefined ? { installCommand: options.installCommand }
      : options.root !== null ? { installCommand: 'connectome' } : {}),
  });
  const call = (input: Record<string, unknown>, name = 'update'): Promise<ToolResult> =>
    module.handleToolCall({ id: `call-${Math.random()}`, name, input, callerAgentName: 'resident' });
  const armed = async (input: Record<string, unknown> = { action: 'restart' }) => {
    const answer = await call(input);
    expect(answer.success).toBe(true);
    expect(update.armedSwitch()).not.toBeNull();
  };
  const switchSession = () => { session.fw = framework([], { count: 0 }).fw; };
  return {
    update, module, call, armed, stops, calls, waits, serving, holders, scripts, dataDir, fw, switchSession, statusFails,
    servers,
  };
}

const text = (result: ToolResult): string => String(result.success ? result.data : result.error);
const QUIET = 'first quiet moment, once nothing the host counts as in flight is still going here, such as a turn, ' +
  'subagent run, background script, session switch, operator\'s work or credential action, and each fleet child says ' +
  'nothing is going there, such as a turn, background script, operator\'s work or credential action';
const RETRY = 'A try that finds something still going waits at least a minute before the next.';
const alwaysQuiet = () => true;

async function until(done: () => boolean): Promise<void> {
  for (const end = Date.now() + 10_000; !done(); await new Promise((r) => setTimeout(r, 5))) {
    if (Date.now() > end) throw new Error('what the test waited for never happened');
  }
}

test('the update tool is listed only when its grant is on, beside the restart tool only when that grant is on', () => {
  const names = (grants: { selfRestart?: boolean; selfUpdate?: boolean }) =>
    residentHost({ root: null, grants }).module.getTools().map((t) => t.name);
  expect(names({ selfRestart: true, selfUpdate: false })).toEqual(['restart']);
  expect(names({ selfRestart: false, selfUpdate: true })).toEqual(['update']);
  expect(names({ selfRestart: true, selfUpdate: true })).toEqual(['restart', 'update']);
});

for (const [what, options, says] of [
  ['without CONNECTOME_SUPERVISED=1 at its start', { supervisedLine: false }, ['Ask whoever runs your host for a service that ' +
    'starts it again when it stops, such as one `connectome service install` writes; docs/DEPLOYMENTS.md says what one needs.']],
  ['run in a terminal, whatever its environment', { mode: 'terminal' as const }, ['terminal', 'headless']],
] as const) {
  test(`on a host ${what}, restart and back refuse, saying what a restart needs and that asking again won't help, and arm nothing`, async () => {
    const { root, dataDir } = installRunning0141(['0.15.0']);
    placeCopyOf0140(root, dataDir);
    const host = residentHost({ root, ...options });
    for (const input of [{ action: 'restart' }, { action: 'back', data: 'keep' }]) {
      const answer = await host.call(input);
      expect(answer.success).toBe(false);
      for (const words of [...says, 'connectome service install', 'Asking again']) expect(text(answer)).toContain(words);
      expect(text(answer)).not.toContain('exits with');
    }
    expect(host.update.armedSwitch()).toBeNull();
    expect(text(await host.call({ action: 'check' }))).not.toContain('armed');
    expect(host.stops).toEqual([]);
  });
}

const toolDescription = (host: ReturnType<typeof residentHost>): string =>
  (host.module.getTools().find((tool) => tool.name === 'update')?.description ?? '').replace(/\s+/g, ' ');

const HEADLESS_COMMANDS = 'They type it in a shell, as the user your host runs as: check is `connectome update check`, ' +
  'install is `connectome update install`, restart is `connectome update restart`, and back is `connectome update back`, ' +
  'then `connectome update back keep` or `connectome update back restore`. Their restart and back begin at once, ' +
  'without waiting for a quiet moment: new turns are held, turns in progress get up to 2 min to end, and if any don\'t, ' +
  'their command says who is still busy and how to wait longer, stop now or call it off. notes and cancel have no ' +
  'command of theirs: their check gives them a link to the notes, and only your cancel disarms a restart or Go back you asked for, though their own restart or back ' +
  'goes ahead in its place.';

for (const [kind, options] of [
  ['headless with an install', {}],
  ['headless with no install of its own', { root: null }],
  ['run in a terminal', { mode: 'terminal' as const }],
] as const) {
  test(`on a host ${kind}, the update tool's description holds what choosing an action needs, in at most 1,600 characters`, () => {
    const root = 'root' in options ? null : installRunning0141(['0.15.0']).root;
    const description = toolDescription(residentHost({ ...options, root }));
    expect(description.length).toBeLessThanOrEqual(1_600);
    for (const words of ['- check:', '- notes:', '- install:', '- restart:', '- back:', '- cancel:', 'so you lose nothing',
      'set aside, not deleted', '`version`', 'CONNECTOME_SUPERVISED=1', 'nothing tells you it happened: check says',
      'The person who runs your host can\'t call this tool']) {
      expect(description).toContain(words);
    }
    for (const words of ['SIGKILL', '2 min', 'operator\'s work or credential action']) expect(description).not.toContain(words);
  });
}

test('on a headless host, the update tool names the person\'s own command, and check says how they type each action and what theirs do', async () => {
  const { root } = installRunning0141(['0.15.0']);
  const host = residentHost({ root });
  expect(toolDescription(host)).toContain('so never give them its name to type: their own command is `connectome update`, ' +
    'typed in a shell, and check says how they use it.');
  expect(toolDescription(host)).not.toContain('/update');
  const check = text(await host.call({ action: 'check' }));
  expect(check).toContain(`The person who runs your host updates it with their own command, not this tool. ${HEADLESS_COMMANDS}`);
  expect(check).not.toContain('/update');
});

test('on a headless host with no install of its own, the update tool names no command of the person\'s, and check says how such a host is updated', async () => {
  const host = residentHost({ root: null });
  expect(toolDescription(host)).toContain('This host has no command of theirs to update it: check says how it\'s updated.');
  expect(toolDescription(host)).not.toContain('connectome update');
  expect(text(await host.call({ action: 'check' }))).toContain('This host runs headless with no install of its own, so it ' +
    'has no command of theirs to update it: a fleet child is updated with its parent\'s install where its parent has one, ' +
    'and any other host by hand (docs/DEPLOYMENTS.md, "Updating an install"), and your restart and back refuse here, ' +
    'saying so.');
});

test('on a host run in a terminal, the update tool names the person\'s /update, and check says how they type each action there and what theirs do', async () => {
  const { root } = installRunning0141(['0.15.0']);
  const host = residentHost({ root, mode: 'terminal' });
  expect(toolDescription(host)).toContain('so never give them its name to type: their own command is `/update`, typed in the ' +
    'host\'s terminal, and check says how they use it.');
  expect(toolDescription(host)).not.toContain('connectome update');
  expect(text(await host.call({ action: 'check' }))).toContain('The person who runs your host updates it with their own ' +
    'command, not this tool. They type it in the host\'s terminal: check is `/update check`, install is `/update install`, ' +
    'restart is `/update restart`, and back is `/update back`, then `/update back keep` or `/update back restore`. ' +
    '`connectome update` in another shell doesn\'t reach this host. Their restart and back begin at once, without waiting ' +
    'for a quiet moment: new turns are held, turns in progress get up to 2 min to end, and if any don\'t, its answer says ' +
    'who is still busy and how to wait longer, stop now or call it off. Once it stops, they start the host again ' +
    'themselves, and that start switches. notes and cancel have no command of theirs: their check gives them a link ' +
    'to the notes, and only your cancel disarms a ' +
    'restart or Go back you asked for, though their own restart or back goes ahead in its place.');
});

test('on a host started from an install, the update tool and check name the person\'s commands by the install\'s own command', async () => {
  const { root } = installRunning0141(['0.15.0']);
  const typed = shellWord('/opt/x y/connectome');
  const host = residentHost({ root, holders: ['alice'], installCommand: typed });
  expect(toolDescription(host)).toContain(`their own command is \`${typed} update\``);
  expect(toolDescription(host)).not.toContain('`connectome update');
  const check = text(await host.call({ action: 'check' }));
  expect(check).toContain(`check is \`${typed} update check\`, install is \`${typed} update install\``);
  expect(check).not.toContain('`connectome update');
  await host.update.restartToInstalled();
  expect(text(await host.call({ action: 'check' }))).toContain(`the person's ${typed} update restart wait, the person's ` +
    `${typed} update restart now or the person's ${typed} update restart resume.`);
  await host.update.resume();
});

test('when the newest release needs a newer Bun, the update tool says the person who runs the host upgrades it, where /update says to', async () => {
  const { root } = installRunning0141();
  const host = residentHost({ root, bunFloor: '>=1.5.0' });
  const install = await host.call({ action: 'install' });
  expect(install.success).toBe(false);
  expect(text(install)).toContain('0.15.0 needs Bun >=1.5.0, and this host runs on Bun 1.4.4, so nothing was installed. ' +
    'Only the person who runs your host can upgrade its Bun (`bun upgrade`, or the package manager that installed it) ' +
    'and start the host again; then lifecycle--update install can install it.');
  expect(text(install)).not.toContain('Upgrade Bun');
  expect(text(await host.call({ action: 'check' }))).toContain('0.15.0 needs Bun >=1.5.0: the person who runs your host ' +
    'upgrades Bun first, and lifecycle--update install installs nothing until then.');
  expect((await host.update.install()).lines.join('\n')).toContain('so nothing was installed. Upgrade Bun (`bun upgrade`, ' +
    'or the package manager that installed it), start the host again, then /update install.');
});

test('on a host with no install, the update tool says nothing the agent calls changes that, where /update tells the person how', async () => {
  const host = residentHost({ root: null });
  for (const input of [{ action: 'check' }, { action: 'notes' }, { action: 'install' }]) {
    const said = text(await host.call(input));
    expect(said).toContain('started through an install\'s entry point, so it can\'t update itself. Nothing you call ' +
      'changes that: only the person who runs your host can, by making it an install with setup or by updating it by hand.');
    expect(said).not.toContain('src/update/setup.ts');
  }
  expect((await host.update.install()).lines.join('\n')).toContain('src/update/setup.ts');
});

for (const [mode, typed] of [['service', 'connectome update restart'], ['terminal', '/update restart']] as const) {
  test(`check names an operator's waiting Restart's wait, now and resume as the person types them on a ${mode} host`, async () => {
    const { root } = installRunning0141(['0.15.0']);
    const host = residentHost({ root, holders: ['alice'], mode });
    await host.update.restartToInstalled();
    expect(text(await host.call({ action: 'check' }))).toContain(`the person's ${typed} wait, the person's ${typed} now or ` +
      `the person's ${typed} resume.`);
    await host.update.resume();
  });
}

test('restart answers at once, says it waits for the host to be quiet and how to cancel, and check shows it armed', async () => {
  const { root } = installRunning0141(['0.15.0']);
  const host = residentHost({ root });
  const answer = await host.call({ action: 'restart' });
  expect(answer.success).toBe(true);
  for (const words of ['0.15.0', 'quiet', QUIET, 'cancel', 'check', RETRY]) expect(text(answer)).toContain(words);
  expect(text(answer)).toContain('If the host stops for any other reason first, nothing stays armed, and from its next ' +
    'start check says the restart didn\'t go ahead, with that stop as the reason, though a crash, a forced kill (SIGKILL) ' +
    'or a record the host can\'t write leaves no word of it. An operator\'s own Restart or Go back also takes its place.');
  expect(toolDescription(host)).toContain('first quiet moment');
  for (const words of [QUIET, RETRY, 'SIGKILL']) expect(toolDescription(host)).not.toContain(words);
  expect(host.stops).toEqual([]);
  expect(readMark(root)).toBeNull();
  const check = text(await host.call({ action: 'check' }));
  expect(check).toContain('armed');
  expect(check).toContain('2026-10-26T20:00:00.000Z');
  expect(check).toContain(QUIET);
  expect(check).toContain(RETRY);
});

test('restart or back naming another release than the one they would go to arms nothing, and says how to see and get it', async () => {
  const { root, dataDir } = installRunning0141(['0.15.0']);
  placeCopyOf0140(root, dataDir);
  const host = residentHost({ root, dataDir });
  const restart = await host.call({ action: 'restart', version: '0.16.0' });
  expect(restart.success).toBe(false);
  for (const words of ['0.15.0', 'lifecycle--update check', 'lifecycle--update install']) expect(text(restart)).toContain(words);
  const back = await host.call({ action: 'back', data: 'keep', version: '0.13.0' });
  expect(back.success).toBe(false);
  expect(text(back)).toContain('0.14.0');
  expect(text(back)).toContain('lifecycle--update check');
  expect(host.update.armedSwitch()).toBeNull();
});

test('at the host\'s first quiet moment, an armed restart writes the switch to the installed release and stops the host', async () => {
  const { root } = installRunning0141(['0.15.0']);
  const host = residentHost({ root });
  await host.armed({ action: 'restart', version: '0.15.0' });
  host.servers.push({ id: 'matrix', connected: true });
  expect((await host.update.runArmed(alwaysQuiet)).done).toBe(true);
  expect(readMark(root)).toMatchObject({ to: '0.15.0', why: 'update', connected: ['discord', 'matrix'] });
  expect(host.stops).toHaveLength(1);
  expect(host.update.armedSwitch()).toBeNull();
});

test('a stop before an armed restart begins is kept for the next start, whose check says it didn\'t go ahead, with the stop as the reason, once', async () => {
  const { root } = installRunning0141(['0.15.0']);
  const host = residentHost({ root });
  await host.armed({ action: 'restart', version: '0.15.0' });
  const since = host.update.armedSwitch()!.since;
  expect(host.update.recordStop('SIGTERM'))
    .toBe(`A restart onto 0.15.0 armed at ${since} is dropped by this stop, and the next start's check says so.`);
  const next = residentHost({ root });
  expect(text(await next.call({ action: 'check' }))).toContain(
    `A restart onto 0.15.0 armed at ${since} didn't go ahead at 2026-10-26T20:00:00.000Z: the host stopped first (SIGTERM).`);
  expect(existsSync(installPaths(root).armedDropped)).toBe(false);
  expect(residentHost({ root }).update.status().armedDropped).toBeNull();
});

test('a stop with nothing armed, or the switch\'s own stop, keeps nothing for the next start', async () => {
  const { root } = installRunning0141(['0.15.0']);
  const host = residentHost({ root });
  expect(host.update.recordStop('SIGTERM')).toBeNull();
  await host.armed({ action: 'restart', version: '0.15.0' });
  expect((await host.update.runArmed(alwaysQuiet)).done).toBe(true);
  expect(host.update.recordStop('update: switch to 0.15.0')).toBeNull();
  expect(existsSync(installPaths(root).armedDropped)).toBe(false);
});

test('a dropped arm whose record can\'t be written is a line to log, and a record the next start can\'t read is a line in its log and nothing in check', async () => {
  const { root } = installRunning0141(['0.15.0']);
  const host = residentHost({ root });
  await host.armed({ action: 'restart', version: '0.15.0' });
  chmodSync(root, 0o500);
  let line: string | null;
  try {
    line = host.update.recordStop('SIGINT');
  } finally {
    chmodSync(root, 0o700);
  }
  expect(line).toMatch(/is dropped by this stop, and the record of that for the next start couldn't be written: /);
  for (const garbled of ['{"to": "0.15.0", "why": "sideways"', '{"to": "0.15.0", "why": "sideways"}']) {
    writeFileSync(installPaths(root).armedDropped, garbled);
    const logged: string[] = [];
    expect(residentHost({ root, log: (said) => { logged.push(said); } }).update.status().armedDropped).toBeNull();
    expect(existsSync(installPaths(root).armedDropped)).toBe(false);
    expect(logged.filter((said) => said.includes(installPaths(root).armedDropped))).toHaveLength(1);
  }
  mkdirSync(installPaths(root).armedDropped);
  const logged: string[] = [];
  expect(residentHost({ root, log: (said) => { logged.push(said); } }).update.status().armedDropped).toBeNull();
  expect(logged.filter((said) => said.includes(installPaths(root).armedDropped))).toHaveLength(1);
});

test('a dropped arm\'s record the next start can\'t remove is still reported, and its log says a later start may report it again', async () => {
  const { root } = installRunning0141(['0.15.0']);
  const host = residentHost({ root });
  await host.armed({ action: 'restart', version: '0.15.0' });
  host.update.recordStop('SIGTERM');
  const logged: string[] = [];
  chmodSync(root, 0o500);
  let next: ReturnType<typeof residentHost>;
  try {
    next = residentHost({ root, log: (said) => { logged.push(said); } });
  } finally {
    chmodSync(root, 0o700);
  }
  expect(next.update.status().armedDropped).toMatchObject({ to: '0.15.0', reason: 'the host stopped first (SIGTERM).' });
  expect(existsSync(installPaths(root).armedDropped)).toBe(true);
  expect(logged.filter((said) => said.includes(installPaths(root).armedDropped))).toHaveLength(1);
});

test('an arm asked for once the host has begun stopping is refused, and nothing is armed', async () => {
  const { root } = installRunning0141(['0.15.0']);
  const host = residentHost({ root, stopping: () => true });
  const answer = await host.call({ action: 'restart' });
  expect(answer.success).toBe(false);
  expect(text(answer)).toStartWith('Nothing was armed: ');
  expect(text(answer)).toContain('stopping');
  expect(host.update.armedSwitch()).toBeNull();
});

test('when a try finds a turn still going, without waiting for it, nothing switches, serving resumes, nobody is asked, and a later quiet moment goes ahead', async () => {
  const { root } = installRunning0141(['0.15.0']);
  const host = residentHost({ root, holders: ['other-agent'] });
  await host.armed();
  const answer = await host.update.runArmed(alwaysQuiet);
  expect(host.waits).toEqual([0]);
  expect(answer.done).toBe(false);
  expect(answer.lines.join(' ')).toContain('stays armed');
  expect(answer.lines.join(' ')).not.toContain('/update restart');
  expect(readMark(root)).toBeNull();
  expect(host.stops).toEqual([]);
  expect(host.serving()).toBe(true);
  expect(host.update.status().restart).toBeNull();
  expect(host.update.armedSwitch()).not.toBeNull();
  const check = text(await host.call({ action: 'check' }));
  for (const words of ['armed', 'turns were still going', 'other-agent']) expect(check).toContain(words);
  expect(check).not.toContain('/update restart');
  host.holders.splice(0);
  await host.update.runArmed(alwaysQuiet);
  expect(readMark(root)).toMatchObject({ to: '0.15.0', why: 'update' });
  expect(host.stops).toHaveLength(1);
});

test('a script running outside any turn, or work the host takes on again, keeps the restart armed rather than ending it', async () => {
  const { root } = installRunning0141(['0.15.0']);
  const host = residentHost({ root, scripts: 1 });
  await host.armed();
  await host.update.runArmed(alwaysQuiet);
  expect(readMark(root)).toBeNull();
  expect(host.serving()).toBe(true);
  expect(text(await host.call({ action: 'check' }))).toContain('scripts were running outside any turn');
  host.scripts.count = 0;
  let quiet = false;
  await host.update.runArmed(() => quiet);
  expect(readMark(root)).toBeNull();
  expect(text(await host.call({ action: 'check' }))).toContain('work in flight again');
  quiet = true;
  await host.update.runArmed(() => quiet);
  expect(readMark(root)).toMatchObject({ to: '0.15.0' });
});

test('a fleet child still busy at a quiet moment, asked without a wait, keeps the restart armed and is serving again after, and this host is never quiesced for it', async () => {
  const { root } = installRunning0141(['0.15.0']);
  const state = { busy: true };
  const { fleet, child } = fleetChild(state);
  const host = residentHost({ root, fleet });
  await host.armed();
  await host.update.runArmed(alwaysQuiet);
  expect(host.calls).toEqual([]);
  expect(child.quiesced).toBe(false);
  expect(host.update.armedSwitch()).not.toBeNull();
  expect(readMark(root)).toBeNull();
  const check = text(await host.call({ action: 'check' }));
  expect(check).toContain('kid');
  expect(check).toContain('kid-agent');
  state.busy = false;
  await host.update.runArmed(alwaysQuiet);
  expect(readMark(root)).toMatchObject({ to: '0.15.0' });
  expect(host.stops).toHaveLength(1);
  expect([...new Set(child.waits)]).toEqual([0]);
  expect(host.waits).toEqual([0]);
});

test('a fleet child with a script running outside any turn keeps the restart armed, and check says so', async () => {
  const { root } = installRunning0141(['0.15.0']);
  const { fleet, child } = fleetChild({ busy: false, scripts: 1 });
  const host = residentHost({ root, fleet });
  await host.armed();
  await host.update.runArmed(alwaysQuiet);
  expect(readMark(root)).toBeNull();
  expect(child.quiesced).toBe(false);
  expect(host.update.armedSwitch()).not.toBeNull();
  const check = text(await host.call({ action: 'check' }));
  expect(check).toContain('scripts were running outside any turn');
  expect(check).toContain('- kid: 1 background script running outside any turn');
});

test('a fleet child with a credential action in flight keeps the restart armed, and check names that work', async () => {
  const { root } = installRunning0141(['0.15.0']);
  const { fleet, child } = fleetChild({ busy: false, inFlight: ['a credential action'] });
  const host = residentHost({ root, fleet });
  await host.armed();
  expect((await host.update.runArmed(alwaysQuiet)).done).toBe(false);
  expect(readMark(root)).toBeNull();
  expect(host.stops).toEqual([]);
  expect(child.quiesced).toBe(false);
  expect(host.update.armedSwitch()).not.toBeNull();
  const check = text(await host.call({ action: 'check' }));
  expect(check).toContain('a fleet child had work going outside any turn');
  expect(check).toContain('- kid: a credential action');
});

test('a fleet child whose answer names its work in flight unreadably keeps the restart armed, and check says so', async () => {
  const { root } = installRunning0141(['0.15.0']);
  const { fleet } = fleetChild({ busy: false, inFlight: 'a credential action' });
  const host = residentHost({ root, fleet });
  await host.armed();
  expect((await host.update.runArmed(alwaysQuiet)).done).toBe(false);
  expect(readMark(root)).toBeNull();
  expect(text(await host.call({ action: 'check' }))).toContain('- kid: work outside any turn that its answer doesn\'t name plainly');
});

test('a host says a switch is under way only while its own restart is: never on a host with no install, and not once it has ended', async () => {
  expect(residentHost({ root: null }).update.switchUnderWay()).toBeNull();
  const { root } = installRunning0141(['0.15.0']);
  const host = residentHost({ root, holders: ['alice'] });
  expect(host.update.switchUnderWay()).toBe(false);
  await host.update.restartToInstalled();
  expect(host.update.status().restart?.phase).toBe('busy');
  expect(host.update.switchUnderWay()).toBe(true);
  await host.update.resume();
  expect(host.update.switchUnderWay()).toBe(false);
});

test('a person\'s restart decides on a fleet child\'s drained alone, whatever work it says is in flight beside it', async () => {
  const { root } = installRunning0141(['0.15.0']);
  const { fleet } = fleetChild({ busy: false, inFlight: ['a credential action'] });
  const host = residentHost({ root, fleet });
  expect((await host.update.restartToInstalled()).done).toBe(true);
  expect(readMark(root)).toMatchObject({ to: '0.15.0' });
  expect(host.stops).toHaveLength(1);
});

test('a try that finds this host mid-turn with a script says, in check, that the switch waits for the script', async () => {
  const { root } = installRunning0141(['0.15.0']);
  const host = residentHost({ root, holders: ['alice'], scripts: 1 });
  await host.armed();
  expect((await host.update.runArmed(alwaysQuiet)).done).toBe(false);
  const check = text(await host.call({ action: 'check' }));
  expect(check).toContain('- this host: mid-turn: alice; 1 background script, which the switch waits for');
  expect(check).not.toContain('which a stop ends');
});

test('a child that doesn\'t answer the look keeps the restart armed, and check says a host couldn\'t be counted', async () => {
  const { root } = installRunning0141(['0.15.0']);
  const fleet: SwitchFleet = {
    runningChildren: () => [{ name: 'kid' }],
    requestSwitch: async (_name, request) => request.op === 'resume' ? { ok: true, data: { resumed: true } } : { ok: false, error: 'no answer within 10 s' },
  };
  const host = residentHost({ root, fleet });
  await host.armed();
  await host.update.runArmed(alwaysQuiet);
  expect(host.update.armedSwitch()).not.toBeNull();
  expect(readMark(root)).toBeNull();
  const check = text(await host.call({ action: 'check' }));
  expect(check).toContain('a host couldn\'t be counted');
  expect(check).toContain('kid');
});

test('a child that doesn\'t take its resume after a try is named, in the try\'s answer and in check, as still quiesced', async () => {
  const { root } = installRunning0141(['0.15.0']);
  const { fleet } = fleetChild({ busy: true, resumes: false });
  const host = residentHost({ root, fleet });
  await host.armed();
  const answer = (await host.update.runArmed(alwaysQuiet)).lines.join(' ');
  const check = text(await host.call({ action: 'check' }));
  for (const said of [answer, check]) {
    expect(said).toContain('Ending the switch\'s quiesce didn\'t reach every host');
    expect(said).not.toContain('so the switch\'s quiesce ended');
    expect(said).toContain('kid');
  }
  expect(check).toContain(`An operator's ${shellWord(join(root, 'connectome'))} update restart resume ends it`);
  expect(check).not.toContain('/update');
});

test('while a try is under way, an install, an operator\'s Restart or Go back, a resume and a cancel each refuse, and the try then goes ahead', async () => {
  const { root } = installRunning0141(['0.15.0']);
  let release: () => void = () => {};
  const { fleet } = fleetChild({ busy: false, held: new Promise((done) => { release = done; }) });
  const host = residentHost({ root, fleet, versions: ['0.14.1', '0.15.0', '0.16.0'] });
  await host.armed();
  const trying = host.update.runArmed(alwaysQuiet);
  for (const answer of [
    await host.update.install(), await host.update.restartToInstalled(), await host.update.goBack(true), await host.update.resume(),
  ]) {
    expect(answer.done).toBe(false);
    expect(answer.lines.join(' ')).toContain('The restart to 0.15.0 is');
  }
  const cancel = await host.call({ action: 'cancel' });
  expect(cancel.success).toBe(false);
  expect(text(cancel)).toContain('being tried now');
  expect(host.update.status().installing).toBeNull();
  release();
  expect((await trying).done).toBe(true);
  expect(readMark(root)).toMatchObject({ to: '0.15.0', why: 'update' });
});

for (const [what, operator] of [
  ['Restart', (update: HostUpdate) => update.restartToInstalled()],
  ['Go back', (update: HostUpdate) => update.goBack(true)],
] as const) {
  test(`an operator's ${what} takes the armed restart's place, and calling the operator's off brings nothing back`, async () => {
    const { root, dataDir } = installRunning0141(['0.15.0']);
    placeCopyOf0140(root, dataDir);
    const host = residentHost({ root, dataDir, holders: ['other-agent'] });
    await host.armed();
    expect((await operator(host.update)).lines.join(' ')).toContain('mid-turn');
    expect(host.update.armedSwitch()).toBeNull();
    await host.update.resume();
    expect(host.update.armedSwitch()).toBeNull();
    const check = text(await host.call({ action: 'check' }));
    expect(check).toContain('didn\'t go ahead');
    expect(check).toContain(`operator's ${what} took its place`);
    host.holders.splice(0);
    await host.update.runArmed(alwaysQuiet);
    expect(readMark(root)).toBeNull();
  });
}

test('a try on a host its operator has quiesced waits for a later quiet moment, asking no child, and check says so', async () => {
  const { root } = installRunning0141(['0.15.0']);
  const { fleet, child } = fleetChild({ busy: false });
  const host = residentHost({ root, fleet });
  await host.armed();
  await host.fw.quiesce({ reason: 'maintenance: disk swap' });
  await host.update.runArmed(alwaysQuiet);
  expect(child.waits).toEqual([]);
  expect(readMark(root)).toBeNull();
  expect(host.stops).toEqual([]);
  expect(host.update.armedSwitch()).not.toBeNull();
  expect(text(await host.call({ action: 'check' }))).toContain('quiesced by its operator (maintenance: disk swap)');
  await host.fw.resume();
  await host.update.runArmed(alwaysQuiet);
  expect(child.waits.length).toBeGreaterThan(0);
  expect(readMark(root)).toMatchObject({ to: '0.15.0' });
});

for (const [what, reason] of [
  ['its mark can\'t be written', 'its mark couldn\'t be written'],
  ['the session changes during it', 'the session changed while the fleet\'s children were asked whether they were busy, ' +
    'before this host was quiesced'],
  ['it throws once hosts are quiesced', 'its try failed: the quiet check failed'],
] as const) {
  test(`a try that can't go ahead because ${what} drops the restart, with every host serving again, and check says why`, async () => {
    const { root } = installRunning0141(['0.15.0']);
    let host: ReturnType<typeof residentHost> | undefined;
    let switched = false;
    const { fleet, child } = fleetChild({ busy: false, afterLook: () => {
      if (what === 'the session changes during it' && !switched) { switched = true; host!.switchSession(); }
    } });
    host = residentHost({ root, fleet });
    await host.armed();
    if (what === 'its mark can\'t be written') mkdirSync(join(root, 'mark.json', 'held'), { recursive: true });
    await host.update.runArmed(what === 'it throws once hosts are quiesced' ? () => { throw new Error('the quiet check failed'); } : alwaysQuiet);
    expect(host.update.armedSwitch()).toBeNull();
    expect(host.stops).toEqual([]);
    expect(child.waits.length).toBeGreaterThan(0);
    expect(child.quiesced).toBe(false);
    expect(host.serving()).toBe(true);
    const check = text(await host.call({ action: 'check' }));
    expect(check).toContain('didn\'t go ahead');
    expect(check).toContain(reason);
    expect(check).not.toContain('didn\'t reach every host');
  });
}

test('a try dropped after quiescing names, in check, a child that didn\'t take its resume', async () => {
  const { root } = installRunning0141(['0.15.0']);
  const { fleet, child } = fleetChild({ busy: false, resumes: false });
  const host = residentHost({ root, fleet });
  await host.armed();
  mkdirSync(join(root, 'mark.json', 'held'), { recursive: true });
  await host.update.runArmed(alwaysQuiet);
  expect(host.update.armedSwitch()).toBeNull();
  expect(child.quiesced).toBe(true);
  const check = text(await host.call({ action: 'check' }));
  expect(check).toContain('its mark couldn\'t be written');
  expect(check).toContain('Ending the switch\'s quiesce didn\'t reach every host: kid');
});

test('an operator who quiesces this host after the children\'s look, before the switch\'s own quiesce, keeps their hold: the try ends its own quiesce, stays armed and says why', async () => {
  const { root } = installRunning0141(['0.15.0']);
  let host: ReturnType<typeof residentHost> | undefined;
  const { fleet, child } = fleetChild({ busy: false, afterLook: () => { void host!.fw.quiesce({ reason: 'maintenance' }); } });
  host = residentHost({ root, fleet });
  await host.armed();
  await host.update.runArmed(alwaysQuiet);
  expect(readMark(root)).toBeNull();
  expect(host.stops).toEqual([]);
  expect(host.serving()).toBe(false);
  expect(host.fw.getHostModeStatus().reason).toBe('maintenance');
  expect(child.quiesced).toBe(false);
  expect(host.update.armedSwitch()).not.toBeNull();
  expect(text(await host.call({ action: 'check' }))).toContain('quiesced by its operator (maintenance)');
});

for (const [fromLook, when] of [[1, 'at the children\'s look'], [2, 'at the switch\'s own quiesce']] as const) {
  test(`a fleet child quiesced by its operator holds an armed restart ${when}: nothing switches, this host is quiesced only if the switch's own quiesce began, it stays armed, and check names the child's hold`, async () => {
    const { root } = installRunning0141(['0.15.0']);
    const { fleet } = fleetChild({ busy: false, operator: { reason: 'maintenance', fromLook } });
    const host = residentHost({ root, fleet });
    await host.armed();
    expect((await host.update.runArmed(alwaysQuiet)).done).toBe(false);
    expect(readMark(root)).toBeNull();
    expect(host.stops).toEqual([]);
    expect(host.serving()).toBe(true);
    expect(host.calls.includes('quiesce')).toBe(fromLook === 2);
    expect(host.update.armedSwitch()).not.toBeNull();
    const check = text(await host.call({ action: 'check' }));
    expect(check).toContain('kid');
    expect(check).toContain('quiesced by its operator (maintenance)');
  });
}

test('an armed Go back whose release is damaged by its quiet moment is dropped, saying why', async () => {
  const { root, dataDir } = installRunning0141();
  placeCopyOf0140(root, dataDir);
  const host = residentHost({ root, dataDir });
  await host.armed({ action: 'back', data: 'keep' });
  rmSync(join(root, 'releases', '0.14.0', RELEASE_HOST, 'package.json'));
  await host.update.runArmed(alwaysQuiet);
  expect(readMark(root)).toBeNull();
  expect(host.update.armedSwitch()).toBeNull();
  expect(text(await host.call({ action: 'check' }))).toContain('0.14.0 can\'t be switched to');
});

test('a restart dropped before its try reserved anything ends the quiesce an earlier try left on a child', async () => {
  const { root } = installRunning0141(['0.15.0']);
  const state = { busy: true, resumes: false };
  const { fleet, child } = fleetChild(state);
  const host = residentHost({ root, fleet });
  await host.armed();
  await host.update.runArmed(alwaysQuiet);
  expect(child.quiesced).toBe(true);
  state.resumes = true;
  rmSync(join(root, 'releases', '0.15.0'), { recursive: true, force: true });
  await host.update.runArmed(alwaysQuiet);
  expect(host.update.armedSwitch()).toBeNull();
  expect(child.quiesced).toBe(false);
});

test('a try that finds the host stopping for another reason writes no switch, and nothing stays armed', async () => {
  const { root } = installRunning0141(['0.15.0']);
  let stopping = false;
  const host = residentHost({ root, stopping: () => stopping });
  await host.armed();
  stopping = true;
  await host.update.runArmed(alwaysQuiet);
  expect(readMark(root)).toBeNull();
  expect(host.stops).toEqual([]);
  expect(host.update.armedSwitch()).toBeNull();
});

test('a restart whose release is gone by its quiet moment is dropped, and check says it didn\'t go ahead and why', async () => {
  const { root } = installRunning0141(['0.15.0']);
  const host = residentHost({ root });
  await host.armed();
  rmSync(join(root, 'releases', '0.15.0'), { recursive: true, force: true });
  await host.update.runArmed(alwaysQuiet);
  expect(host.update.armedSwitch()).toBeNull();
  expect(readMark(root)).toBeNull();
  const check = text(await host.call({ action: 'check' }));
  expect(check).toContain('A restart onto 0.15.0 armed at 2026-10-26T20:00:00.000Z didn\'t go ahead');
  expect(check).toContain('0.15.0 can\'t be switched to');
});

test('a try due while an install is under way waits for a later quiet moment, and check says it was the install', async () => {
  const { root } = installRunning0141(['0.15.0']);
  const manager = heldManager();
  const host = residentHost({ root, installOps: manager.ops, versions: ['0.14.1', '0.15.0', '0.16.0'] });
  await host.armed();
  expect((await host.call({ action: 'install' })).success).toBe(true);
  await host.update.runArmed(alwaysQuiet);
  expect(host.update.armedSwitch()).not.toBeNull();
  expect(readMark(root)).toBeNull();
  const check = text(await host.call({ action: 'check' }));
  expect(check).toContain('an install of 0.16.0 was under way');
  expect(check).not.toContain('turns were still going');
  manager.finish();
  await until(() => host.update.status().installing === null);
});

test('after a try finds a host busy, the next is due only once the retry interval has passed', async () => {
  const { root } = installRunning0141(['0.15.0']);
  const clock = { now: Date.parse('2026-10-26T20:00:00.000Z') };
  const host = residentHost({ root, holders: ['other-agent'], clock, retryMs: 1000 });
  await host.armed();
  expect(host.update.armedDue()).toBe(true);
  await host.update.runArmed(alwaysQuiet);
  expect(host.update.armedDue()).toBe(false);
  clock.now += 999;
  expect(host.update.armedDue()).toBe(false);
  clock.now += 1;
  expect(host.update.armedDue()).toBe(true);
});

test('with no interval set, the next try after a busy one is due a minute later, not sooner', async () => {
  const { root } = installRunning0141(['0.15.0']);
  const clock = { now: Date.parse('2026-10-26T20:00:00.000Z') };
  const host = residentHost({ root, holders: ['other-agent'], clock });
  await host.armed();
  await host.update.runArmed(alwaysQuiet);
  clock.now += 59_999;
  expect(host.update.armedDue()).toBe(false);
  clock.now += 1;
  expect(host.update.armedDue()).toBe(true);
});

test('check on a headless host quotes what a failed release wrote as it wrote it, though its own words take the shell\'s', async () => {
  const { root } = installRunning0141(['0.15.0']);
  appendJournal(root, { at: '2026-10-26T20:00:00.000Z', step: 'fallback', from: '0.15.0', to: '0.14.1', outcome: 'ok',
    reason: '0.15.0 ended before its commit', mark: 'm1' });
  writeFileSync(installPaths(root).trialLog, JSON.stringify({ v: 1, release: '0.15.0', mark: 'm1',
    lines: ['[update] For a host still quiesced, /update restart resume tries again.'] }));
  const check = text(await residentHost({ root }).call({ action: 'check' }));
  expect(check).toContain('\n  [update] For a host still quiesced, /update restart resume tries again.');
});

test('check after a fallback says the quoted lines are the host\'s to the person who runs it, theirs to do, for the agent to pass on, where /update says nothing of it', async () => {
  const { root, dataDir } = installRunning0141(['0.15.0']);
  appendJournal(root, { at: '2026-10-26T20:00:00.000Z', step: 'fallback', from: '0.15.0', to: '0.14.1', outcome: 'ok',
    reason: '0.15.0 ended before its commit', mark: 'm1' });
  const refusal = [
    '[update] Couldn\'t open the store at /data/alice: its topology is from a newer release',
    'This release couldn\'t open every store it would open only after its commit, so it starts none of its agents, and the next start goes back to 0.14.1:',
    'Couldn\'t open the store at /data/alice: its topology is from a newer release',
    'To take this release, repair each refused store as AGENT-ONBOARDING.md §11.8 says, or correct what a line names, and update again; or stay on 0.14.1 until a release opens them.',
  ];
  writeFileSync(installPaths(root).trialLog, JSON.stringify({ v: 1, release: '0.15.0', mark: 'm1', lines: refusal }));
  const host = residentHost({ root, dataDir });
  const lines = text(await host.call({ action: 'check' })).split('\n');
  const last = lines.lastIndexOf(`  ${refusal.at(-1)}`);
  expect(last).toBeGreaterThan(0);
  expect(lines[last + 1]).toBe('Those quoted lines are your host\'s, written to the person who runs it: what they ask of that ' +
    'person is theirs to do, so pass it on. Where they say a store was refused, trying that release again before what they ' +
    'ask is done falls back the same way.');
  expect(statusLines(host.update.status(), COMMAND_WAYS).join('\n')).not.toContain('Those quoted lines');
});

test('back needs the data kept or restored, and goes back the way it was asked', async () => {
  for (const data of ['keep', 'restore'] as const) {
    const { root, dataDir } = installRunning0141();
    placeCopyOf0140(root, dataDir);
    const host = residentHost({ root, dataDir });
    const missing = await host.call({ action: 'back' });
    expect(missing.success).toBe(false);
    expect(text(missing)).toContain('keep');
    expect(text(missing)).toContain('restore');
    expect(text(missing).split('\n').at(-1)).toBe('Either way, on a headless host started with `CONNECTOME_SUPERVISED=1`, ' +
      'it begins at the host\'s first quiet moment, however long that takes, so it goes only once every host has said ' +
      'no turn is running there, and asks nobody. A try that finds something still going waits at least a minute ' +
      'before the next. Anywhere else, back refuses and arms nothing.');
    expect(text(missing)).toContain('the person\'s click on "⏸ quiesced" in the Web UI\'s top bar lets them through');
    expect(host.update.armedSwitch()).toBeNull();
    const arming = text(await host.call({ action: 'back', data }));
    expect(arming).toContain('if 0.14.0 has lifecycle--update; the person\'s connectome update check shows it either way.');
    expect(arming).not.toContain('/update');
    await host.update.cancelArmed();
    await host.armed({ action: 'back', data });
    await host.update.runArmed(alwaysQuiet);
    expect(readMark(root)).toMatchObject({ to: '0.14.0', why: 'go-back' });
    expect(readMark(root)?.keepData === true).toBe(data === 'keep');
  }
});

test('cancel disarms an armed restart, so nothing restarts and check shows nothing armed', async () => {
  const { root } = installRunning0141(['0.15.0']);
  const host = residentHost({ root });
  await host.armed();
  const cancelled = await host.call({ action: 'cancel' });
  expect(cancelled.success).toBe(true);
  expect(host.update.armedSwitch()).toBeNull();
  await host.update.runArmed(alwaysQuiet);
  expect(readMark(root)).toBeNull();
  expect(host.stops).toEqual([]);
  expect(text(await host.call({ action: 'check' }))).not.toContain('armed');
  expect(text(await host.call({ action: 'cancel' }))).toContain('nothing');
});

test('install answers at once, and check shows it under way, then installed', async () => {
  const { root } = installRunning0141();
  const manager = heldManager();
  const host = residentHost({ root, installOps: manager.ops });
  const answer = await host.call({ action: 'install' });
  expect(answer.success).toBe(true);
  expect(text(answer)).toContain('check');
  expect(text(await host.call({ action: 'check' }))).toContain('Installing');
  manager.finish();
  await until(() => host.update.status().installing === null);
  expect(text(await host.call({ action: 'check' }))).toContain('0.15.0 is installed');
});

test('an install that fails after its answer shows its failure in check', async () => {
  const { root } = installRunning0141();
  const manager = heldManager(1);
  const host = residentHost({ root, installOps: manager.ops });
  expect((await host.call({ action: 'install' })).success).toBe(true);
  manager.finish();
  await until(() => host.update.status().installing === null);
  const check = text(await host.call({ action: 'check' }));
  expect(check).toContain('Last install');
  expect(check).toContain('0.15.0');
  expect(check).toContain('npm error 404 Not Found');
  expect(check).not.toContain('Installing 0.15.0.');
});

test('check says what /update says: the running release, what\'s out and what it costs, and the last switch', async () => {
  const { root } = installRunning0141();
  appendJournal(root, { at: '2026-10-25T09:00:00.000Z', step: 'commit', from: '0.14.0', to: '0.14.1', outcome: 'ok', mark: 'm1' } as Parameters<typeof appendJournal>[1]);
  const host = residentHost({ root, costs: { '0.15.0': { breaking: true, cacheWrite: true } } });
  const check = text(await host.call({ action: 'check' }));
  expect(check).toContain('connectome-host 0.14.1.');
  expect(check).toContain('connectome-host 0.15.0 is out; this host runs 0.14.1.');
  expect(check).toContain('Breaking: 0.15.0');
  expect(check).toContain('prompt cache is written in full once: 0.15.0');
  expect(check).toContain('0.14.0 to 0.14.1, committed');
});

test('after an update\'s restart the update puts nothing in the resident\'s context, where a lifecycle--restart leaves its note', async () => {
  const { root } = installRunning0141(['0.15.0']);
  const host = residentHost({ root });
  await host.armed();
  await host.update.runArmed(alwaysQuiet);
  expect(host.stops).toHaveLength(1);
  const startAgain = async (dataDir: string) => {
    const said: unknown[] = [];
    const next = new LifecycleModule({ dataDir, selfRestart: true, selfUpdate: true, state: new SelfRestartState() });
    await next.start({ addMessage: (...args: unknown[]) => { said.push(args); } } as unknown as ModuleContext);
    return said;
  };
  expect(await startAgain(host.dataDir)).toEqual([]);

  const state = new SelfRestartState();
  state.attachHeadless();
  const other = residentHost({ root: null, state, grants: { selfRestart: true, selfUpdate: false } });
  expect((await other.call({ reason: 'pick up an edited recipe' }, 'restart')).success).toBe(true);
  state.recordExit('self-restart', 75);
  expect(existsSync(join(other.dataDir, SELF_RESTART_FILE))).toBe(true);
  expect((await startAgain(other.dataDir)).length).toBeGreaterThan(0);
});

test('a host with no install of its own, such as a fleet child, refuses restart and back', async () => {
  const host = residentHost({ root: null });
  for (const input of [{ action: 'restart' }, { action: 'back', data: 'keep' }]) {
    const answer = await host.call(input);
    expect(answer.success).toBe(false);
    expect(text(answer)).toContain('A fleet child is updated with its parent\'s install where its parent has one, and any ' +
      'other host, or a child whose parent has none, by hand');
    expect(text(answer)).toContain('Asking again');
  }
  expect(host.update.armedSwitch()).toBeNull();
});

test('a restart of either kind waits alone: each refuses while the other is armed, and each cancel names the other', async () => {
  const { root } = installRunning0141(['0.15.0']);
  const state = new SelfRestartState();
  state.attachHeadless();
  const host = residentHost({ root, state, grants: { selfRestart: true, selfUpdate: true } });
  await host.armed();
  const plain = await host.call({ reason: 'pick up an edited recipe' }, 'restart');
  expect(plain.success).toBe(false);
  expect(text(plain)).toContain('a restart onto 0.15.0 is armed');
  expect(text(plain)).toContain('it restarts the host at a quiet moment.');
  expect(state.isArmed()).toBe(false);
  expect(text(await host.call({ cancel: true }, 'restart'))).toContain('lifecycle--update cancel');
  expect(host.update.armedSwitch()).not.toBeNull();
  await host.call({ action: 'cancel' });
  expect((await host.call({ reason: 'pick up an edited recipe' }, 'restart')).success).toBe(true);
  const update = await host.call({ action: 'restart' });
  expect(update.success).toBe(false);
  expect(text(update)).toContain('a plain restart (lifecycle--restart) is pending');
  expect(host.update.armedSwitch()).toBeNull();
  const back = await host.call({ action: 'back', data: 'keep' });
  expect(back.success).toBe(false);
  expect(text(back)).toContain('a plain restart (lifecycle--restart) is pending');
  expect(host.update.armedSwitch()).toBeNull();
  expect(text(await host.call({ action: 'check' }))).toContain('A plain restart (lifecycle--restart) is pending');
  expect(text(await host.call({ action: 'cancel' }))).toContain('lifecycle--restart with cancel: true disarms it, for an ' +
    'agent given that tool.');
  expect(state.isArmed()).toBe(true);
});

test('a call whose action, version or data the tool can\'t use is refused, naming the field, and arms nothing', async () => {
  const { root, dataDir } = installRunning0141(['0.15.0']);
  placeCopyOf0140(root, dataDir);
  const host = residentHost({ root, dataDir });
  for (const [input, field] of [
    [{ action: 'reboot' }, '`action`'],
    [{ action: 'restart', version: 'latest' }, '`version`'],
    [{ action: 'back', data: 'maybe' }, '`data`'],
    [{ action: 'check', version: '0.15.0' }, '`version` goes with restart, back or notes'],
    [{ action: 'restart', data: 'keep' }, '`data` goes with back'],
    [{ action: 'restart', verison: '0.15.0' }, '`verison`'],
  ] as const) {
    const answer = await host.call(input);
    expect(answer.success).toBe(false);
    expect(text(answer)).toContain(field);
  }
  expect(host.update.armedSwitch()).toBeNull();
});

test('/update and the Web UI say who can disarm an armed restart, and that their Restart or Go back goes ahead in its place', async () => {
  const { root, dataDir } = installRunning0141(['0.15.0']);
  placeCopyOf0140(root, dataDir);
  const host = residentHost({ root, dataDir });
  await host.armed();
  expect(statusLines(host.update.status(), COMMAND_WAYS).join('\n')).toContain(
    'The agent\'s own lifecycle--update cancel disarms it, and /update restart, /update back keep or /update back restore here ' +
    'goes ahead in its place.');
  expect(statusLines(host.update.status(), PAGE_WAYS).join('\n')).toContain(`The agent's own lifecycle--update cancel disarms it, and ` +
    `${PAGE_WAYS.restart}, ${PAGE_WAYS.keep} or ${PAGE_WAYS.restore} here goes ahead in its place.`);
  expect(text(await host.call({ action: 'check' }))).toContain('\nlifecycle--update cancel disarms it.');
});

test('with no Go back offered, /update names only its Restart as going ahead in an armed restart\'s place', async () => {
  const { root } = installRunning0141(['0.15.0']);
  const host = residentHost({ root });
  await host.armed();
  const lines = statusLines(host.update.status(), COMMAND_WAYS).join('\n');
  expect(lines).toContain('The agent\'s own lifecycle--update cancel disarms it, and /update restart here goes ahead in its place.');
  expect(lines).not.toContain('/update back keep or');
});

test('a host with no stop at all, as a batch run, refuses restart and back and arms nothing', async () => {
  const { root, dataDir } = installRunning0141(['0.15.0']);
  placeCopyOf0140(root, dataDir);
  const host = residentHost({ root, dataDir, noStop: true });
  for (const input of [{ action: 'restart' }, { action: 'back', data: 'keep' }]) {
    const answer = await host.call(input);
    expect(answer.success).toBe(false);
    expect(text(answer)).toContain('no stop a restart can use');
    expect(text(answer)).toContain('Asking again');
  }
  expect(host.update.armedSwitch()).toBeNull();
});

test('a try that throws before it reserves anything drops the restart, and check says why', async () => {
  const { root } = installRunning0141(['0.15.0']);
  const host = residentHost({ root });
  await host.armed();
  host.statusFails.next = true;
  await host.update.runArmed(alwaysQuiet);
  expect(host.update.armedSwitch()).toBeNull();
  expect(readMark(root)).toBeNull();
  expect(text(await host.call({ action: 'check' }))).toContain('its try failed: the host\'s status couldn\'t be read');
});

test('arming again clears the line saying an earlier restart didn\'t go ahead', async () => {
  const { root } = installRunning0141(['0.15.0']);
  const host = residentHost({ root });
  await host.armed();
  host.statusFails.next = true;
  await host.update.runArmed(alwaysQuiet);
  expect(text(await host.call({ action: 'check' }))).toContain('didn\'t go ahead');
  expect((await host.call({ action: 'restart' })).success).toBe(true);
  expect(text(await host.call({ action: 'check' }))).not.toContain('didn\'t go ahead');
});

test('cancelling after a try left a child quiesced ends that quiesce', async () => {
  const { root } = installRunning0141(['0.15.0']);
  const state = { busy: true, resumes: false };
  const { fleet, child } = fleetChild(state);
  const host = residentHost({ root, fleet });
  await host.armed();
  await host.update.runArmed(alwaysQuiet);
  expect(child.quiesced).toBe(true);
  state.resumes = true;
  const cancelled = await host.call({ action: 'cancel' });
  expect(cancelled.success).toBe(true);
  expect(child.quiesced).toBe(false);
  expect(host.update.armedSwitch()).toBeNull();
});

test('a plain restart pending on a host that doesn\'t grant lifecycle--restart is named, without a tool the agent lacks', async () => {
  const { root } = installRunning0141(['0.15.0']);
  const state = new SelfRestartState();
  state.attachHeadless();
  const asker = residentHost({ root: null, state, grants: { selfRestart: true, selfUpdate: false } });
  expect((await asker.call({ reason: 'pick up an edited recipe' }, 'restart')).success).toBe(true);
  const host = residentHost({ root, state, grants: { selfRestart: false, selfUpdate: true } });
  for (const answer of [await host.call({ action: 'check' }), await host.call({ action: 'restart' })]) {
    expect(text(answer)).toContain('plain restart (lifecycle--restart) is pending');
    expect(text(answer)).toContain('isn\'t granted here');
    expect(text(answer)).not.toContain('cancel: true');
  }
});

test('restart asked while an install is under way arms nothing, and says to ask again once check shows it ended', async () => {
  const { root } = installRunning0141(['0.15.0']);
  const manager = heldManager();
  const host = residentHost({ root, installOps: manager.ops, versions: ['0.14.1', '0.15.0', '0.16.0'] });
  expect((await host.call({ action: 'install' })).success).toBe(true);
  const answer = await host.call({ action: 'restart' });
  expect(answer.success).toBe(false);
  expect(text(answer)).toContain('Nothing was armed: an install of 0.16.0 is under way. Ask again once lifecycle--update check');
  expect(host.update.armedSwitch()).toBeNull();
  manager.finish();
  await until(() => host.update.status().installing === null);
});

test('back asked while an install is under way arms nothing, and says to ask again once check shows it ended', async () => {
  const { root, dataDir } = installRunning0141(['0.15.0']);
  placeCopyOf0140(root, dataDir);
  const manager = heldManager();
  const host = residentHost({ root, dataDir, installOps: manager.ops, versions: ['0.14.1', '0.15.0', '0.16.0'] });
  expect((await host.call({ action: 'install' })).success).toBe(true);
  const answer = await host.call({ action: 'back', data: 'keep' });
  expect(answer.success).toBe(false);
  expect(text(answer)).toContain('Nothing was armed: an install of 0.16.0 is under way. Ask again once lifecycle--update check');
  expect(host.update.armedSwitch()).toBeNull();
  manager.finish();
  await until(() => host.update.status().installing === null);
});

test('a check whose registry read fails is refused, saying the read failed', async () => {
  const { root } = installRunning0141();
  const host = residentHost({ root, registryDown: true });
  const answer = await host.call({ action: 'check' });
  expect(answer.success).toBe(false);
  expect(text(answer)).toContain('Reading the registry failed at');
});

test('an install begun while a restart is armed keeps the armed release, and the restart stays armed', async () => {
  const { root, dataDir } = installRunning0141(['0.15.0']);
  placeCopyOf0140(root, dataDir);
  const manager = heldManager();
  const host = residentHost({ root, dataDir, installOps: manager.ops, versions: ['0.14.1', '0.15.0', '0.16.0'] });
  await host.armed();
  expect((await host.call({ action: 'install' })).success).toBe(true);
  manager.finish();
  await until(() => host.update.status().installing === null);
  expect(existsSync(join(root, 'releases', '0.16.0'))).toBe(true);
  expect(existsSync(join(root, 'releases', '0.15.0'))).toBe(true);
  expect(host.update.armedSwitch()).toMatchObject({ to: '0.15.0' });
});

test('an arm refused while an operator\'s Restart waits on turns names wait, now and resume as the person\'s commands', async () => {
  const { root } = installRunning0141(['0.15.0']);
  const host = residentHost({ root, holders: ['alice'] });
  await host.update.restartToInstalled();
  const answer = await host.call({ action: 'restart' });
  expect(answer.success).toBe(false);
  expect(text(answer)).toContain('is waiting on turns to end: the person\'s connectome update restart wait, the ' +
    'person\'s connectome update restart now or the person\'s connectome update restart resume.');
  expect(host.update.armedSwitch()).toBeNull();
  expect(host.update.status().restart?.phase).toBe('busy');
  await host.update.resume();
});

test('a cancel during an operator\'s resume leaves that resume holding the restart\'s place until it has answered', async () => {
  const { root } = installRunning0141(['0.15.0']);
  let release: () => void = () => {};
  const { fleet } = fleetChild({ busy: false, resumeHeld: new Promise((done) => { release = done; }) });
  const host = residentHost({ root, fleet });
  await host.armed();
  const resuming = host.update.resume();
  const cancelled = await host.call({ action: 'cancel' });
  expect(cancelled.success).toBe(true);
  expect(text(cancelled)).toContain('being ended already');
  expect(host.update.armedSwitch()).toBeNull();
  expect((await host.update.restartToInstalled()).lines.join(' ')).toContain('A switch\'s quiesce is being ended');
  release();
  await resuming;
  expect((await host.update.restartToInstalled()).lines.join(' ')).not.toContain('is being ended');
});

function placeNotes(root: string, version: string, text: string): string {
  const path = join(root, 'releases', version, RELEASE_HOST, 'CHANGELOG.md');
  writeFileSync(path, text);
  return path;
}

const section = (version: string, body: string) => `## ${version} — 2026-10-2${version.split('.')[1]!.at(-1)}\n\n${body}\n\n`;

test('once a release is installed, notes gives the notes of every release after the running one, up to the installed one, from its CHANGELOG.md', async () => {
  const { root } = installRunning0141(['0.16.0']);
  const sixteen = section('0.16.0', 'notes of sixteen\n- and the last line of sixteen: /update restart switches to it');
  const fifteen = section('0.15.0', 'notes of fifteen\n- and the last line of fifteen');
  placeNotes(root, '0.16.0', '# Changelog\n\n## Unreleased\n\nnot yet out\n\n' + sixteen + fifteen +
    section('0.14.1', 'notes of fourteen-one') + section('0.14.0', 'notes of fourteen'));
  const host = residentHost({ root, versions: ['0.14.1', '0.15.0', '0.16.0'] });
  const answer = await host.call({ action: 'notes' });
  expect(answer.success).toBe(true);
  const notes = text(answer);
  expect(notes).toContain('- and the last line of sixteen: /update restart switches to it');
  expect(notes).toContain(sixteen.trimEnd());
  expect(notes).toContain(fifteen.trimEnd());
  expect(notes.indexOf('notes of sixteen')).toBeLessThan(notes.indexOf('notes of fifteen'));
  expect(notes).not.toContain('notes of fourteen');
  expect(notes).not.toContain('not yet out');
});

test('once a release is installed, check names the notes action and the file in one line, and carries no notes', async () => {
  const { root } = installRunning0141(['0.15.0']);
  const path = placeNotes(root, '0.15.0', section('0.15.0', 'notes of fifteen'));
  const host = residentHost({ root });
  const check = text(await host.call({ action: 'check' }));
  expect(check).toContain('0.15.0 is installed');
  expect(check).not.toContain('notes of fifteen');
  const line = check.split('\n').filter((l) => l.includes('lifecycle--update notes'));
  expect(line).toHaveLength(1);
  expect(line[0]).toContain(path);
});

test('with nothing installed, check gives the notes link and names no notes action, and notes refuses, saying why', async () => {
  const { root } = installRunning0141();
  const host = residentHost({ root });
  const check = text(await host.call({ action: 'check' }));
  expect(check).toContain('Notes: https://github.com/anima-research/connectome-host/blob/v0.15.0/CHANGELOG.md');
  expect(check).not.toContain('lifecycle--update notes');
  const notes = await host.call({ action: 'notes' });
  expect(notes.success).toBe(false);
  expect(text(notes)).toContain('no release newer than 0.14.1 is installed');
});

test('on a host outside an install, notes refuses, saying no notes were given', async () => {
  const host = residentHost({ root: null });
  const notes = await host.call({ action: 'notes' });
  expect(notes.success).toBe(false);
  expect(text(notes)).toContain('No notes were given');
  expect(text(notes)).toContain('wasn\'t started through an install');
});

const longNotes = (mark: string, lines: number) =>
  `${mark}\n` + 'a line of notes that runs on for a while\n'.repeat(lines) + `the last line of ${mark}`;

test('notes that come to more than one answer carries are listed release by release, with each one\'s size, and the answer fits', async () => {
  const { root } = installRunning0141(['0.17.0']);
  const sections = [section('0.17.0', longNotes('seventeen', 300)), section('0.16.0', longNotes('sixteen', 180)),
    section('0.15.0', longNotes('fifteen', 180))];
  placeNotes(root, '0.17.0', sections.join(''));
  const host = residentHost({ root, versions: ['0.14.1', '0.15.0', '0.16.0', '0.17.0'] });
  const answer = await host.call({ action: 'notes' });
  expect(answer.success).toBe(true);
  const notes = text(answer);
  expect(notes.length).toBeLessThanOrEqual(24_000);
  expect(notes).not.toContain('a line of notes');
  for (const whole of sections) {
    const version = whole.slice(3, whole.indexOf(' ', 3));
    expect(notes).toContain(`- ${version}: ${whole.trimEnd().length.toLocaleString('en-US')} characters`);
  }
  expect(notes).toContain('lifecycle--update notes with its `version`');
});

test('notes with a version gives that release\'s notes whole, and none of the others', async () => {
  const { root } = installRunning0141(['0.17.0']);
  const sixteen = section('0.16.0', longNotes('sixteen', 180));
  placeNotes(root, '0.17.0', section('0.17.0', longNotes('seventeen', 300)) + sixteen + section('0.15.0', longNotes('fifteen', 180)));
  const host = residentHost({ root, versions: ['0.14.1', '0.15.0', '0.16.0', '0.17.0'] });
  const answer = await host.call({ action: 'notes', version: '0.16.0' });
  expect(answer.success).toBe(true);
  expect(text(answer)).toContain(sixteen.trimEnd());
  expect(text(answer)).not.toContain('seventeen');
  expect(text(answer)).not.toContain('fifteen');
});

test('one release\'s notes too long for one answer give their first part, how much was left out, and where the rest is', async () => {
  const { root } = installRunning0141(['0.15.0']);
  const fifteen = section('0.15.0', longNotes('fifteen', 700));
  const path = placeNotes(root, '0.15.0', fifteen);
  const host = residentHost({ root });
  for (const input of [{ action: 'notes' }, { action: 'notes', version: '0.15.0' }]) {
    const answer = await host.call(input);
    expect(answer.success).toBe(true);
    const notes = text(answer);
    expect(notes.length).toBeLessThanOrEqual(24_000);
    expect(notes).toContain('fifteen\na line of notes');
    expect(notes).not.toContain('the last line of fifteen');
    const shown = notes.split('\n').filter((line) => line === 'a line of notes that runs on for a while').length;
    expect(shown).toBeGreaterThan(0);
    expect(notes).toMatch(new RegExp(`the first [0-9,]+ of its ${fifteen.trimEnd().length.toLocaleString('en-US')} characters`));
    expect(notes).toContain(path);
    expect(notes).toContain('https://github.com/anima-research/connectome-host/blob/v0.15.0/CHANGELOG.md');
  }
});

test('notes with a version outside the releases after this one up to the installed one is refused, naming those it has', async () => {
  const { root } = installRunning0141(['0.16.0']);
  placeNotes(root, '0.16.0', section('0.16.0', 'notes of sixteen') + section('0.15.0', 'notes of fifteen') +
    section('0.14.1', 'notes of fourteen-one'));
  const host = residentHost({ root, versions: ['0.14.1', '0.15.0', '0.16.0'] });
  const answer = await host.call({ action: 'notes', version: '0.14.1' });
  expect(answer.success).toBe(false);
  expect(text(answer)).toContain('0.16.0, 0.15.0');
  expect(text(answer)).not.toContain('notes of');
});

for (const [what, notes, reason] of [
  ['missing', null, 'can\'t be read'],
  ['holding none of the releases since this one', section('0.14.0', 'notes of fourteen'), 'has no notes for'],
] as const) {
  test(`with the installed release's CHANGELOG.md ${what}, notes refuses, saying why, with the path and the link, and check still names notes`, async () => {
    const { root } = installRunning0141(['0.15.0']);
    const path = join(root, 'releases', '0.15.0', RELEASE_HOST, 'CHANGELOG.md');
    if (notes !== null) placeNotes(root, '0.15.0', notes);
    const host = residentHost({ root });
    const result = await host.call({ action: 'notes' });
    expect(result.success).toBe(false);
    const answer = text(result);
    expect(answer).toContain(reason);
    expect(answer).toContain(path);
    expect(answer).toContain('https://github.com/anima-research/connectome-host/blob/v0.15.0/CHANGELOG.md');
    expect(answer).not.toContain('notes of fourteen');
    const pointer = text(await host.call({ action: 'check' })).split('\n').filter((l) => l.includes('lifecycle--update notes'));
    expect(pointer).toHaveLength(1);
    expect(pointer[0]).toContain(path);
  });
}

test('once the release offered is installed, the tool\'s check and the host\'s log name the restart alone, and so do the status lines /update and the CLI show', async () => {
  const { root } = installRunning0141(['0.15.0']);
  const logged: string[] = [];
  const host = residentHost({ root, log: (line) => { logged.push(line); } });
  const check = text(await host.call({ action: 'check' }));
  expect(check).toContain('To take it: lifecycle--update restart.');
  expect(check).not.toContain('install, then');
  expect(logged).toContain(`[update] To take it: ${shellWord(join(root, 'connectome'))} update restart.`);
  expect(logged.join('\n')).not.toContain('install, then');
  await host.update.readRegistry();
  expect(statusLines(host.update.status(), COMMAND_WAYS)).toContain('To take it: /update restart.');
  expect(statusLines(host.update.status(), cliWays('connectome'))).toContain('To take it: connectome update restart.');
});

test('with a release installed and the registry unread, the person\'s status still links that release\'s notes', async () => {
  const { root } = installRunning0141(['0.15.0']);
  const host = residentHost({ root, registryDown: true });
  await host.update.readRegistry();
  const lines = statusLines(host.update.status(), COMMAND_WAYS);
  expect(lines).toContain('0.15.0 is installed: /update restart switches to it.');
  expect(lines).toContain('Notes: https://github.com/anima-research/connectome-host/blob/v0.15.0/CHANGELOG.md');
});

test('a notice written while the installed releases couldn\'t be read is written again, rightly, at the next read', async () => {
  const { root } = installRunning0141(['0.15.0']);
  const logged: string[] = [];
  const host = residentHost({ root, log: (line) => { logged.push(line); } });
  const releases = join(root, 'releases');
  renameSync(releases, `${releases}.away`);
  try {
    await host.update.readRegistry();
  } finally {
    renameSync(`${releases}.away`, releases);
  }
  const take = `[update] To take it: ${shellWord(join(root, 'connectome'))} update restart.`;
  expect(logged).not.toContain(take);
  await host.update.readRegistry();
  expect(logged).toContain(take);
});

test('a host in a terminal logs its take line in /update words, which its terminal takes, and a headless one without the service line by the full path', async () => {
  const { root } = installRunning0141(['0.15.0']);
  const inTerminal: string[] = [];
  await residentHost({ root, mode: 'terminal', log: (line) => { inTerminal.push(line); } }).call({ action: 'check' });
  expect(inTerminal).toContain('[update] To take it: /update restart.');
  const headless: string[] = [];
  await residentHost({ root, supervisedLine: false, log: (line) => { headless.push(line); } }).call({ action: 'check' });
  expect(headless).toContain(`[update] To take it: ${shellWord(join(root, 'connectome'))} update restart.`);
});

test('with an older release installed than the one offered, the take line still says to install first', async () => {
  const { root } = installRunning0141(['0.15.0']);
  const logged: string[] = [];
  const host = residentHost({ root, versions: ['0.14.1', '0.15.0', '0.16.0'], log: (line) => { logged.push(line); } });
  const check = text(await host.call({ action: 'check' }));
  expect(check).toContain('0.15.0 is installed');
  expect(check).toContain('To take it: lifecycle--update install, then lifecycle--update restart.');
  expect(logged).toContain(`[update] To take it: ${shellWord(join(root, 'connectome'))} update install, then ` +
    `${shellWord(join(root, 'connectome'))} update restart.`);
});
