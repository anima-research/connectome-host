import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostModeStatus } from '@animalabs/agent-framework';
import { handleCommand } from '../src/commands.js';
import {
  appendJournal, copyLabelPath, installPaths, moveCurrent, readMark, realOrResolved, switchQuiesceReason, writeJsonAtomic,
  type CopyLabel,
} from '../src/update/contract.js';
import type { InstallOps } from '../src/update/install.js';
import { RELEASE_HOST } from '../src/update/launcher.js';
import type { SwitchFleet } from '../src/update/quiesce.js';
import { HostUpdate, hostUpdate as theHostUpdate, type HostStop, type SwitchFramework, type UpdateSetup } from '../src/update/update.js';
import {
  COMMAND_WAYS, commandFor, goBackLines, noticeLines, statusLines, type HostQuiet, type ReadCheck, type UpdateStatus,
  type UpdateWay,
} from '../src/web/update-text.js';

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

function install(running: string, others: string[] = []): { root: string; dataDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'host-update-'));
  dirs.push(root);
  for (const version of [running, ...others]) placeRelease(root, version);
  moveCurrent(root, running);
  const dataDir = join(root, 'data');
  mkdirSync(dataDir);
  return { root, dataDir };
}

function placeCopy(root: string, dataDir: string, from: string, mark: string): void {
  const { copy } = installPaths(root);
  mkdirSync(join(copy, '0-data'), { recursive: true });
  const label: CopyLabel = { v: 1, from, at: '2026-10-20T10:00:00.000Z', items: [{ path: realOrResolved(dataDir), name: '0-data' }], mark };
  writeFileSync(copyLabelPath(copy), JSON.stringify(label));
}

function fakeFramework(options: {
  holders?: string[]; drainAfter?: number; quiesced?: string; quiesceFails?: Error; resumeFails?: Error; held?: Promise<unknown>;
  servers?: Array<{ id: string; connected: boolean; closedTab: boolean }>;
} = {}) {
  const calls: string[] = [];
  const timeouts: Array<number | undefined> = [];
  let reads = 0;
  let drainedNow = false;
  let mode: { quiesced: boolean; reason?: string } = options.quiesced ? { quiesced: true, reason: options.quiesced } : { quiesced: false };
  const status = (): HostModeStatus => {
    const drained = drainedNow || reads >= (options.drainAfter ?? 0);
    return {
      ...mode, drained, activeTurns: 0, parkedAdmissions: 0, gatedRequests: 0, backgroundScripts: 0, deferredWrites: 0,
      activeTurnAgents: drained ? [] : options.holders ?? [],
    } as HostModeStatus;
  };
  const framework: SwitchFramework = {
    quiesce: async (opts = {}) => {
      if (options.held) await options.held;
      if (options.quiesceFails) throw options.quiesceFails;
      calls.push('quiesce');
      timeouts.push(opts.timeoutMs);
      if (!mode.quiesced) mode = { quiesced: true, reason: opts.reason };
      return status();
    },
    resume: async () => {
      calls.push('resume');
      if (options.resumeFails) throw options.resumeFails;
      mode = { quiesced: false };
      return status();
    },
    getHostModeStatus: () => { reads += 1; return status(); },
    listMcplServers: () => options.servers ?? [],
  };
  return { framework, calls, timeouts, drain: () => { drainedNow = true; } };
}

function heldManager() {
  const inner = manager();
  let finish: () => void = () => {};
  let enter: () => void = () => {};
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const ops: InstallOps = {
    ...inner.ops,
    run: (...args) => new Promise((done) => { finish = () => done(inner.ops.run(...args)); enter(); }),
  };
  return { ops, runs: inner.runs, entered, finish: () => finish() };
}

function registry(versions: Record<string, Record<string, unknown>>, status = 200) {
  const asked: string[] = [];
  const fetchManifest = (async (url: string | URL | Request) => {
    asked.push(String(url));
    return new Response(JSON.stringify({ name: '@animalabs/connectome-host', versions }), { status });
  }) as unknown as typeof fetch;
  return { fetchManifest, asked };
}

function manager(): { ops: InstallOps; runs: string[] } {
  const runs: string[] = [];
  return {
    runs,
    ops: {
      run: async (name, args, cwd) => {
        runs.push(`${name} ${args.join(' ')}`);
        const version = args.at(-1)!.split('@').at(-1)!;
        const host = join(cwd, RELEASE_HOST);
        mkdirSync(join(host, 'src', 'update'), { recursive: true });
        writeFileSync(join(host, 'package.json'), JSON.stringify({ version }));
        writeFileSync(join(host, 'src', 'index.ts'), '');
        writeFileSync(join(host, 'src', 'update', 'launcher.ts'), '');
        return { status: 0, output: '' };
      },
      report: () => {},
    },
  };
}

function hostUpdate(setup: Partial<UpdateSetup> & {
  root?: string; dataDir?: string; framework?: SwitchFramework; frameworks?: () => SwitchFramework; fleet?: SwitchFleet;
}, stop?: { supervised: boolean }) {
  const log: string[] = [];
  const stops: Array<{ reason: string; farewell: string }> = [];
  const update = new HostUpdate();
  const framework = setup.framework ?? fakeFramework().framework;
  update.configure({
    here: setup.here !== undefined ? setup.here : setup.root ? { root: setup.root, release: setup.running ?? '0.12.1' } : null,
    running: setup.running ?? '0.12.1',
    host: { framework: setup.frameworks ?? (() => framework), fleet: () => setup.fleet ?? null },
    env: setup.env ?? {},
    bun: setup.bun ?? '1.4.4',
    fetchManifest: setup.fetchManifest ?? registry({}).fetchManifest,
    installOps: setup.installOps,
    now: () => new Date('2026-10-22T12:00:00.000Z'),
    log: (line) => log.push(line),
    waits: { restartMs: 50, longerMs: 70 },
  });
  if (stop) update.attachStop({ supervised: stop.supervised, stop: (reason, farewell) => { stops.push({ reason, farewell }); } } satisfies HostStop);
  return { update, log, stops };
}

const field = (breaking: boolean | undefined, cacheWrite?: boolean) =>
  breaking === undefined ? {} : { connectomeRelease: { breaking, ...(cacheWrite === undefined ? {} : { cacheWrite }) } };

test("the suite runs with the notice off, so the hosts its tests start don't read npm's registry (bunfig.toml)", () => {
  expect(process.env.CONNECTOME_UPDATE_CHECK).toBe('0');
});


/** A disk can fail a directory's sync once a rename has put the file in place. */
function failSyncAfterRenameTo(path: string) {
  const rename = fs.renameSync;
  const fsync = fs.fsyncSync;
  let renamed = false;
  return [
    spyOn(fs, 'renameSync').mockImplementation((from: fs.PathLike, to: fs.PathLike) => {
      rename(from, to);
      if (String(to) === path) renamed = true;
    }),
    spyOn(fs, 'fsyncSync').mockImplementation((fd: number) => {
      if (renamed && fs.fstatSync(fd).isDirectory()) {
        renamed = false;
        throw new Error('EIO: i/o error, fsync');
      }
      fsync(fd);
    }),
  ];
}

describe('the notice', () => {
  test('offers the newest final release that is neither deprecated nor older, with what each version since costs', async () => {
    const { fetchManifest, asked } = registry({
      '0.12.0': {}, '0.12.1': {}, '0.12.2': field(undefined), '0.13.0-0': field(true, true),
      '0.13.0': field(true, false), '0.13.1': { ...field(false), engines: { bun: '>=1.4.3' } },
      '0.14.0': { ...field(false, true), deprecated: 'broken install' }, 'not-a-version': {},
    });
    const { update, log } = hostUpdate({ fetchManifest, env: { npm_config_registry: 'https://registry.example' } });
    const check = await update.readRegistry();
    expect(asked).toEqual(['https://registry.example/@animalabs%2fconnectome-host']);
    expect(check).toEqual({
      at: '2026-10-22T12:00:00.000Z', ok: true, candidate: '0.13.1', bunFloorUnmet: null, runningDeprecated: null,
      costs: [
        { version: '0.12.2', breaking: null, cacheWrite: null },
        { version: '0.13.0-0', breaking: true, cacheWrite: true },
        { version: '0.13.0', breaking: true, cacheWrite: false },
        { version: '0.13.1', breaking: false, cacheWrite: null },
      ],
    });
    expect(log).toEqual([
      '[update] connectome-host 0.13.1 is out; this host runs 0.12.1.',
      '[update] Breaking: 0.13.0-0, 0.13.0. Read its notes before updating.',
      "[update] Each resident's prompt cache is written in full once: 0.13.0-0.",
      '[update] Cut before releases recorded what they cost, so read their notes: 0.12.2.',
      "[update] Says nothing of whether it rewrites residents' prompt caches: 0.13.1.",
      '[update] Notes: https://github.com/anima-research/connectome-host/blob/v0.13.1/CHANGELOG.md',
      expect.stringContaining('This host wasn\'t started through an install\'s entry point'),
    ]);
    await update.readRegistry();
    expect(log).toHaveLength(7);
  });

  test('says none is breaking only when every version says so, and names an unmet Bun floor', () => {
    const check: ReadCheck = {
      at: 'now', ok: true, candidate: '0.13.0', bunFloorUnmet: '>=1.5.0', runningDeprecated: null,
      costs: [{ version: '0.13.0', breaking: false, cacheWrite: false }],
    };
    expect(noticeLines(check, '0.12.1', true)).toEqual([
      'connectome-host 0.13.0 is out; this host runs 0.12.1.',
      'None of the releases since this one is breaking.',
      '0.13.0 needs Bun >=1.5.0: upgrade Bun first, and Update installs nothing until then.',
      'Notes: https://github.com/anima-research/connectome-host/blob/v0.13.0/CHANGELOG.md',
      'To take it: /update install, then /update restart.',
    ]);
    const unknown: ReadCheck = { ...check, bunFloorUnmet: null, costs: [
      { version: '0.12.2', breaking: null, cacheWrite: null }, { version: '0.13.0', breaking: false, cacheWrite: false },
    ] };
    expect(noticeLines(unknown, '0.12.1', true).slice(1, 3)).toEqual([
      'None that records it is breaking.', 'Cut before releases recorded what they cost, so read their notes: 0.12.2.',
    ]);
  });

  test('reads at start and once a day once started, and only once started, unless turned off', () => {
    const { fetchManifest, asked } = registry({ '0.12.1': {} });
    const { update } = hostUpdate({ fetchManifest, env: {} });
    expect(update.status().checks).toBe(false);
    const timers = spyOn(globalThis, 'setInterval');
    try {
      update.startChecks();
      update.startChecks();
      expect(asked).toHaveLength(1);
      expect(update.status().checks).toBe(true);
      expect(timers).toHaveBeenCalledTimes(1);
      const [daily, every] = timers.mock.calls[0]! as unknown as [() => void, number];
      expect(every).toBe(24 * 60 * 60 * 1000);
      daily();
      expect(asked).toHaveLength(2);
    } finally {
      timers.mockRestore();
    }
    const off = hostUpdate({ fetchManifest, env: { CONNECTOME_UPDATE_CHECK: '0' } }).update;
    off.startChecks();
    expect(asked).toHaveLength(2);
    expect(off.status().checks).toBe(false);
    expect(statusLines(off.status())).toContain("This host doesn't read the registry on its own: /update reads it.");
  });

  test('a newer release seen later is noticed too, and Update installs what the registry offers then', async () => {
    let versions: Record<string, Record<string, unknown>> = { '0.13.0': {} };
    const fetchManifest = (async () => Response.json({ versions })) as unknown as typeof fetch;
    const { root, dataDir } = install('0.12.1');
    const { ops, runs } = manager();
    const { update, log } = hostUpdate({ root, dataDir, fetchManifest, installOps: ops });
    await update.readRegistry();
    versions = { '0.13.0': {}, '0.13.1': {} };
    await update.readRegistry();
    expect(log.filter((line) => line.includes(' is out; '))).toEqual([
      '[update] connectome-host 0.13.0 is out; this host runs 0.12.1.', '[update] connectome-host 0.13.1 is out; this host runs 0.12.1.',
    ]);
    versions = { '0.13.0': {}, '0.13.1': {}, '0.13.2': {} };
    expect((await update.install()).lines[0]).toStartWith('0.13.2 is installed beside 0.12.1');
    expect(runs).toEqual([expect.stringContaining('@animalabs/connectome-host@0.13.2')]);
  });

  test("a registry that can't be read is logged and kept as the check, and checks can be turned off", async () => {
    const { update, log } = hostUpdate({ fetchManifest: registry({}, 503).fetchManifest });
    const check = await update.readRegistry();
    expect(check).toMatchObject({ ok: false, error: expect.stringContaining('answered 503') });
    expect(log).toEqual([expect.stringContaining("Whether a newer connectome-host is out can't be told")]);
    expect(hostUpdate({ env: { CONNECTOME_UPDATE_CHECK: '0' } }).update.checksOn()).toBe(false);
    expect(hostUpdate({ env: { NO_UPDATE_NOTIFIER: '1' } }).update.checksOn()).toBe(false);
    expect(hostUpdate({ env: {} }).update.checksOn()).toBe(true);
  });
});

describe('Update', () => {
  test('installs the candidate beside the running release, and asks for no switch', async () => {
    const { root, dataDir } = install('0.12.1');
    const { ops, runs } = manager();
    const { update } = hostUpdate({ root, dataDir, installOps: ops, fetchManifest: registry({ '0.12.1': {}, '0.13.0': field(false, false) }).fetchManifest });
    const answer = await update.install();
    expect(answer).toEqual({ done: true, lines: [
      '0.13.0 is installed beside 0.12.1, which runs on. Restart switches to the newest release installed: /update restart.',
    ] });
    expect(runs).toEqual(['npm install --save-exact --no-audit --no-fund @animalabs/connectome-host@0.13.0']);
    expect(readMark(root)).toBeNull();
    expect(update.status()).toMatchObject({ installed: '0.13.0', lastInstall: { version: '0.13.0', ok: true }, installing: null });
  });

  test('installs nothing below its Bun floor, with no newer release, or on a host that is no install', async () => {
    const { root, dataDir } = install('0.12.1');
    const { ops, runs } = manager();
    const floor = hostUpdate({ root, dataDir, installOps: ops, bun: '1.4.2', fetchManifest: registry({ '0.13.0': { engines: { bun: '>=1.4.3' } } }).fetchManifest });
    expect(await floor.update.install()).toEqual({ done: false, lines: [expect.stringContaining('0.13.0 needs Bun >=1.4.3, and this host runs on Bun 1.4.2')] });
    const none = hostUpdate({ root, dataDir, installOps: ops, fetchManifest: registry({ '0.12.1': { deprecated: 'use 0.12.2' }, '0.12.2': { deprecated: 'no' } }).fetchManifest });
    expect(await none.update.install()).toEqual({ done: false, lines: [
      "No release newer than 0.12.1 is offered, so nothing was installed: Update offers final releases that aren't " +
        'deprecated. 0.12.1 is deprecated on npm (use 0.12.2).',
    ] });
    expect(runs).toEqual([]);
    expect(await hostUpdate({}).update.install()).toEqual({ done: false, lines: [expect.stringContaining('wasn\'t started through an install\'s entry point')] });
  });

  test('installs one release at a time, and none while a restart waits on turns', async () => {
    const { root, dataDir } = install('0.12.1', ['0.13.0']);
    const slow = heldManager();
    const fetchManifest = registry({ '0.13.1': {} }).fetchManifest;
    const { update } = hostUpdate({ root, dataDir, installOps: slow.ops, fetchManifest }, { supervised: true });
    const first = update.install();
    await slow.entered;
    expect(await update.install()).toEqual({ done: false, lines: ['An install of 0.13.1 is under way.'] });
    slow.finish();
    expect((await first).done).toBe(true);
    expect(slow.runs).toHaveLength(1);

    const { framework } = fakeFramework({ holders: ['alice'], drainAfter: Infinity });
    const busy = hostUpdate({ root, dataDir, framework, installOps: manager().ops, fetchManifest }, { supervised: true }).update;
    expect((await busy.restartToInstalled()).done).toBe(false);
    expect(await busy.install()).toEqual({ done: false, lines: ['The restart to 0.13.1 is under way.'] });
  });

  test("says why when the registry can't be read or the install fails, and lets the next one go ahead", async () => {
    const { root, dataDir } = install('0.12.1');
    const broken = hostUpdate({ root, dataDir, fetchManifest: registry({}, 503).fetchManifest }).update;
    expect((await broken.install()).lines[0]).toStartWith('Nothing was installed: The registry at');
    expect(broken.status()).toMatchObject({ installing: null, check: { ok: false } });
    const failing: InstallOps = { run: async () => ({ status: 1, output: 'npm ERR! 404 Not Found' }), report: () => {} };
    const { update } = hostUpdate({ root, dataDir, installOps: failing, fetchManifest: registry({ '0.13.0': {} }).fetchManifest });
    expect((await update.install()).done).toBe(false);
    expect(update.status()).toMatchObject({ installing: null, lastInstall: { version: '0.13.0', ok: false } });
    expect(statusLines(update.status()).some((line) => line.startsWith("Last install: Installing 0.13.0 failed, so it isn't installed: ")))
      .toBe(true);
    const broke: InstallOps = { run: async () => { throw new Error('EIO: i/o error, write'); }, report: () => {} };
    const raw = hostUpdate({ root, dataDir, installOps: broke, fetchManifest: registry({ '0.13.0': {} }).fetchManifest }).update;
    expect(await raw.install()).toEqual({ done: false, lines: ['Installing 0.13.0 failed: EIO: i/o error, write'] });
    expect(raw.status().lastInstall).toMatchObject({ ok: false, error: 'Installing 0.13.0 failed: EIO: i/o error, write' });
    expect(statusLines({ ...raw.status(), installing: '0.13.0' }).some((line) => line.startsWith('Last install:'))).toBe(false);
  });
});

describe('Restart', () => {
  test('quiesces, and once drained writes the mark and stops the host, for the newest exact version whose host is in place', async () => {
    const { root, dataDir } = install('0.12.1', ['0.13.0', '0.13.0-rc.1', '0.11.0']);
    mkdirSync(join(root, 'releases', '0.14.0'));
    placeRelease(root, 'latest');
    const { framework, calls } = fakeFramework();
    const { update, stops } = hostUpdate({ root, dataDir, framework }, { supervised: true });
    const answer = await update.restartToInstalled();
    expect(answer).toEqual({ done: true, lines: [
      'Stopping to switch to 0.13.0: the host\'s next start does it, which a service set up for updates makes by itself.',
    ] });
    expect(calls).toEqual(['quiesce']);
    expect(readMark(root)).toMatchObject({ v: 1, to: '0.13.0', why: 'update', at: '2026-10-22T12:00:00.000Z' });
    expect(readMark(root)?.keepData).toBeUndefined();
    expect(stops).toEqual([{ reason: 'update: switch to 0.13.0', farewell: answer.lines[0]! }]);
    expect(update.status().restart).toMatchObject({ to: '0.13.0', phase: 'stopping' });
  });

  test('the mark records the MCPL servers the host has connected when it writes it, and not one that failed or a closed tab, for a switch and a Go back alike', async () => {
    const servers = [
      { id: 'heartbeat', connected: true, closedTab: false },
      { id: 'discord', connected: false, closedTab: false },
      { id: 'notes', connected: false, closedTab: true },
    ];
    const { root, dataDir } = install('0.12.1', ['0.13.0']);
    const { update } = hostUpdate({ root, dataDir, framework: fakeFramework({ servers }).framework }, { supervised: true });
    expect((await update.restartToInstalled()).done).toBe(true);
    expect(readMark(root)).toMatchObject({ to: '0.13.0', why: 'update', connected: ['heartbeat'] });
    const back = install('0.13.0', ['0.12.1']);
    placeCopy(back.root, back.dataDir, '0.12.1', 'm1');
    const going = hostUpdate({ root: back.root, dataDir: back.dataDir, framework: fakeFramework({ servers }).framework, running: '0.13.0' }, { supervised: true }).update;
    expect((await going.goBack(true)).done).toBe(true);
    expect(readMark(back.root)).toMatchObject({ to: '0.12.1', why: 'go-back', connected: ['heartbeat'] });
  });

  test('the mark records the servers connected when the host stops, after the wait for turns or at stop now, not those connected when the restart was asked', async () => {
    for (const stop of ['after the wait', 'stop now'] as const) {
      const servers = [
        { id: 'heartbeat', connected: true, closedTab: false },
        { id: 'discord', connected: false, closedTab: false },
      ];
      const { root, dataDir } = install('0.12.1', ['0.13.0']);
      const { framework, drain } = fakeFramework({ holders: ['alice'], drainAfter: Infinity, servers });
      const { update } = hostUpdate({ root, dataDir, framework }, { supervised: true });
      expect((await update.restartToInstalled()).done).toBe(false);
      servers[0]!.connected = false;
      servers[1]!.connected = true;
      if (stop === 'after the wait') {
        drain();
        expect((await update.waitLonger()).done).toBe(true);
      } else {
        expect((await update.stopNow()).done).toBe(true);
      }
      expect(readMark(root)).toMatchObject({ to: '0.13.0', why: 'update', connected: ['discord'] });
    }
  });

  test("an unsupervised host stops as /quit does, and says to start it again", async () => {
    const { root, dataDir } = install('0.12.1', ['0.13.0']);
    const { update, stops } = hostUpdate({ root, dataDir }, { supervised: false });
    expect((await update.restartToInstalled()).lines).toEqual([
      'Stopping to switch to 0.13.0: once it has stopped, start the host again, and that start does it.',
    ]);
    expect(stops).toHaveLength(1);
  });

  test("turns that don't end leave it waiting: wait longer, stop now, or resume", async () => {
    const { root, dataDir } = install('0.12.1', ['0.13.0']);
    const { framework, calls } = fakeFramework({ holders: ['alice'], drainAfter: Infinity });
    const { update, stops } = hostUpdate({ root, dataDir, framework }, { supervised: true });
    const busy = await update.restartToInstalled();
    expect(busy.done).toBe(false);
    expect(busy.lines).toContain('- this host: mid-turn: alice');
    expect(readMark(root)).toBeNull();
    expect(update.status().restart).toMatchObject({ phase: 'busy', hosts: [{ host: 'this host', drained: false, activeTurnAgents: ['alice'] }] });
    expect(update.status().switchQuiesceLeft).toBe(false);
    expect((await update.restartToInstalled()).lines).toEqual(['The restart to 0.13.0 is waiting on turns to end: /update ' +
      'restart wait, /update restart now or /update restart resume.']);
    const waiting = update.waitLonger();
    expect(update.status().restart).toMatchObject({ phase: 'quiescing', hosts: [] });
    expect((await update.stopNow()).lines).toEqual(["No restart's wait for turns to end has run out, so there is nothing to wait longer for or stop now."]);
    expect((await waiting).done).toBe(false);
    const resumed = await update.resume();
    expect(resumed).toEqual({ done: true, lines: ['The restart to 0.13.0 is called off, and nothing switches.'] });
    expect(calls.at(-1)).toBe('resume');
    expect(update.status().restart).toBeNull();
    await update.restartToInstalled();
    expect(await update.stopNow()).toMatchObject({ done: true });
    expect(readMark(root)?.to).toBe('0.13.0');
    expect(stops).toHaveLength(1);
    expect(await update.resume()).toEqual({ done: false, lines: ["The restart to 0.13.0 is stopping the host, for its next start."] });
  });

  test('wait longer quiesces again with its own wait, and stops once turns have ended', async () => {
    const { root, dataDir } = install('0.12.1', ['0.13.0']);
    const { framework, timeouts, drain } = fakeFramework({ holders: ['alice'], drainAfter: Infinity });
    const { update, stops } = hostUpdate({ root, dataDir, framework }, { supervised: true });
    expect((await update.restartToInstalled()).done).toBe(false);
    drain();
    expect(await update.waitLonger()).toMatchObject({ done: true });
    expect(timeouts).toEqual([50, 70]);
    expect(readMark(root)?.to).toBe('0.13.0');
    expect(stops).toHaveLength(1);
  });

  test('one request at a time: a restart, a Go back or an install is refused while a restart quiesces or stops', async () => {
    const { root, dataDir } = install('0.12.1', ['0.13.0']);
    let release: () => void = () => {};
    const { framework } = fakeFramework({ held: new Promise<void>((done) => { release = done; }) });
    const { update } = hostUpdate({ root, dataDir, framework }, { supervised: true });
    expect(await update.waitLonger()).toEqual({ done: false, lines: ["No restart's wait for turns to end has run out, so there is nothing to wait longer for or stop now."] });
    expect(await update.stopNow()).toEqual({ done: false, lines: ["No restart's wait for turns to end has run out, so there is nothing to wait longer for or stop now."] });
    const first = update.restartToInstalled();
    expect((await update.restartToInstalled()).lines).toEqual(["The restart to 0.13.0 is waiting for turns to end, with new turns held."]);
    expect((await update.goBack(true)).lines).toEqual(["The restart to 0.13.0 is waiting for turns to end, with new turns held."]);
    release();
    expect((await first).done).toBe(true);
    expect((await update.restartToInstalled()).lines).toEqual(["The restart to 0.13.0 is stopping the host, for its next start."]);
    expect((await update.install()).lines).toEqual(['The restart to 0.13.0 is under way.']);
    const back = install('0.13.0', ['0.12.1']);
    placeCopy(back.root, back.dataDir, '0.12.1', 'm1');
    let releaseBack: () => void = () => {};
    const held = fakeFramework({ held: new Promise<void>((done) => { releaseBack = done; }) }).framework;
    const going = hostUpdate({ root: back.root, dataDir: back.dataDir, framework: held, running: '0.13.0' }, { supervised: true }).update;
    const goingBack = going.goBack(true);
    expect((await going.restartToInstalled()).lines).toEqual(['The Go back to 0.12.1 is waiting for turns to end, with new turns held.']);
    expect((await going.install()).lines).toEqual(['The Go back to 0.12.1 is under way.']);
    expect((await going.resume()).lines).toEqual(['The Go back to 0.12.1 is waiting for turns to end, with new turns held.']);
    releaseBack();
    expect((await goingBack).done).toBe(true);
  });

  test('a Go back whose turns don\'t end is named as one while it waits, and when it is called off', async () => {
    const { root, dataDir } = install('0.13.0', ['0.12.1']);
    placeCopy(root, dataDir, '0.12.1', 'm1');
    const { framework } = fakeFramework({ holders: ['alice'], drainAfter: Infinity });
    const { update } = hostUpdate({ root, dataDir, framework, running: '0.13.0' }, { supervised: true });
    expect((await update.goBack(true)).done).toBe(false);
    expect(update.status().restart).toMatchObject({ phase: 'busy', to: '0.12.1', why: 'go-back' });
    expect((await update.restartToInstalled()).lines).toEqual(['The Go back to 0.12.1 is waiting on turns to end: /update ' +
      'restart wait, /update restart now or /update restart resume.']);
    expect(await update.resume()).toEqual({ done: true, lines: ['The Go back to 0.12.1 is called off, and nothing switches.'] });
    expect(readMark(root)).toBeNull();
  });

  test('while a restart is being called off, nothing else acts on it', async () => {
    const { root, dataDir } = install('0.12.1', ['0.13.0']);
    const { framework } = fakeFramework({ holders: ['alice'], drainAfter: Infinity });
    let release: () => void = () => {};
    const held = new Promise<void>((done) => { release = done; });
    let asked: () => void = () => {};
    const resumeAsked = new Promise<void>((done) => { asked = done; });
    const fleet: SwitchFleet = {
      runningChildren: () => [{ name: 'kid' }],
      requestSwitch: async (_name, request) => {
        if (request.op === 'quiesce') return { ok: true, data: { drained: true, activeTurnAgents: [], backgroundScripts: 0 } };
        asked();
        await held;
        return { ok: true, data: { resumed: true } };
      },
    };
    const { update, stops } = hostUpdate({ root, dataDir, framework, fleet }, { supervised: true });
    expect((await update.restartToInstalled()).done).toBe(false);
    const resuming = update.resume();
    await resumeAsked;
    expect(update.status().restart).toMatchObject({ phase: 'ending' });
    expect(await update.stopNow()).toEqual({ done: false, lines: ["No restart's wait for turns to end has run out, so there is nothing to wait longer for or stop now."] });
    expect(await update.waitLonger()).toEqual({ done: false, lines: ["No restart's wait for turns to end has run out, so there is nothing to wait longer for or stop now."] });
    expect((await update.restartToInstalled()).lines).toEqual(["The restart to 0.13.0 is being called off, ending the switch's quiesce."]);
    release();
    expect(await resuming).toEqual({ done: true, lines: ['The restart to 0.13.0 is called off, and nothing switches.'] });
    expect(readMark(root)).toBeNull();
    expect(stops).toEqual([]);
  });

  test('a session switch while turns end calls the restart off, as it does before a stop now', async () => {
    const { root, dataDir } = install('0.12.1', ['0.13.0']);
    const first = fakeFramework();
    const second = fakeFramework();
    let current = first.framework;
    const quiesce = first.framework.quiesce;
    first.framework.quiesce = async (opts) => {
      const status = await quiesce(opts);
      current = second.framework;
      return status;
    };
    const { update, stops } = hostUpdate({ root, dataDir, frameworks: () => current }, { supervised: true });
    expect(await update.restartToInstalled()).toEqual({ done: false, lines: [
      "The restart to 0.13.0 is called off, and nothing switches: the session changed while turns were ending, so " +
        "this host now serves one the restart didn't quiesce. Ask again.",
    ] });
    expect(readMark(root)).toBeNull();
    expect(stops).toEqual([]);

    current = fakeFramework({ holders: ['alice'], drainAfter: Infinity }).framework;
    const again = hostUpdate({ root, dataDir, frameworks: () => current }, { supervised: true }).update;
    expect((await again.restartToInstalled()).done).toBe(false);
    current = second.framework;
    expect((await again.stopNow()).lines[0]).toStartWith('The restart to 0.13.0 is called off, and nothing switches: the session changed');
    expect(readMark(root)).toBeNull();
    expect(again.status().restart).toBeNull();
  });

  test("a switch's quiesce no restart carries out shows, and try later ends it", async () => {
    const { root, dataDir } = install('0.12.1');
    const { framework, calls } = fakeFramework({ quiesced: switchQuiesceReason('0.13.0') });
    const { update } = hostUpdate({ root, dataDir, framework }, { supervised: true });
    expect(update.status().switchQuiesceLeft).toBe(true);
    expect(statusLines(update.status())).toContain("This host is quiesced for a switch that isn't going ahead: /update restart resume ends it.");
    expect(await update.resume()).toEqual({ done: true, lines: ["The switch's quiesce is ended on this host."] });
    expect(calls).toEqual(['resume']);
    expect(update.status().switchQuiesceLeft).toBe(false);
    expect(await update.resume()).toEqual({ done: true, lines: ['No restart is waiting, and no host was quiesced for a switch.'] });
    const stuck = fakeFramework({ quiesced: switchQuiesceReason('0.13.0'), resumeFails: new Error('it would wedge') });
    const failing = hostUpdate({ root, dataDir, framework: stuck.framework }, { supervised: true }).update;
    expect(await failing.resume()).toEqual({ done: false, lines: [
      "No restart is waiting, and the switch's quiesce couldn't be ended.",
      expect.stringMatching(/^this host: it stays quiesced, since agent-framework refused its resume \(it would wedge\)/),
      "For a host still quiesced, /update restart resume tries again, as does the host's next start.",
    ] });
    const kid: SwitchFleet = { runningChildren: () => [{ name: 'kid' }], requestSwitch: async () => ({ ok: true, data: { resumed: true } }) };
    const partly = hostUpdate({ root, dataDir, framework: stuck.framework, fleet: kid }, { supervised: true }).update;
    expect(await partly.resume()).toEqual({ done: false, lines: [
      "The switch's quiesce is ended on kid, but not on every host.",
      expect.stringMatching(/^this host: it stays quiesced, since agent-framework refused its resume \(it would wedge\)/),
      "For a host still quiesced, /update restart resume tries again, as does the host's next start.",
    ] });
    expect(hostUpdate({ framework: stuck.framework }).update.status().switchQuiesceLeft).toBe(false);
  });

  test('while a resume ends a switch\'s quiesce left standing, no restart, install or other resume begins', async () => {
    const { root, dataDir } = install('0.12.1', ['0.13.0']);
    const { framework } = fakeFramework({ quiesced: switchQuiesceReason('0.13.0') });
    let release: () => void = () => {};
    const held = new Promise<void>((done) => { release = done; });
    let asked: () => void = () => {};
    const resumeAsked = new Promise<void>((done) => { asked = done; });
    const fleet: SwitchFleet = {
      runningChildren: () => [{ name: 'kid' }],
      requestSwitch: async (_name, request) => {
        if (request.op === 'quiesce') return { ok: true, data: { drained: true, activeTurnAgents: [], backgroundScripts: 0 } };
        asked();
        await held;
        return { ok: true, data: { resumed: true } };
      },
    };
    const { update } = hostUpdate({ root, dataDir, framework, fleet, installOps: manager().ops }, { supervised: true });
    const resuming = update.resume();
    await resumeAsked;
    const ending = "A switch's quiesce is being ended. Ask again once that has answered.";
    expect((await update.restartToInstalled()).lines).toEqual([ending]);
    expect((await update.goBack(true)).lines).toEqual([ending]);
    expect((await update.install()).lines).toEqual([ending]);
    expect((await update.resume()).lines).toEqual([ending]);
    release();
    expect(await resuming).toEqual({ done: true, lines: ["The switch's quiesce is ended on this host, kid."] });
    expect((await update.restartToInstalled()).done).toBe(true);
  });

  test("the busy lines and try later's say what each host's own answer says", async () => {
    const { root, dataDir } = install('0.12.1', ['0.13.0']);
    // agent-framework is undrained with no agent listed while a wake is parked on provider admission.
    const { framework } = fakeFramework({ holders: [], drainAfter: Infinity, resumeFails: new Error('a resume is under way') });
    const fleet: SwitchFleet = {
      runningChildren: () => [{ name: 'kid' }, { name: 'busy' }, { name: 'gone' }],
      requestSwitch: async (name, request) => {
        if (name === 'gone') return { ok: false, error: 'its socket closed.' };
        if (request.op === 'resume' && name === 'busy') {
          return { ok: true, data: { resumed: true, why: "it's serving, though agent-framework's resume failed after the quiesce ended: EIO" } };
        }
        if (request.op === 'resume') return { ok: true, data: { resumed: true } };
        return name === 'busy'
          ? { ok: true, data: { drained: false, activeTurnAgents: ['bob'], backgroundScripts: 2 } }
          : { ok: true, data: { drained: true, activeTurnAgents: [], backgroundScripts: 1 } };
      },
    };
    const { update } = hostUpdate({ root, dataDir, framework, fleet }, { supervised: true });
    const busy = await update.restartToInstalled();
    expect(busy.lines.filter((line) => line.startsWith('- '))).toEqual([
      '- this host: not drained, though no agent holds a turn: a wake is waiting on an auxiliary call before its turn starts',
      '- busy: mid-turn: bob; 2 background scripts, which a stop ends',
      "- gone: can't be counted (its socket closed.)",
    ]);
    expect(await update.resume()).toEqual({
      done: false,
      lines: [
        'The restart to 0.13.0 is called off, and nothing switches.',
        'this host: it stays quiesced, since agent-framework refused its resume (a resume is under way); a later resume, ' +
          'such as try later or the next start, can succeed once that is resolved.',
        "busy: it's serving, though agent-framework's resume failed after the quiesce ended: EIO.",
        'gone: its socket closed.',
        "For a host still quiesced, /update restart resume tries again, as does the host's next start.",
      ],
    });
  });

  test("a mark that can't be written calls the restart off and ends the switch's quiesce", async () => {
    const { root, dataDir } = install('0.12.1', ['0.13.0']);
    mkdirSync(join(installPaths(root).mark, 'in-the-way'), { recursive: true });
    const { framework, calls } = fakeFramework();
    const { update, stops } = hostUpdate({ root, dataDir, framework }, { supervised: true });
    const answer = await update.restartToInstalled();
    expect(answer.done).toBe(false);
    expect(answer.lines[0]).toStartWith("The restart to 0.13.0 is called off, and nothing switches: its mark couldn't be written: ");
    expect(calls).toEqual(['quiesce', 'resume']);
    expect(stops).toEqual([]);
    expect(update.status().restart).toBeNull();
  });

  test("a mark in place whose sync fails still stops the host, and the farewell names the failed sync", async () => {
    const { root, dataDir } = install('0.12.1', ['0.13.0']);
    const { framework, calls } = fakeFramework();
    const { update, stops } = hostUpdate({ root, dataDir, framework }, { supervised: true });
    const spies = failSyncAfterRenameTo(installPaths(root).mark);
    let answer;
    try {
      answer = await update.restartToInstalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    const farewell = "Stopping to switch to 0.13.0: the host's next start does it, which a service set up for updates makes by " +
      'itself. The request is written, though syncing it to the disk failed (EIO: i/o error, fsync), so a power cut could ' +
      'still undo it.';
    expect(answer).toEqual({ done: true, lines: [farewell] });
    expect(readMark(root)).toMatchObject({ to: '0.13.0', why: 'update' });
    expect(calls).toEqual(['quiesce']);
    expect(stops).toEqual([{ reason: 'update: switch to 0.13.0', farewell }]);
  });

  test("a quiesce that throws calls the restart off and resumes, with no mark", async () => {
    const { root, dataDir } = install('0.12.1', ['0.13.0']);
    const { framework } = fakeFramework({ quiesceFails: new Error('deferred writes can\'t reach disk') });
    const { update, stops } = hostUpdate({ root, dataDir, framework }, { supervised: true });
    expect(await update.restartToInstalled()).toEqual({
      done: false, lines: ["The restart to 0.13.0 is called off, and nothing switches: its quiesce was refused: deferred writes can't reach disk"],
    });
    expect(readMark(root)).toBeNull();
    expect(stops).toEqual([]);
    expect(update.status().restart).toBeNull();
  });

  test("a quiesce this host refuses ends the switch's quiesce on the children it reached", async () => {
    const { root, dataDir } = install('0.12.1', ['0.13.0']);
    const { framework } = fakeFramework({ quiesceFails: new Error('no turn holders named') });
    const asked: string[] = [];
    const fleet: SwitchFleet = {
      runningChildren: () => [{ name: 'kid' }],
      requestSwitch: async (name, request) => {
        asked.push(`${name} ${request.op}`);
        return request.op === 'quiesce'
          ? { ok: true, data: { drained: true, activeTurnAgents: [], backgroundScripts: 0 } }
          : { ok: true, data: { resumed: true } };
      },
    };
    const { update } = hostUpdate({ root, dataDir, framework, fleet }, { supervised: true });
    expect((await update.restartToInstalled()).done).toBe(false);
    expect(asked).toEqual(['kid quiesce', 'kid resume']);
    expect(readMark(root)).toBeNull();
  });

  test("is refused with nothing newer installed, with no stop to use, before this host's commit, or during an install", async () => {
    const { root, dataDir } = install('0.12.1', ['0.11.0']);
    expect((await hostUpdate({ root, dataDir }, { supervised: true }).update.restartToInstalled()).lines)
      .toEqual(['No release newer than 0.12.1 is installed: Update installs one first.']);
    placeRelease(root, '0.13.0');
    expect((await hostUpdate({ root, dataDir }).update.restartToInstalled()).lines)
      .toEqual([expect.stringContaining('This host has no stop a restart can use')]);
    moveCurrent(root, '0.11.0');
    expect((await hostUpdate({ root, dataDir }, { supervised: true }).update.restartToInstalled()).lines)
      .toEqual([expect.stringContaining("This host runs 0.12.1, and the install's data runs on 0.11.0")]);
    moveCurrent(root, '0.12.1');
    const slow = heldManager();
    const { update } = hostUpdate({ root, dataDir, installOps: slow.ops, fetchManifest: registry({ '0.13.1': {} }).fetchManifest }, { supervised: true });
    const installing = update.install();
    await slow.entered;
    expect((await update.restartToInstalled()).lines).toEqual(['An install of 0.13.1 is under way. Restart once it has ended.']);
    slow.finish();
    await installing;
    rmSync(installPaths(root).current);
    writeFileSync(installPaths(root).current, '0.12.1');
    expect((await update.restartToInstalled()).lines[0]).toStartWith("Which release the install runs on can't be read: ");
    expect((await update.goBack(true)).lines[0]).toStartWith("Which release the install runs on can't be read: ");
    rmSync(installPaths(root).current);
    moveCurrent(root, '0.12.1');
    const releases = join(root, 'releases');
    const kept = join(root, 'releases-kept');
    renameSync(releases, kept);
    writeFileSync(releases, '');
    expect((await update.restartToInstalled()).lines[0]).toStartWith("Which releases are installed can't be read: ");
    unlinkSync(releases);
    renameSync(kept, releases);
    mkdirSync(installPaths(root).copy, { recursive: true });
    writeFileSync(copyLabelPath(installPaths(root).copy), 'not json');
    expect((await update.goBack(true)).lines[0]).toStartWith("Whether a Go back is offered can't be told: ");
  });

  test('a host the operator quiesced says so, and stays quiesced through a restart called off', async () => {
    const { root, dataDir } = install('0.12.1', ['0.13.0']);
    const { framework, calls } = fakeFramework({ quiesced: 'operator: maintenance', holders: ['alice'], drainAfter: Infinity });
    const { update } = hostUpdate({ root, dataDir, framework }, { supervised: true });
    expect(update.status().operatorQuiesced).toBe('operator: maintenance');
    expect(statusLines(update.status())).toContain('This host is quiesced (operator: maintenance): a restart, or a Go back ' +
      "that keeps the data, keeps it so. Restoring the copy brings back the copy's own state instead.");
    expect((await update.restartToInstalled()).done).toBe(false);
    expect(await update.resume()).toEqual({ done: true, lines: [
      'The restart to 0.13.0 is called off, and nothing switches.',
      "this host: its quiesce isn't the switch's (operator: maintenance), so it stays.",
    ] });
    expect(calls).toEqual(['quiesce']);
    expect(update.status()).toMatchObject({ operatorQuiesced: 'operator: maintenance', switchQuiesceLeft: false });
    const switching = fakeFramework({ quiesced: switchQuiesceReason('0.13.0') });
    expect(hostUpdate({ root, dataDir, framework: switching.framework }).update.status().operatorQuiesced).toBeNull();
  });
});

describe('Go back', () => {
  test('a Restart or Go back for the release the page showed goes ahead, and one for another is refused with nothing asked', async () => {
    const { root, dataDir } = install('0.13.0', ['0.12.1', '0.13.1']);
    placeCopy(root, dataDir, '0.12.1', 'm1');
    const { update, stops } = hostUpdate({ root, dataDir, running: '0.13.0' }, { supervised: true });
    expect(await update.restartToInstalled('0.13.2')).toEqual({ done: false, lines: [
      'The release installed to restart onto is now 0.13.1, not 0.13.2, so nothing is restarting. Look at what 0.13.1 ' +
        'costs, then ask again.',
    ] });
    expect(await update.goBack(true, '0.12.0')).toEqual({ done: false, lines: [
      'Going back is now offered to 0.12.1, not 0.12.0, so nothing is going back. Look at what each way does, then ask again.',
    ] });
    expect({ restart: update.status().restart, mark: readMark(root), stops }).toEqual({ restart: null, mark: null, stops: [] });
    expect((await update.goBack(false, '0.12.1')).done).toBe(true);
    expect(readMark(root)).toMatchObject({ to: '0.12.1', why: 'go-back' });
    expect(readMark(root)?.keepData ?? false).toBe(false);
    const again = install('0.13.0', ['0.13.1']);
    const restart = hostUpdate({ root: again.root, dataDir: again.dataDir, running: '0.13.0' }, { supervised: true }).update;
    expect((await restart.restartToInstalled('0.13.1')).done).toBe(true);
    expect(readMark(again.root)).toMatchObject({ to: '0.13.1', why: 'update' });
  });

  test("is offered while the copy holds another installed release's data, keeping the data or restoring the copy", async () => {
    const { root, dataDir } = install('0.13.0', ['0.12.1']);
    const { update } = hostUpdate({ root, dataDir, running: '0.13.0' }, { supervised: true });
    expect(update.status().goBack).toBeNull();
    expect(goBackLines(update.status())).toEqual([expect.stringContaining('No Go back is offered')]);
    placeCopy(root, dataDir, '0.12.1', 'm1');
    expect(update.status().goBack).toEqual({ to: '0.12.1', since: '2026-10-20T10:00:00.000Z' });
    expect(goBackLines(update.status())).toEqual([
      'Going back to 0.12.1, whose data the copy holds as it was at 2026-10-20T10:00:00.000Z. Two ways:',
      "- /update back keep: 0.12.1 runs on the data as it is now, so residents lose nothing. If 0.12.1 can't read it, " +
        'its start goes back to 0.13.0 by itself, and /update back restore is the way then.',
      '- /update back restore: the copy is restored, and everything since 2026-10-20T10:00:00.000Z is set aside, not ' +
        'deleted. For residents, that is everything they have lived since then. The host comes back quiesced or serving ' +
        "as the copy holds it, so a quiesce made since then doesn't come back.",
      'Either way the host quiesces first, as Restart does.',
    ]);
    expect(statusLines(update.status())).toContain('Going back to 0.12.1 is offered, with the copy of its data taken ' +
      '2026-10-20T10:00:00.000Z: /update back says what each way does.');
    writeFileSync(copyLabelPath(installPaths(root).copy), 'not json');
    expect(goBackLines(update.status())).toEqual([expect.stringMatching(/^Whether a Go back is offered can't be told: ./)]);
    placeCopy(root, dataDir, '0.12.1', 'm1');
    expect(await update.goBack(true)).toMatchObject({ done: true });
    expect(readMark(root)).toMatchObject({ to: '0.12.1', why: 'go-back', keepData: true });
  });

  test('restoring the copy writes a mark without keepData; a copy of this release offers nothing', async () => {
    const { root, dataDir } = install('0.13.0', ['0.12.1']);
    placeCopy(root, dataDir, '0.12.1', 'm1');
    await hostUpdate({ root, dataDir, running: '0.13.0' }, { supervised: true }).update.goBack(false);
    expect(readMark(root)).toMatchObject({ to: '0.12.1', why: 'go-back' });
    expect(readMark(root)?.keepData).toBeUndefined();
    const same = install('0.12.1');
    placeCopy(same.root, same.dataDir, '0.12.1', 'm2');
    expect((await hostUpdate({ root: same.root, dataDir: same.dataDir }, { supervised: true }).update.goBack(true)).lines)
      .toEqual(["No Go back is offered: the copy doesn't hold another installed release's data."]);
  });
});

describe('the last switch', () => {
  const line = (step: string, outcome: string, extra: Record<string, unknown> = {}) =>
    ({ at: '2026-10-21T09:00:00.000Z', step, from: '0.12.1', to: '0.13.0', outcome, mark: 'm1', ...extra }) as Parameters<typeof appendJournal>[1];

  test('is the journal\'s last commit, fallback or refusal', () => {
    const { root, dataDir } = install('0.12.1');
    const status = () => hostUpdate({ root, dataDir }).update.status().lastSwitch;
    expect(status()).toBeNull();
    appendJournal(root, line('commit', 'ok'));
    expect(status()).toEqual({ outcome: 'committed', from: '0.12.1', to: '0.13.0', at: '2026-10-21T09:00:00.000Z' });
    appendJournal(root, line('children-check', 'refused', { reason: 'fleet children are still running: kid' }));
    expect(status()).toMatchObject({ outcome: 'refused', step: 'children-check', reason: 'fleet children are still running: kid' });
    appendJournal(root, line('copy', 'ok'));
    expect(status()).toMatchObject({ outcome: 'refused' });
    appendJournal(root, line('copy', 'failed', { reason: 'the copy failed: ENOSPC' }));
    expect(statusLines(hostUpdate({ root, dataDir }).update.status()))
      .toContain("Last request: to 0.13.0, didn't go ahead at 2026-10-21T09:00:00.000Z: the copy failed: ENOSPC");
  });

  test("a switch's fallback says what came back, and where what the trial wrote is when it kept none", () => {
    const { root, dataDir } = install('0.12.1');
    appendJournal(root, { at: '2026-10-21T09:00:00.000Z', step: 'fallback', from: '0.13.0', to: '0.12.1', outcome: 'ok', reason: '0.13.0 ended before its commit', mark: 'm1' });
    const status = hostUpdate({ root, dataDir }).update.status();
    expect(status.lastSwitch).toEqual({
      outcome: 'fell-back', from: '0.12.1', to: '0.13.0', at: '2026-10-21T09:00:00.000Z', reason: '0.13.0 ended before its commit',
      trialLog: null,
    });
    expect(statusLines(status)).toContain('Last switch: 0.12.1 came back with its data at 2026-10-21T09:00:00.000Z, from a ' +
      "try of 0.13.0: 0.13.0 ended before its commit. The service's log, or the terminal the host was started in, says more.");
    writeJsonAtomic(installPaths(root).trialLog, { v: 1, release: '0.13.0', mark: 'm1', lines: [] });
    const empty = hostUpdate({ root, dataDir }).update.status();
    expect(empty.lastSwitch).toMatchObject({ outcome: 'fell-back', trialLog: [] });
    expect(statusLines(empty)).toContain(statusLines(status).find((line) => line.startsWith('Last switch: '))!);
  });

  test("a Go back that couldn't start says so, and doesn't say its release wrote anything", () => {
    const { root, dataDir } = install('0.13.0');
    appendJournal(root, { at: '2026-10-21T09:00:00.000Z', step: 'fallback', from: '0.12.1', to: '0.13.0', outcome: 'ok', reason: "0.12.1 couldn't start: its host isn't there", mark: 'm2' });
    expect(statusLines(hostUpdate({ root, dataDir, running: '0.13.0' }).update.status())).toContain('Last switch: 0.13.0 came ' +
      "back with its data at 2026-10-21T09:00:00.000Z, from a try of 0.12.1: 0.12.1 couldn't start: its host isn't there. " +
      "The service's log, or the terminal the host was started in, says more.");
  });

  test("a switch's fallback shows the last lines its trial kept, and a trial log it can't read is a problem, not a lost fallback", () => {
    const { root, dataDir } = install('0.12.1');
    appendJournal(root, { at: '2026-10-21T09:00:00.000Z', step: 'fallback', from: '0.13.0', to: '0.12.1', outcome: 'ok', reason: '0.13.0 ended before its commit', mark: 'm1' });
    const log = { v: 1, release: '0.13.0', mark: 'm1', lines: ['connecting lost', 'Fatal error: Error: no server'] };
    writeJsonAtomic(installPaths(root).trialLog, log);
    const status = hostUpdate({ root, dataDir }).update.status();
    expect(status.lastSwitch).toMatchObject({ outcome: 'fell-back', trialLog: ['connecting lost', 'Fatal error: Error: no server'] });
    const lines = statusLines(status);
    const at = lines.indexOf('Last switch: 0.12.1 came back with its data at 2026-10-21T09:00:00.000Z, from a try of ' +
      '0.13.0: 0.13.0 ended before its commit. What 0.13.0 wrote last, as it kept it (the service\'s log, or the terminal ' +
      'it was started in, also has what this leaves out, such as an error Bun reported itself):');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(lines.slice(at + 1, at + 3)).toEqual(['  connecting lost', '  Fatal error: Error: no server']);
    writeJsonAtomic(installPaths(root).trialLog, { ...log, v: 2 });
    const unread = hostUpdate({ root, dataDir }).update.status();
    expect(unread.lastSwitch).toMatchObject({ outcome: 'fell-back', trialLog: null });
    expect(unread.problems).toEqual([expect.stringContaining(`0.13.0's last lines: The trial log at ${installPaths(root).trialLog}`)]);
  });
});

test('nothing it reads can make the status throw', () => {
  const { root, dataDir } = install('0.12.1');
  writeFileSync(installPaths(root).journal, 'not json\n');
  const status = hostUpdate({ root, dataDir }).update.status();
  expect(status.lastSwitch).toBeNull();
  expect(status.problems).toEqual([expect.stringContaining("the last switch: Line 1 of the journal")]);
  expect(readFileSync(installPaths(root).journal, 'utf-8')).toBe('not json\n');
  const framework: SwitchFramework = { ...fakeFramework().framework, getHostModeStatus: () => { throw new Error('it has stopped'); } };
  rmSync(join(root, 'releases'), { recursive: true });
  writeFileSync(join(root, 'releases'), '');
  mkdirSync(installPaths(root).copy, { recursive: true });
  writeFileSync(copyLabelPath(installPaths(root).copy), 'not json');
  const worse = hostUpdate({ root, dataDir, framework }).update.status();
  expect(worse).toMatchObject({ installed: null, goBack: null, operatorQuiesced: null, switchQuiesceLeft: false });
  expect(worse.problems).toEqual([
    "the host's serving state: it has stopped",
    expect.stringMatching(/^which releases are installed: /),
    expect.stringMatching(/^whether a Go back is offered: /),
    expect.stringContaining('the last switch: Line 1 of the journal'),
  ]);
});

test("/update's text names an install and a restart under way, and what's installed", () => {
  const base: UpdateStatus = {
    running: '0.12.1', install: true, checks: true, check: null, installing: null, lastInstall: null, installed: null,
    goBack: null, restart: null, operatorQuiesced: null, switchQuiesceLeft: false, lastSwitch: null, problems: [],
  };
  expect(statusLines(base)).toEqual(['connectome-host 0.12.1.', "The registry hasn't been read yet: /update reads it."]);
  expect(statusLines({ ...base, installing: '0.13.0', installed: '0.12.2' }).slice(2))
    .toEqual(['Installing 0.13.0.', '0.12.2 is installed: /update restart switches to it.']);
  const fellBack = { outcome: 'fell-back', from: '0.12.1', to: '0.12.2', at: '2026-10-24T03:00:00.000Z', reason: '0.12.2 ended before its commit', trialLog: null } as const;
  expect(statusLines({ ...base, installed: '0.12.2', lastSwitch: fellBack })).toContain(
    '0.12.2 is installed, and ended before its commit at its last try: /update restart tries it again.');
  expect(statusLines({ ...base, installed: '0.12.3', lastSwitch: fellBack })).toContain('0.12.3 is installed: /update restart switches to it.');
  const restart = { to: '0.13.0', why: 'update', keepData: false, hosts: [] } as const;
  const busy: HostQuiet[] = [
    { host: 'this host', answered: true, drained: false, activeTurnAgents: ['alice'], backgroundScripts: 1 },
    { host: 'kid', answered: true, drained: true, activeTurnAgents: [], backgroundScripts: 0 },
    { host: 'pup', answered: false, why: 'it did not answer in time' },
  ];
  expect(statusLines({ ...base, restart: { ...restart, phase: 'busy', hosts: busy } }).slice(2)).toEqual([
    'The restart to 0.13.0 is waiting on turns to end, with new turns held. Busy when its wait ran out:',
    '- this host: mid-turn: alice; 1 background script, which a stop ends',
    "- pup: can't be counted (it did not answer in time)",
    '/update restart wait, /update restart now or /update restart resume.',
  ]);
  expect(statusLines({ ...base, restart: { ...restart, phase: 'ending' } }).at(-1)).toBe("The restart to 0.13.0 is being called off, ending the switch's quiesce.");
  expect(statusLines({ ...base, restart: { ...restart, why: 'go-back', phase: 'stopping' } }).at(-1))
    .toBe('The Go back to 0.13.0 is stopping the host, for its next start.');
  expect(statusLines({ ...base, check: { at: '2026-10-24T05:00:00.000Z', ok: false, error: 'getaddrinfo ENOTFOUND' } })[1])
    .toBe('Reading the registry failed at 2026-10-24T05:00:00.000Z: getaddrinfo ENOTFOUND');
  const deprecated = { at: '2026-10-24T05:00:00.000Z', ok: true, candidate: null, costs: [], bunFloorUnmet: null, runningDeprecated: 'use 0.12.2' } as const;
  expect(statusLines({ ...base, check: { ...deprecated, costs: [] } })).toContain('0.12.1 is deprecated on npm (use 0.12.2).');
  expect(statusLines({ ...base, lastSwitch: { outcome: 'committed', from: '0.12.0', to: '0.12.1', at: '2026-10-23T18:00:00.000Z' } }))
    .toContain('Last switch: 0.12.0 to 0.12.1, committed at 2026-10-23T18:00:00.000Z.');
  expect(statusLines({ ...base, problems: ['the last switch: unreadable'] }).at(-1)).toBe('the last switch: unreadable');
});

describe('/update', () => {
  test('routes each request to its own call, and answers anything else with its usage', async () => {
    const { fetchManifest, asked } = registry({ '0.12.1': {} });
    theHostUpdate.configure({
      here: null, running: '0.12.1', env: { CONNECTOME_UPDATE_CHECK: '0' },
      host: { framework: () => fakeFramework().framework, fleet: () => null },
      fetchManifest, now: () => new Date('2026-10-22T12:00:00.000Z'),
    });
    const app = { framework: {} } as unknown as Parameters<typeof handleCommand>[1];
    const run = async (line: string) => {
      const result = handleCommand(line, app);
      return [...result.lines, ...(result.asyncWork ? (await result.asyncWork).lines : [])].map((l) => l.text);
    };
    const notInstall = expect.stringContaining("wasn't started through an install's entry point");
    const state = [
      'Reading the registry…', 'connectome-host 0.12.1.',
      "No newer release is offered (read at 2026-10-22T12:00:00.000Z): Update offers final releases that aren't deprecated.",
      notInstall,
    ];
    expect(await run('/update')).toEqual(state);
    const reads = asked.length;
    expect(await run('/update check')).toEqual(state);
    expect(asked.length).toBeGreaterThan(reads);
    expect((await run('/help')).join('\n')).toContain('(subcommands: check | install | restart');
    expect(await run('/update back')).toEqual([notInstall]);
    const answer = { done: false, lines: ['answered'] };
    const calls: string[] = [];
    const spies = [
      spyOn(theHostUpdate, 'install').mockImplementation(async () => { calls.push('install'); return answer; }),
      spyOn(theHostUpdate, 'restartToInstalled').mockImplementation(async (expected) => { calls.push(`restart ${expected}`); return answer; }),
      spyOn(theHostUpdate, 'waitLonger').mockImplementation(async () => { calls.push('wait'); return answer; }),
      spyOn(theHostUpdate, 'stopNow').mockImplementation(async () => { calls.push('now'); return answer; }),
      spyOn(theHostUpdate, 'resume').mockImplementation(async () => { calls.push('resume'); return answer; }),
      spyOn(theHostUpdate, 'goBack').mockImplementation(async (keepData, expected) => { calls.push(`back ${keepData} ${expected}`); return answer; }),
    ];
    try {
      const shown: UpdateStatus = {
        running: '0.12.1', install: true, checks: true, check: null, installing: null, lastInstall: null, installed: '0.13.1',
        goBack: { to: '0.12.0', since: 'then' }, restart: null, operatorQuiesced: null, switchQuiesceLeft: false, lastSwitch: null,
        problems: [],
      };
      const ways = (Object.keys(COMMAND_WAYS) as UpdateWay[]).filter((way) => way !== 'back' && way !== 'check');
      for (const way of ways) expect((await run(commandFor(way, shown)!)).at(-1)).toBe('answered');
      expect(calls).toEqual(['install', 'restart 0.13.1', 'wait', 'now', 'resume', 'back true 0.12.0', 'back false 0.12.0']);
      for (const line of ['/update restart', '/update back keep', '/update restart 0.13.1-rc.1', '/update back restore 0.12.0-rc.2']) {
        expect((await run(line)).at(-1)).toBe('answered');
      }
      expect(calls.slice(-4)).toEqual(['restart undefined', 'back true undefined', 'restart 0.13.1-rc.1', 'back false 0.12.0-rc.2']);
      const usage = 'Usage: /update [check | install | restart [wait | now | resume | <version>] | back [(keep | restore) [<version>]]]';
      for (const line of ['/update bogus', '/update check now', '/update install now', '/update restart soon', '/update back later',
        '/update restart now please', '/update restart 0.13.1 now', '/update back keep soon', '/update back 0.12.0',
        '/update back keep 0.12.0 now']) {
        expect(await run(line)).toEqual([usage]);
      }
      expect(calls).toHaveLength(11);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  test('an answer that says it didn\'t do what was asked comes back refused, a check that couldn\'t read the registry included, and one that did doesn\'t', async () => {
    const configure = (fetchManifest: typeof fetch) => theHostUpdate.configure({
      here: null, running: '0.12.1', env: { CONNECTOME_UPDATE_CHECK: '0' },
      host: { framework: () => fakeFramework().framework, fleet: () => null },
      fetchManifest, now: () => new Date('2026-10-22T12:00:00.000Z'),
    });
    const app = { framework: {} } as unknown as Parameters<typeof handleCommand>[1];
    const followUp = (line: string) => handleCommand(line, app).asyncWork!;
    configure(registry({ '0.12.1': {}, '0.13.0': {} }).fetchManifest);
    expect((await followUp('/update check')).refused).toBeUndefined();
    const notInstall = await followUp('/update install');
    expect(notInstall.refused).toBe(true);
    expect(notInstall.lines[0]!.text).toContain("wasn't started through an install's entry point");
    expect(handleCommand('/update bogus', app)).toMatchObject({ refused: true, lines: [{ text: expect.stringContaining('Usage: /update') }] });
    configure(registry({}, 503).fetchManifest);
    for (const line of ['/update check', '/update']) {
      const unread = await followUp(line);
      expect(unread.refused).toBe(true);
      expect(unread.lines.map((l) => l.text)).toContainEqual(expect.stringContaining('Reading the registry failed at'));
    }
  });

  test('back is refused where it can\'t say whether a Go back is offered, at a host that isn\'t an install too, and not where it says', () => {
    const { root, dataDir } = install('0.13.0', ['0.12.1']);
    const configure = (here: UpdateSetup['here']) => theHostUpdate.configure({
      here, running: '0.13.0', env: { CONNECTOME_UPDATE_CHECK: '0' },
      host: { framework: () => fakeFramework().framework, fleet: () => null }, fetchManifest: registry({}).fetchManifest,
    });
    const app = { framework: {} } as unknown as Parameters<typeof handleCommand>[1];
    const back = () => handleCommand('/update back', app);
    configure(null);
    expect(back()).toMatchObject({ refused: true, lines: [{ text: expect.stringContaining("wasn't started through an install's entry point") }] });
    configure({ root, release: '0.13.0' });
    expect(back().refused).toBeUndefined();
    expect(back().lines[0]!.text).toStartWith('No Go back is offered');
    placeCopy(root, dataDir, '0.12.1', 'm1');
    expect(back().refused).toBeUndefined();
    expect(back().lines[0]!.text).toStartWith('Going back to 0.12.1');
    writeFileSync(copyLabelPath(installPaths(root).copy), 'not json');
    expect(back()).toMatchObject({ refused: true, lines: [{ text: expect.stringMatching(/^Whether a Go back is offered can't be told: ./) }] });
  });
});

