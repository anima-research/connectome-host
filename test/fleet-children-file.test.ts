/**
 * The fleet's side of the update contract: the children file an install's
 * launcher reads before a switch, the fleet's record of a child from its
 * spawn, and children that never get the install's root, so none of them
 * acts as the install's host.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FLEET_BEGIN_ENV } from '../src/fleet-begin.js';
import { FleetModule, fleetChildEnv, type FleetModuleConfig } from '../src/modules/fleet-module.js';
import * as contract from '../src/update/contract.js';
import { childrenFilePath, readRecord, type ChildrenFile } from '../src/update/contract.js';
import { processEnded } from './process-ended.js';

type Result = Awaited<ReturnType<FleetModule['handleToolCall']>>;
type Launch = { name: string; recipe: string; dataDir: string; env?: Record<string, string> };
type Internal = { handleLaunch: (input: Launch, opts: { viaAutoStart: boolean }) => Promise<Result> };
type Record_ = { children: Record<string, { name: string; pid: number | null; status: string }> };

const fixtures: Array<{ fleet: FleetModule; dir: string }> = [];
afterEach(async () => {
  for (const { fleet, dir } of fixtures.splice(0)) {
    await fleet.stop().catch(() => { /* already stopped */ });
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.CONNECTOME_INSTALL_ROOT;
});

/** A started fleet whose store is a stand-in: `record` is what it holds, and
 *  `writes` each record set, in order, with each sync between them. */
async function startedFleet(config: FleetModuleConfig = {}, store: { record?: unknown; unreadable?: true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-children-file-'));
  const recipe = join(dir, 'recipe.json');
  writeFileSync(recipe, JSON.stringify({}));
  const fleet = new FleetModule({
    childIndexPath: join(import.meta.dir, 'mock-fleet-lifecycle-child.ts'),
    socketWaitTimeoutMs: 10_000,
    readyTimeoutMs: 10_000,
    gracefulShutdownMs: 100,
    sigtermEscalationMs: 100,
    ...config,
  });
  fixtures.push({ fleet, dir });
  let record: unknown = store.record ?? null;
  const writes: Array<Record_ | 'sync'> = [];
  /** What the children file listed at each sync. */
  const atSync: Array<ChildrenFile['children']> = [];
  fleet.setStoreSync(() => {
    writes.push('sync');
    if (config.childrenFile) {
      try {
        atSync.push(listed(config.childrenFile));
      } catch {
        // A file the test made unreadable: the fleet's own read says so.
      }
    }
  });
  await fleet.start({
    getState: () => {
      if (store.unreadable) throw new Error('the store refused the read');
      return record;
    },
    setState: (next: unknown) => { record = structuredClone(next); writes.push(record as Record_); },
  } as unknown as Parameters<FleetModule['start']>[0]);
  return {
    fleet, dir, writes, atSync, record: () => record,
    input: (name = 'leaf'): Launch => ({ name, recipe, dataDir: join(dir, name) }),
  };
}

const launch = (fleet: FleetModule, input: Launch): Promise<Result> =>
  (fleet as unknown as Internal).handleLaunch(input, { viaAutoStart: true });

/** This machine's boot id, as the fleet reads it, or null where there's none. */
function machineBootId(): string | null {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** A pid no process holds now: one that ran and exited. */
function deadPid(): number {
  return spawnSync('true').pid!;
}

function parentDataDir(): string {
  const parentData = mkdtempSync(join(tmpdir(), 'fleet-children-parent-'));
  fixtures.push({ fleet: new FleetModule({}), dir: parentData });
  return parentData;
}

/** A spy under which each timer of `ms` the fleet arms, the write it makes
 *  a moment after a child's exit, is kept for the test to run, and is
 *  checked to be unref'd, so it holds no host open. */
function laterWrites(ms: number): { rewrites: Array<() => void>; unrefed: () => boolean[]; restore: () => void } {
  const later = globalThis.setTimeout;
  const rewrites: Array<() => void> = [];
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const spy = spyOn(globalThis, 'setTimeout').mockImplementation(((handler: () => void, wait?: number, ...rest: unknown[]) => {
    if (wait !== ms) return later(handler, wait, ...rest);
    rewrites.push(handler);
    // Pending until the restore clears it, so whether it holds the host open
    // is the fleet's unref alone: a timer that has fired holds nothing.
    const timer = later(() => {}, 2 ** 31 - 1);
    timers.push(timer);
    return timer;
  }) as typeof setTimeout);
  return {
    rewrites,
    unrefed: () => timers.map((timer) => !timer.hasRef()),
    restore: () => {
      spy.mockRestore();
      for (const timer of timers) clearTimeout(timer);
    },
  };
}

/** A process group whose leader has ended while a process of it still runs,
 *  as a child's that left a helper behind: its id, and how to end it. A live
 *  leader wouldn't do: a pid isn't handed out while a group with that id has
 *  a member, so the fleet reads a live process at an ended child's pid as
 *  another's. */
async function leaderlessGroup(): Promise<{ pid: number; end: () => void }> {
  const leader = spawn('sh', ['-c', 'sleep 60 & exit 0'], { detached: true, stdio: 'ignore' });
  await new Promise((ended) => leader.once('exit', ended));
  const pid = leader.pid!;
  return { pid, end: () => { try { process.kill(-pid, 'SIGKILL'); } catch { /* the group has ended */ } } };
}

/** Waits until `ready` holds, for up to 8 s. */
async function until(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline && !ready()) await Bun.sleep(10);
}

const listed = (file: string) => readRecord<ChildrenFile>(file, 'children file')?.children ?? [];

/** Whether a process holds this pid: a signal finds it, or finds it isn't ours. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}


/** Waits until `ready` holds, for up to 30 s, or throws naming `what`. */
async function waitFor(ready: () => boolean, what: string, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting until ${what}`);
    await Bun.sleep(10);
  }
}

/** Holds this thread, as a slow disk holds a write, until `ready` holds or
 *  `ms` has passed, and says whether it held. */
function holdUntil(ready: () => boolean, ms: number): boolean {
  const deadline = Date.now() + ms;
  while (!ready() && Date.now() < deadline) { /* held */ }
  return ready();
}

/** The stand-in child, started as a fleet that keeps the children file
 *  starts it, told to begin on its stdin, with `options` as its recipe. */
const standIns: ChildProcess[] = [];
/** What a stand-in has written on its stderr. */
const stderrOf = new WeakMap<ChildProcess, string[]>();
function standIn(dir: string, options: Record<string, unknown>): ChildProcess {
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const recipe = join(dir, 'stand-in.json');
  writeFileSync(recipe, JSON.stringify(options));
  const child = spawn(process.execPath, [join(import.meta.dir, 'mock-fleet-lifecycle-child.ts'), recipe, '--headless'], {
    env: { ...process.env, DATA_DIR: dataDir, [FLEET_BEGIN_ENV]: 'line' }, stdio: ['pipe', 'ignore', 'pipe'],
  });
  const written: string[] = [];
  stderrOf.set(child, written);
  child.stderr!.on('data', (chunk: Buffer) => { written.push(chunk.toString()); });
  child.stdin!.on('error', () => { /* a child that has ended */ });
  standIns.push(child);
  return child;
}
afterEach(() => {
  for (const child of standIns.splice(0)) {
    try { child.kill('SIGKILL'); } catch { /* gone */ }
  }
});

/** How long a told stand-in takes here from coming to its wait to beginning,
 *  measured once. Each hold that shows a child hasn't begun is many of these,
 *  so it holds as long on a loaded machine as on an idle one. */
let beginTime: number | undefined;
async function holdForBegin(): Promise<number> {
  if (beginTime === undefined) {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-begin-time-'));
    try {
      const atGate = join(dir, 'at-gate');
      const begun = join(dir, 'begun');
      const child = standIn(dir, { atGate, begun });
      await waitFor(() => existsSync(atGate), 'the measured child came to its wait');
      const from = Date.now();
      child.stdin!.write('\n');
      await waitFor(() => existsSync(begun), 'the measured child began');
      beginTime = Date.now() - from;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return Math.max(1_000, 20 * beginTime);
}

describe("the fleet's children file", () => {
  test("lists each child with its data directory, and the process of each that may be running, with the machine's boot", async () => {
    const childrenFile = childrenFilePath(parentDataDir());
    const { fleet, input } = await startedFleet({ childrenFile });
    expect((await launch(fleet, input('leaf'))).success).toBe(true);
    expect((await launch(fleet, input('twig'))).success).toBe(true);
    const pid = (name: string) => fleet.getChildren().get(name)!.pid;
    expect(pid('leaf')).toBeNumber();
    const boot = machineBootId();
    expect(listed(childrenFile)).toEqual([
      { name: 'leaf', pid: pid('leaf'), bootId: boot, dataDir: input('leaf').dataDir },
      { name: 'twig', pid: pid('twig'), bootId: boot, dataDir: input('twig').dataDir },
    ]);

    // Its group had nothing else, so its signal finds none, which is no failure.
    const logged: string[] = [];
    const log = spyOn(console, 'error').mockImplementation((line) => { logged.push(String(line)); });
    try {
      expect((await fleet.handleToolCall({ id: 'kill', name: 'kill', input: { name: 'twig' } })).success).toBe(true);
    } finally {
      log.mockRestore();
    }
    expect(logged.filter((line) => line.includes("couldn't end what's left"))).toEqual([]);
    expect(listed(childrenFile)).toEqual([
      { name: 'leaf', pid: pid('leaf'), bootId: boot, dataDir: input('leaf').dataDir },
      { name: 'twig', pid: null, bootId: boot, dataDir: input('twig').dataDir },
    ]);
  });

  test("a child's boot is null where the machine gives none", async () => {
    const childrenFile = childrenFilePath(parentDataDir());
    const noBoot = spyOn(FleetModule.prototype as unknown as { bootId: () => string | undefined }, 'bootId')
      .mockReturnValue(undefined);
    try {
      const { fleet, input } = await startedFleet({ childrenFile });
      expect((await launch(fleet, input())).success).toBe(true);
      expect(listed(childrenFile)).toEqual([
        { name: 'leaf', pid: fleet.getChildren().get('leaf')!.pid, bootId: null, dataDir: input().dataDir },
      ]);
    } finally {
      noBoot.mockRestore();
    }
  });

  test('a child is in the record, synced, and then in the file, from the moment its process exists, before it is ready', async () => {
    const childrenFile = childrenFilePath(parentDataDir());
    const { fleet, input, writes, atSync } = await startedFleet({ childrenFile });
    // A child that never opens its socket stays starting until something ends it.
    writeFileSync(input().recipe, JSON.stringify({ noSocket: true }));
    const launched = launch(fleet, input());
    await until(() => typeof listed(childrenFile).find((c) => c.name === 'leaf')?.pid === 'number');
    const child = fleet.getChildren().get('leaf')!;
    expect(child.status).toBe('starting');
    expect(listed(childrenFile).find((c) => c.name === 'leaf')?.pid).toBe(child.pid);
    // The record held the starting child, with its pid, and was synced before
    // the file listed it.
    const recorded = writes.findIndex((w) => w !== 'sync' && w.children.leaf?.status === 'starting' && w.children.leaf.pid === child.pid);
    expect(recorded).toBeGreaterThanOrEqual(0);
    expect(writes[recorded + 1]).toBe('sync');
    // At that sync, the file didn't list the child yet: it follows the record.
    expect(atSync[0]).toEqual([]);
    // Stopping the fleet ends the child, and with it the launch.
    await fleet.stop();
    expect((await launched).success).toBe(false);
  });

  test('a fleet started on a record taken while a child starts keeps the child, lists it, and starts no second copy', async () => {
    const childrenFile = childrenFilePath(parentDataDir());
    const first = await startedFleet({ childrenFile });
    writeFileSync(first.input().recipe, JSON.stringify({ noSocket: true }));
    const launched = launch(first.fleet, first.input());
    await until(() => typeof listed(childrenFile).find((c) => c.name === 'leaf')?.pid === 'number');
    const pid = first.fleet.getChildren().get('leaf')!.pid!;
    // The next parent, as after this one was killed: its store holds the record
    // made at the spawn.
    const next = await startedFleet({ childrenFile }, { record: first.record() });
    expect(next.fleet.getChildren().get('leaf')).toMatchObject({ status: 'starting', pid });
    expect(listed(childrenFile)).toEqual([{ name: 'leaf', pid, bootId: machineBootId(), dataDir: first.input().dataDir }]);
    const again = await launch(next.fleet, first.input());
    expect(again.success).toBe(false);
    const launches = join(first.input().dataDir, 'launches.jsonl');
    await until(() => existsSync(launches));
    expect(readFileSync(launches, 'utf8').trim().split('\n')).toHaveLength(1);
    await first.fleet.stop();
    expect((await launched).success).toBe(false);
  });

  test('a fleet adopting its living children writes its record and the file once, holding them all', async () => {
    const childrenFile = childrenFilePath(parentDataDir());
    const first = await startedFleet({ childrenFile });
    expect((await launch(first.fleet, first.input('leaf'))).success).toBe(true);
    expect((await launch(first.fleet, first.input('twig'))).success).toBe(true);
    const write = spyOn(contract, 'writeJsonAtomic');
    let next: Awaited<ReturnType<typeof startedFleet>>;
    let fileWrites: number;
    try {
      next = await startedFleet({ childrenFile }, { record: first.record() });
      fileWrites = write.mock.calls.filter(([path]) => path === childrenFile).length;
    } finally {
      write.mockRestore();
    }
    expect(fileWrites).toBe(1);
    expect(next.fleet.getChildren().get('leaf')?.adopted).toBe(true);
    expect(next.fleet.getChildren().get('twig')?.adopted).toBe(true);
    // Each reattached child's ready event came while the map held only the
    // children taken back so far; nothing was written until all were back.
    const records = next.writes.filter((w): w is Record_ => w !== 'sync');
    expect(records.map((w) => Object.keys(w.children).sort())).toEqual([['leaf', 'twig']]);
    expect(listed(childrenFile).map((c) => c.name)).toEqual(['leaf', 'twig']);
  });

  test("a write keeps what it doesn't replace: another directory's entry, with its pid only while it may run, another generation still running in its own child's directory, and an entry it can't read as a child, on a machine that gives a boot id and on one that gives none", async () => {
    for (const givesNone of [false, true]) {
      const noBoot = givesNone
        ? spyOn(FleetModule.prototype as unknown as { bootId: () => string | undefined }, 'bootId').mockReturnValue(undefined)
        : undefined;
      try {
        const parentData = parentDataDir();
        const childrenFile = childrenFilePath(parentData);
        const { fleet, input } = await startedFleet({ childrenFile });
        const boot = givesNone ? null : machineBootId();
        // This test's own process stands for a child that still runs.
        const running = { name: 'kid-of-another-session', pid: process.pid, bootId: boot, dataDir: join(parentData, 'elsewhere') };
        const stopped = { name: 'old-kid', pid: deadPid(), bootId: boot, dataDir: join(parentData, 'gone') };
        const sameDirRunning = { name: 'another-generation', pid: process.pid, bootId: boot, dataDir: input().dataDir };
        const sameDirStopped = { name: 'earlier-generation', pid: deadPid(), bootId: boot, dataDir: input().dataDir };
        // A pid of this boot's held by a live process, under another boot's
        // id, isn't that child's; under no boot id at all, it may be.
        const otherBoot = { name: 'kid-of-another-boot', pid: process.pid, bootId: 'another-boot', dataDir: join(parentData, 'rebooted') };
        const unknownBoot = { name: 'kid-of-an-unknown-boot', pid: process.pid, bootId: null, dataDir: join(parentData, 'unknown') };
        const sameDirOtherBoot = { name: 'rebooted-generation', pid: process.pid, bootId: 'another-boot', dataDir: input().dataDir };
        // Entries without a child's shape, kept as they are.
        const unreadable = [
          { name: 'no-directory', pid: 12, bootId: null },
          { name: 'odd-pid', pid: 'twelve', bootId: null, dataDir: join(parentData, 'odd') },
          { dataDir: join(parentData, 'nameless'), note: 'from elsewhere' },
          null,
        ];
        writeFileSync(childrenFile, JSON.stringify({
          v: 1,
          children: [running, sameDirStopped, sameDirRunning, sameDirOtherBoot, otherBoot, unknownBoot, ...unreadable, stopped],
        }));
        expect((await launch(fleet, input())).success).toBe(true);
        // Where the machine gives no boot id, as on macOS, nothing tells
        // another boot's pid from this one's, so the launcher reads a live one
        // as possibly running, and the write keeps it.
        expect(listed(childrenFile)).toEqual([
          { name: 'leaf', pid: fleet.getChildren().get('leaf')!.pid, bootId: boot, dataDir: input().dataDir },
          running,
          sameDirRunning,
          ...(boot === null ? [sameDirOtherBoot] : []),
          boot === null ? otherBoot : { ...otherBoot, pid: null },
          unknownBoot,
          ...unreadable,
          { ...stopped, pid: null },
        ] as ChildrenFile['children']);
      } finally {
        noBoot?.mockRestore();
      }
    }
  });

  test("the pid a child the fleet has seen exit had can't stand for a live process that holds it now", async () => {
    const childrenFile = childrenFilePath(parentDataDir());
    const { fleet, input } = await startedFleet({ childrenFile });
    expect((await launch(fleet, input('leaf'))).success).toBe(true);
    expect((await fleet.handleToolCall({ id: 'kill', name: 'kill', input: { name: 'leaf' } })).success).toBe(true);
    // As if the exited child's pid had since been reused by a live process
    // leading a group of its own, which an entry of another session lists for
    // the same directory.
    const reused = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    try {
      (fleet.getChildren().get('leaf') as { pid: number | null }).pid = reused.pid!;
      const live = { name: 'another-generation', pid: reused.pid!, bootId: machineBootId(), dataDir: input('leaf').dataDir };
      // And one with the child's own name, as the file's own earlier entry for
      // it would be had its pid been taken before the retirement's write: kept,
      // a hold the launcher names, rather than told apart from a live writer's.
      const sameName = { ...live, name: 'leaf' };
      writeFileSync(childrenFile, JSON.stringify({ v: 1, children: [...listed(childrenFile), live, sameName] }));
      expect((await launch(fleet, input('twig'))).success).toBe(true);
      expect(listed(childrenFile).filter((c) => c.dataDir === input('leaf').dataDir)).toEqual([
        { name: 'leaf', pid: null, bootId: machineBootId(), dataDir: input('leaf').dataDir },
        live,
        sameName,
      ]);
    } finally {
      reused.kill('SIGKILL');
    }
  });

  test("a child that ended while no host ran stays listed while a helper remains in its group, which isn't signalled, and its pid goes once the group has ended", async () => {
    const childrenFile = childrenFilePath(parentDataDir());
    const first = await startedFleet({ childrenFile });
    const helperPid = join(first.dir, 'helper.pid');
    writeFileSync(first.input().recipe, JSON.stringify({ helperPid }));
    expect((await launch(first.fleet, first.input())).success).toBe(true);
    const helper = Number(readFileSync(helperPid, 'utf8'));
    const leader = first.fleet.getChildren().get('leaf')!.pid!;
    try {
      // The first host has gone, as a real one would be: nothing of it hears
      // the child end, which leaves its helper behind in its group.
      first.fleet.getChildren().get('leaf')!.process!.removeAllListeners('exit');
      process.kill(leader, 'SIGKILL');
      await until(() => !isAlive(leader));
      expect(isAlive(leader)).toBe(false);
      const next = await startedFleet({ childrenFile }, { record: first.record() });
      expect(next.fleet.getChildren().get('leaf')).toMatchObject({ status: 'crashed', pid: leader });
      expect(listed(childrenFile)).toEqual([{ name: 'leaf', pid: leader, bootId: machineBootId(), dataDir: first.input().dataDir }]);
      expect(isAlive(helper)).toBe(true);
      process.kill(helper, 'SIGKILL');
      await until(() => !isAlive(helper));
      expect((await launch(next.fleet, next.input('twig'))).success).toBe(true);
      expect(listed(childrenFile).find((c) => c.name === 'leaf')).toEqual(
        { name: 'leaf', pid: null, bootId: machineBootId(), dataDir: first.input().dataDir });
      // Its group found empty, it's done with: a live group that takes its
      // pid later doesn't bring it back.
      const reused = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
      try {
        (next.fleet.getChildren().get('leaf') as { pid: number | null }).pid = reused.pid!;
        expect((await launch(next.fleet, next.input('branch'))).success).toBe(true);
        expect(listed(childrenFile).find((c) => c.name === 'leaf')).toEqual(
          { name: 'leaf', pid: null, bootId: machineBootId(), dataDir: first.input().dataDir });
      } finally {
        reused.kill('SIGKILL');
      }
    } finally {
      try { process.kill(helper, 'SIGKILL'); } catch { /* gone */ }
    }
  });

  test("an ended child whose record doesn't say its group has ended, as an earlier version's doesn't, is retired once a live process holds its pid, whatever group that process leads", async () => {
    const childrenFile = childrenFilePath(parentDataDir());
    const first = await startedFleet({ childrenFile });
    expect((await launch(first.fleet, first.input())).success).toBe(true);
    expect((await first.fleet.handleToolCall({ id: 'kill', name: 'kill', input: { name: 'leaf' } })).success).toBe(true);
    const record = structuredClone(first.record()) as { children: Record<string, { pid: number | null; groupEnded?: boolean }> };
    delete record.children.leaf!.groupEnded;
    // As if its pid had been taken since by a process leading a group of its
    // own, which it can be only once the child's group has ended.
    const reused = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    try {
      record.children.leaf!.pid = reused.pid!;
      const next = await startedFleet({ childrenFile }, { record });
      expect((await launch(next.fleet, next.input('twig'))).success).toBe(true);
      expect(listed(childrenFile).find((c) => c.name === 'leaf')).toEqual(
        { name: 'leaf', pid: null, bootId: machineBootId(), dataDir: first.input().dataDir });
      expect(next.fleet.getChildren().get('leaf')).toMatchObject({ groupEnded: true });
    } finally {
      reused.kill('SIGKILL');
    }
  });

  test("an earlier entry in a listed child's own directory whose process has ended is kept while the group it led has a member, and dropped once that group is empty", async () => {
    const childrenFile = childrenFilePath(parentDataDir());
    const { fleet, input } = await startedFleet({ childrenFile });
    // An earlier generation's leader has ended, and a process of its group
    // still runs.
    const earlier = await leaderlessGroup();
    const entry = { name: 'earlier-generation', pid: earlier.pid, bootId: machineBootId(), dataDir: input().dataDir };
    try {
      writeFileSync(childrenFile, JSON.stringify({ v: 1, children: [entry] }));
      expect((await launch(fleet, input())).success).toBe(true);
      expect(listed(childrenFile)).toContainEqual(entry);
      earlier.end();
      await waitFor(() => { try { process.kill(-earlier.pid, 0); return false; } catch { return true; } }, 'the group emptied');
      expect((await launch(fleet, input('twig'))).success).toBe(true);
      expect(listed(childrenFile).find((c) => c.name === 'earlier-generation')).toBeUndefined();
    } finally {
      earlier.end();
    }
  });

  test("a child whose group the fleet ended stays unlisted once its host restarts, though a group holds its pid's id now, its leader live or ended", async () => {
    const childrenFile = childrenFilePath(parentDataDir());
    const first = await startedFleet({ childrenFile });
    expect((await launch(first.fleet, first.input())).success).toBe(true);
    expect((await first.fleet.handleToolCall({ id: 'kill', name: 'kill', input: { name: 'leaf' } })).success).toBe(true);
    const record = structuredClone(first.record()) as { children: Record<string, { pid: number | null; groupEnded?: boolean }> };
    expect(record.children.leaf!.groupEnded).toBe(true);
    // As if the ended child's pid had since been taken by a process leading a
    // group of its own: one still running, and one that has ended while its
    // group runs on, which only the record's own word tells from the child's.
    const reused = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    const leaderless = await leaderlessGroup();
    try {
      for (const pid of [reused.pid!, leaderless.pid]) {
        record.children.leaf!.pid = pid;
        const next = await startedFleet({ childrenFile }, { record });
        expect((await launch(next.fleet, next.input('twig'))).success).toBe(true);
        expect(listed(childrenFile).find((c) => c.name === 'leaf')).toEqual(
          { name: 'leaf', pid: null, bootId: machineBootId(), dataDir: first.input().dataDir });
        // So the next iteration's listing is its own fleet's alone.
        await next.fleet.stop();
      }
    } finally {
      reused.kill('SIGKILL');
      leaderless.end();
    }
  });

  test("a child of this fleet's from an earlier boot isn't listed by a pid a live group holds now, told by its boot id or by its start against the machine's uptime", async () => {
    const childrenFile = childrenFilePath(parentDataDir());
    const first = await startedFleet({ childrenFile });
    expect((await launch(first.fleet, first.input())).success).toBe(true);
    expect((await first.fleet.handleToolCall({ id: 'kill', name: 'kill', input: { name: 'leaf' } })).success).toBe(true);
    const live = await leaderlessGroup();
    type Kept = { children: Record<string, { pid: number | null; groupEnded?: boolean; bootId?: string; startedAt: number; status: string }> };
    const as = (change: (leaf: Kept['children'][string]) => void): Kept => {
      const record = structuredClone(first.record()) as Kept;
      const leaf = record.children.leaf!;
      delete leaf.groupEnded;
      leaf.status = 'crashed';
      leaf.pid = live.pid;
      change(leaf);
      return record;
    };
    const leafOf = () => listed(childrenFile).find((c) => c.name === 'leaf');
    try {
      if (machineBootId() !== null) {
        const next = await startedFleet({ childrenFile }, { record: as((leaf) => { leaf.bootId = 'an-earlier-boot'; }) });
        expect((await launch(next.fleet, next.input('twig'))).success).toBe(true);
        expect(leafOf()?.pid).toBeNull();
      }
      const noBoot = spyOn(FleetModule.prototype as unknown as { bootId: () => string | undefined }, 'bootId').mockReturnValue(undefined);
      try {
        for (const [startedAt, pid] of [[1, null], [Date.now(), live.pid]] as const) {
          const next = await startedFleet({ childrenFile }, { record: as((leaf) => { delete leaf.bootId; leaf.startedAt = startedAt; }) });
          expect((await launch(next.fleet, next.input('twig'))).success).toBe(true);
          expect(leafOf()?.pid).toBe(pid);
        }
      } finally {
        noBoot.mockRestore();
      }
    } finally {
      live.end();
    }
  });

  test("a record whose group has ended isn't adopted again, though a live process holds its pid now", async () => {
    const childrenFile = childrenFilePath(parentDataDir());
    const first = await startedFleet({ childrenFile });
    expect((await launch(first.fleet, first.input())).success).toBe(true);
    expect((await first.fleet.handleToolCall({ id: 'kill', name: 'kill', input: { name: 'leaf' } })).success).toBe(true);
    const live = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    try {
      // As left by an adoption that failed, and then found the group empty,
      // its pid since taken.
      const record = structuredClone(first.record()) as { children: Record<string, { pid: number | null; status: string; exitReason: string | null; groupEnded?: boolean }> };
      const leaf = record.children.leaf!;
      expect(leaf.groupEnded).toBe(true);
      leaf.status = 'crashed';
      (leaf as { exitedAt: number | null }).exitedAt = null;
      leaf.exitReason = 'adoption unresolved; fleet--restart of it, or fleet--launch with its recipe and dataDir, probes it again';
      leaf.pid = live.pid!;
      const next = await startedFleet({ childrenFile }, { record });
      expect(next.fleet.getChildren().get('leaf')!.status).toBe('crashed');
      expect(next.fleet.getChildren().get('leaf')!.adopted).toBeUndefined();
      expect((await launch(next.fleet, next.input('twig'))).success).toBe(true);
      expect(listed(childrenFile).find((c) => c.name === 'leaf')?.pid).toBeNull();
    } finally {
      live.kill('SIGKILL');
    }
  });

  test("a group the fleet may not signal, or probe, stays listed, and the host says why", async () => {
    const childrenFile = childrenFilePath(parentDataDir());
    const { fleet, dir, input } = await startedFleet({ childrenFile });
    const helperPid = join(dir, 'helper.pid');
    writeFileSync(input().recipe, JSON.stringify({ helperPid }));
    expect((await launch(fleet, input())).success).toBe(true);
    const leader = fleet.getChildren().get('leaf')!.pid!;
    const helper = Number(readFileSync(helperPid, 'utf8'));
    const kill = process.kill.bind(process);
    const refused = spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      if (pid === -leader) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      return kill(pid, signal);
    }) as typeof process.kill);
    const logged: string[] = [];
    const log = spyOn(console, 'error').mockImplementation((line) => { logged.push(String(line)); });
    try {
      kill(leader, 'SIGKILL');
      await waitFor(() => fleet.getChildren().get('leaf')?.status === 'crashed', 'the child exited');
      expect(isAlive(helper)).toBe(true);
      expect(listed(childrenFile)).toEqual([{ name: 'leaf', pid: leader, bootId: machineBootId(), dataDir: input().dataDir }]);
      expect(logged).toContain(`[fleet] couldn't end what's left of child "leaf"'s process group (${leader}): EPERM, so the ` +
        'children file lists the child while that group may have a process.');
      // Its stop says the signal was refused, not that a process outlasted
      // it, and waits for nothing, since no signal went out.
      const probe = fleet as unknown as { groupInUse: (pid: number | null) => boolean };
      const probing = spyOn(probe, 'groupInUse');
      let result: Result;
      let probes: number;
      try {
        result = await fleet.handleToolCall({ id: 'kill', name: 'kill', input: { name: 'leaf' } });
      } finally {
        probes = probing.mock.calls.length;
        probing.mockRestore();
      }
      expect(probes).toBeLessThanOrEqual(2);
      expect((result.data as { note?: string }).note).toStartWith(`already stopped. Its process has ended, but process ` +
        `group ${leader}, which it led, still has a process, which this host's SIGKILL couldn't reach (EPERM). `);
    } finally {
      refused.mockRestore();
      log.mockRestore();
      try { process.kill(helper, 'SIGKILL'); } catch { /* gone */ }
    }
    // A host with no children file says the refusal alone.
    const bare = await startedFleet();
    writeFileSync(bare.input().recipe, JSON.stringify({}));
    expect((await launch(bare.fleet, bare.input())).success).toBe(true);
    const bareLeader = bare.fleet.getChildren().get('leaf')!.pid!;
    const refusing = spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      if (pid === -bareLeader) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      return kill(pid, signal);
    }) as typeof process.kill);
    const bareLogged: string[] = [];
    const bareLog = spyOn(console, 'error').mockImplementation((line) => { bareLogged.push(String(line)); });
    try {
      kill(bareLeader, 'SIGKILL');
      await waitFor(() => bare.fleet.getChildren().get('leaf')?.status === 'crashed', 'the child exited');
      expect(bareLogged).toContain(`[fleet] couldn't end what's left of child "leaf"'s process group (${bareLeader}): EPERM.`);
    } finally {
      refusing.mockRestore();
      bareLog.mockRestore();
    }
  });

  test("a child's entry keeps its pid while what it left in its group is still there, though the group was signalled, and loses it at the fleet's own write once that has gone, with no other event", async () => {
    const childrenFile = childrenFilePath(parentDataDir());
    // The write after the exit is armed for the time a stop gives a group,
    // here a minute, and run below once the group has ended.
    const { fleet, dir, input } = await startedFleet({ childrenFile, groupEndWaitMs: 60_000 });
    const helperPid = join(dir, 'helper.pid');
    writeFileSync(input().recipe, JSON.stringify({ helperPid }));
    expect((await launch(fleet, input())).success).toBe(true);
    const leader = fleet.getChildren().get('leaf')!.pid!;
    const helper = Number(readFileSync(helperPid, 'utf8'));
    // The group's signal is sent, and what it reaches hasn't ended by the
    // write, as a SIGKILL can take a moment.
    const kill = process.kill.bind(process);
    const slow = spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      if (pid === -leader && signal === 'SIGKILL') return true;
      return kill(pid, signal);
    }) as typeof process.kill);
    const later = laterWrites(60_000);
    const rewrites = later.rewrites;
    try {
      kill(leader, 'SIGKILL');
      await waitFor(() => fleet.getChildren().get('leaf')?.status === 'crashed', 'the child exited');
      expect(isAlive(helper)).toBe(true);
      expect(listed(childrenFile)).toEqual([{ name: 'leaf', pid: leader, bootId: machineBootId(), dataDir: input().dataDir }]);
      expect(rewrites).toHaveLength(1);
      expect(later.unrefed()).toEqual([true]);
      kill(helper, 'SIGKILL');
      // Reaped too, so its group has no member left.
      await waitFor(() => { try { kill(-leader, 0); return false; } catch { return true; } }, 'the group emptied');
      // The fleet's own write after the exit finds the group empty.
      rewrites[0]!();
      expect(listed(childrenFile)).toEqual([{ name: 'leaf', pid: null, bootId: machineBootId(), dataDir: input().dataDir }]);
    } finally {
      later.restore();
      slow.mockRestore();
      try { process.kill(helper, 'SIGKILL'); } catch { /* gone */ }
    }
  });

  test("a child whose group is found empty at its exit's write is retired then, and the fleet arms no later write for it", async () => {
    const childrenFile = childrenFilePath(parentDataDir());
    const { fleet, input } = await startedFleet({ childrenFile, groupEndWaitMs: 60_000 });
    expect((await launch(fleet, input())).success).toBe(true);
    const leader = fleet.getChildren().get('leaf')!.pid!;
    const later = laterWrites(60_000);
    try {
      process.kill(leader, 'SIGKILL');
      await waitFor(() => fleet.getChildren().get('leaf')?.status === 'crashed', 'the child exited');
      expect(listed(childrenFile)).toEqual([{ name: 'leaf', pid: null, bootId: machineBootId(), dataDir: input().dataDir }]);
      expect(later.rewrites).toHaveLength(0);
    } finally {
      later.restore();
    }
  });

  test("the fleet's own write after a child's exit, should the store refuse it, is logged, not thrown", async () => {
    const childrenFile = childrenFilePath(parentDataDir());
    const { fleet, dir, input } = await startedFleet({ childrenFile, groupEndWaitMs: 60_000 });
    const helperPid = join(dir, 'helper.pid');
    writeFileSync(input().recipe, JSON.stringify({ helperPid }));
    expect((await launch(fleet, input())).success).toBe(true);
    const leader = fleet.getChildren().get('leaf')!.pid!;
    const helper = Number(readFileSync(helperPid, 'utf8'));
    const kill = process.kill.bind(process);
    const slow = spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      if (pid === -leader && signal === 'SIGKILL') return true;
      return kill(pid, signal);
    }) as typeof process.kill);
    const later = laterWrites(60_000);
    const rewrites = later.rewrites;
    const logged: string[] = [];
    try {
      kill(leader, 'SIGKILL');
      await waitFor(() => fleet.getChildren().get('leaf')?.status === 'crashed', 'the child exited');
      expect(rewrites).toHaveLength(1);
      (fleet as unknown as { ctx: { setState: () => void } }).ctx.setState = () => { throw new Error('the store refused the write'); };
      const log = spyOn(console, 'error').mockImplementation((line) => { logged.push(String(line)); });
      try {
        // A timer's callback that throws would end the host.
        expect(() => rewrites[0]!()).not.toThrow();
      } finally {
        log.mockRestore();
      }
      expect(logged).toContain('[fleet] couldn\'t record child "leaf"\'s state after its exit: the store refused the write');
    } finally {
      later.restore();
      slow.mockRestore();
      try { process.kill(helper, 'SIGKILL'); } catch { /* gone */ }
    }
  });

  /** A spy under which the fleet finds the group a pid led in use while
   *  `held` says so, as a group whose SIGKILL is slow to end it. */
  function holdGroups(fleet: FleetModule, held: (pid: number | null) => boolean): { restore: () => void } {
    const probe = fleet as unknown as { groupInUse: (pid: number | null) => boolean };
    const inUse = probe.groupInUse.bind(fleet);
    const spy = spyOn(probe, 'groupInUse').mockImplementation((pid) => held(pid) || inUse(pid));
    return { restore: () => spy.mockRestore() };
  }

  test("a stop returns once the group it signalled is found empty, listing no pid then, a stop of a child that has just exited and the host's stop included", async () => {
    const childrenFile = childrenFilePath(parentDataDir());
    // A wait long enough that only the group's end can end it here.
    const { fleet, dir, input } = await startedFleet({ childrenFile, groupEndWaitMs: 60_000 });
    // Each child leaves a helper in its group, so the signal to it goes out.
    writeFileSync(input().recipe, JSON.stringify({ helperPid: join(dir, 'helper.pid') }));
    for (const name of ['leaf', 'twig', 'bud']) expect((await launch(fleet, input(name))).success).toBe(true);
    const pids = new Map([...fleet.getChildren()].map(([name, c]) => [name, c.pid!]));
    const holding = new Set(pids.values());
    const held = holdGroups(fleet, (pid) => pid !== null && holding.has(pid));
    /** Starts `stop`, waits until the group's signal has gone out, then shows
     *  the stop still waiting and the pid still listed while the group is
     *  held, and done, with no pid, once it's let go. */
    const waitsFor = async (name: string, stop: () => Promise<unknown>): Promise<unknown> => {
      let settled = false;
      const stopping = stop().then((result) => { settled = true; return result; });
      await waitFor(() => fleet.getChildren().get(name)?.groupSignal === 'sent', `${name}'s signal to its group`);
      await new Promise((wait) => setTimeout(wait, 500));
      expect(settled, name).toBe(false);
      expect(listed(childrenFile).find((c) => c.name === name)?.pid, name).toBe(pids.get(name));
      holding.delete(pids.get(name)!);
      const result = await stopping;
      expect(listed(childrenFile).find((c) => c.name === name)?.pid, name).toBeNull();
      return result;
    };
    try {
      const result = await waitsFor('leaf', () => fleet.handleToolCall({ id: 'kill', name: 'kill', input: { name: 'leaf' } })) as Result;
      expect(result.success).toBe(true);
      expect((result.data as { note?: string }).note).toBeUndefined();
      // A child that has just exited, its group still ending: fleet--kill waits.
      process.kill(pids.get('twig')!, 'SIGKILL');
      await waitFor(() => fleet.getChildren().get('twig')?.status === 'crashed', 'twig exited');
      const again = await waitsFor('twig', () => fleet.handleToolCall({ id: 'kill-twig', name: 'kill', input: { name: 'twig' } })) as Result;
      expect((again.data as { note?: string }).note).toBe('already stopped');
      // And the host's stop, of a child that has just exited.
      process.kill(pids.get('bud')!, 'SIGKILL');
      await waitFor(() => fleet.getChildren().get('bud')?.status === 'crashed', 'bud exited');
      await waitsFor('bud', () => fleet.stop());
    } finally {
      held.restore();
    }
  }, 60_000);

  test("a stop whose group outlasts its wait returns after it, keeps its pid, says so, and a later write retires it", async () => {
    const childrenFile = childrenFilePath(parentDataDir());
    const { fleet, dir, input } = await startedFleet({ childrenFile, groupEndWaitMs: 300 });
    writeFileSync(input().recipe, JSON.stringify({ helperPid: join(dir, 'helper.pid') }));
    expect((await launch(fleet, input('twig'))).success).toBe(true);
    const twig = fleet.getChildren().get('twig')!.pid!;
    let holdingTwig = true;
    const held = holdGroups(fleet, (pid) => pid === twig && holdingTwig);
    try {
      const began = Date.now();
      const outlasted = await fleet.handleToolCall({ id: 'kill-twig', name: 'kill', input: { name: 'twig' } });
      expect(Date.now() - began).toBeGreaterThanOrEqual(300);
      expect(listed(childrenFile).find((c) => c.name === 'twig')?.pid).toBe(twig);
      expect((outlasted.data as { note?: string }).note).toStartWith(`Its process has ended, but process group ${twig}, ` +
        'which it led, still has a process, though this host sent it SIGKILL. ');
      holdingTwig = false;
      expect((await launch(fleet, input('bud'))).success).toBe(true);
      expect(listed(childrenFile).find((c) => c.name === 'twig')?.pid).toBeNull();
    } finally {
      held.restore();
    }
  }, 30_000);

  test("a stop whose write of its group's end fails says so, and goes on", async () => {
    const childrenFile = childrenFilePath(parentDataDir());
    const { fleet, dir, input } = await startedFleet({ childrenFile, groupEndWaitMs: 60_000 });
    writeFileSync(input().recipe, JSON.stringify({ helperPid: join(dir, 'helper.pid') }));
    expect((await launch(fleet, input())).success).toBe(true);
    const leader = fleet.getChildren().get('leaf')!.pid!;
    let holding = true;
    const held = holdGroups(fleet, (pid) => pid === leader && holding);
    const logged: string[] = [];
    const log = spyOn(console, 'error').mockImplementation((line) => { logged.push(String(line)); });
    const record = fleet as unknown as { persistState: () => void };
    let refusing: ReturnType<typeof spyOn> | undefined;
    try {
      const stopping = fleet.handleToolCall({ id: 'kill', name: 'kill', input: { name: 'leaf' } });
      await waitFor(() => fleet.getChildren().get('leaf')?.groupSignal === 'sent', 'the signal to its group');
      // The next write, the retirement's, is refused.
      refusing = spyOn(record, 'persistState').mockImplementationOnce(() => { throw new Error('the store refused the write'); });
      holding = false;
      const stopped = await stopping;
      expect(stopped.success, JSON.stringify(stopped)).toBe(true);
      expect(logged).toContain(`[fleet] couldn't record that child "leaf"'s process group has ended: the store refused the write`);
    } finally {
      refusing?.mockRestore();
      held.restore();
      log.mockRestore();
    }
  }, 30_000);

  test("a failed launch whose child left a process in its group says so, and that the group was sent SIGKILL", async () => {
    const childrenFile = childrenFilePath(parentDataDir());
    const { fleet, dir, input } = await startedFleet({ childrenFile });
    writeFileSync(input().recipe, JSON.stringify({ helperPid: join(dir, 'helper.pid'), crashBeforeSocket: true }));
    const held = holdGroups(fleet, (pid) => pid !== null && pid === fleet.getChildren().get('leaf')?.pid);
    const log = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await launch(fleet, input());
      const leader = fleet.getChildren().get('leaf')!.pid!;
      expect(result.success).toBe(false);
      expect(result.error).toContain(`and has exited. Its process has ended, but process group ${leader}, which it led, ` +
        'still has a process, though this host sent it SIGKILL. The children file lists the child while that group has ' +
        'a process, so no update goes ahead while it does. ');
      expect(result.error).toContain('Otherwise nothing of it is running, so call fleet--launch again once the cause is fixed.');
    } finally {
      held.restore();
      log.mockRestore();
    }
  });

  test("endGroupOf signals a group once for each generation, and not at all once a signal has found it empty", () => {
    const fleet = new FleetModule({ childIndexPath: join(import.meta.dir, 'mock-fleet-lifecycle-child.ts') });
    const live = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    const signals: number[] = [];
    const counting = spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      if (pid < 0) signals.push(pid);
      return true;
    }) as typeof process.kill);
    try {
      const child = { name: 'leaf', pid: live.pid } as Record<string, unknown>;
      const end = (fleet as unknown as { endGroupOf: (c: unknown, pid: number) => void }).endGroupOf.bind(fleet);
      end(child, live.pid!);
      end(child, live.pid!);
      expect(signals).toEqual([-live.pid!]);
      expect(child.groupSignal).toBe('sent');
      // One whose signal found its group empty is retired, and gets no other.
      const gone = { name: 'twig', pid: live.pid } as Record<string, unknown>;
      counting.mockImplementation(((pid: number) => {
        if (pid < 0) signals.push(pid);
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      }) as typeof process.kill);
      end(gone, live.pid!);
      end(gone, live.pid!);
      expect(signals).toEqual([-live.pid!, -live.pid!]);
      expect(gone.groupEnded).toBe(true);
    } finally {
      counting.mockRestore();
      live.kill('SIGKILL');
    }
  });

  test("at the write that follows a child's exit, what it left in its group has been signalled already", async () => {
    const childrenFile = childrenFilePath(parentDataDir());
    const { fleet, dir, input } = await startedFleet({ childrenFile });
    const helperPid = join(dir, 'helper.pid');
    writeFileSync(input().recipe, JSON.stringify({ helperPid }));
    expect((await launch(fleet, input())).success).toBe(true);
    const leader = fleet.getChildren().get('leaf')!.pid!;
    const helper = Number(readFileSync(helperPid, 'utf8'));
    // The signal itself is what's checked, at the write: the helper's end
    // after it takes as long as the machine takes.
    const kill = process.kill.bind(process);
    const signals: Array<[number, unknown]> = [];
    const recording = spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      signals.push([pid, signal]);
      return kill(pid, signal);
    }) as typeof process.kill);
    let signalledFirst: boolean | undefined;
    const write = contract.writeJsonAtomic;
    const writing = spyOn(contract, 'writeJsonAtomic').mockImplementation((path: string, value: unknown) => {
      if (path === childrenFile && signalledFirst === undefined && fleet.getChildren().get('leaf')?.status === 'crashed') {
        signalledFirst = signals.some(([pid, signal]) => pid === -leader && signal === 'SIGKILL');
      }
      write(path, value);
    });
    try {
      kill(leader, 'SIGKILL');
      await waitFor(() => signalledFirst !== undefined, "the exit's write");
      expect(signalledFirst).toBe(true);
    } finally {
      writing.mockRestore();
      recording.mockRestore();
      try { process.kill(helper, 'SIGKILL'); } catch { /* gone */ }
    }
  });

  test("a host's exit ends each running child's process group, not only the child", async () => {
    const childrenFile = childrenFilePath(parentDataDir());
    const { fleet, dir, input } = await startedFleet({ childrenFile });
    const helperPid = join(dir, 'helper.pid');
    writeFileSync(input().recipe, JSON.stringify({ helperPid }));
    expect((await launch(fleet, input())).success).toBe(true);
    const helper = Number(readFileSync(helperPid, 'utf8'));
    try {
      // As the host exits, the child's exit handler can't run.
      fleet.getChildren().get('leaf')!.process!.removeAllListeners('exit');
      (fleet as unknown as { killAllOnExitSync: () => void }).killAllOnExitSync();
      await waitFor(() => processEnded(helper), 'the helper ended with its child');
    } finally {
      try { process.kill(helper, 'SIGKILL'); } catch { /* gone */ }
    }
  });

  test("another writer's entry whose process has ended stays listed while the group it led has a member", async () => {
    const parentData = parentDataDir();
    const childrenFile = childrenFilePath(parentData);
    const { fleet, input } = await startedFleet({ childrenFile });
    // A leader that leaves a member in its group and ends, as a store audit
    // whose helper outlives it.
    const leader = spawn('sh', ['-c', 'sleep 60 & echo $!'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const member = await new Promise<number>((read, failed) => {
      let out = '';
      leader.stdout!.on('data', (chunk: Buffer) => {
        out += chunk;
        if (out.includes('\n')) read(Number(out.slice(0, out.indexOf('\n'))));
      });
      leader.once('close', () => failed(new Error(`the leader wrote no line with its member's pid: ${JSON.stringify(out)}`)));
    });
    // A pid of 0 or less would signal this runner's own group, or every process.
    expect(Number.isSafeInteger(member) && member > 0, String(member)).toBe(true);
    await waitFor(() => !isAlive(leader.pid!), 'the leader ended');
    try {
      expect(isAlive(leader.pid!)).toBe(false);
      expect(isAlive(member)).toBe(true);
      const entry = { name: "leaf's store audit", pid: leader.pid!, bootId: machineBootId(), dataDir: join(parentData, 'elsewhere') };
      writeFileSync(childrenFile, JSON.stringify({ v: 1, children: [entry] }));
      expect((await launch(fleet, input('leaf'))).success).toBe(true);
      expect(listed(childrenFile).filter((c) => c.name !== 'leaf')).toEqual([entry]);
      process.kill(member, 'SIGKILL');
      await until(() => !isAlive(member));
      expect((await launch(fleet, input('twig'))).success).toBe(true);
      expect(listed(childrenFile).filter((c) => c.name !== 'leaf' && c.name !== 'twig')).toEqual([{ ...entry, pid: null }]);
    } finally {
      try { process.kill(member, 'SIGKILL'); } catch { /* gone */ }
    }
  });

  test("a fleet that can't read its record keeps the file's children, rather than writing none", async () => {
    const parentData = parentDataDir();
    const childrenFile = childrenFilePath(parentData);
    const earlier = { name: 'earlier', pid: process.pid, bootId: machineBootId(), dataDir: join(parentData, 'earlier') };
    writeFileSync(childrenFile, JSON.stringify({ v: 1, children: [earlier] }));
    const { fleet, input } = await startedFleet({ childrenFile }, { unreadable: true });
    expect((await launch(fleet, input())).success).toBe(true);
    expect(listed(childrenFile).map((c) => c.name)).toEqual(['leaf', 'earlier']);
    expect(listed(childrenFile)[1]).toEqual(earlier);
  });

  test("a children file this release can't read is left as it is, and a launch whose child it can't list fails, saying why", async () => {
    for (const [kind, text] of [['not JSON', 'not json'], ['no list of children', JSON.stringify({ v: 1 })]] as const) {
      const childrenFile = childrenFilePath(parentDataDir());
      writeFileSync(childrenFile, text);
      const { fleet, input } = await startedFleet({ childrenFile });
      const logged = spyOn(console, 'error').mockImplementation(() => {});
      let result: Result;
      try {
        result = await launch(fleet, input());
      } finally {
        logged.mockRestore();
      }
      expect(result.success, kind).toBe(false);
      expect(result.error, kind).toStartWith(`Child 'leaf' didn't start (it couldn't be listed in ${childrenFile}, which an ` +
        'update reads to see which children are running: ');
      expect(result.error, kind).toContain('Replacing it would drop the children it lists, which an update reads to see ' +
        'which may still be running, so every launch that spawns a child fails this way until whoever runs this host fixes it, or removes it ' +
        'once no child it lists is running)');
      expect(readFileSync(childrenFile, 'utf8'), kind).toBe(text);
      expect(fleet.getChildren().get('leaf')?.status, kind).toBe('crashed');
    }
  });

  test("a launch whose child the children file can't list stops the child and fails, saying why", async () => {
    const childrenFile = childrenFilePath(parentDataDir());
    const { fleet, input } = await startedFleet({ childrenFile });
    // Where the write's temporary file goes, a directory: the write fails,
    // for root as for anyone.
    mkdirSync(`${childrenFile}.tmp`);
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    let result: Result;
    try {
      result = await launch(fleet, input());
    } finally {
      logged.mockRestore();
    }
    expect(result.success).toBe(false);
    expect(result.error).toStartWith(`Child 'leaf' didn't start (it couldn't be listed in ${childrenFile}, which an update ` +
      'reads to see which children are running: EISDIR');
    const child = fleet.getChildren().get('leaf')!;
    expect(child.pid).toBeNumber();
    expect(child.status).toBe('crashed');
    expect(() => process.kill(child.pid!, 0)).toThrow();
    // Never told to begin, it wrote nothing in its directory.
    expect(existsSync(join(input().dataDir, 'launches.jsonl'))).toBe(false);
  });

  test("a fleet that keeps the file tells its child to begin only once the file lists it", async () => {
    const hold = await holdForBegin();
    const childrenFile = childrenFilePath(parentDataDir());
    const { fleet, dir, input } = await startedFleet({ childrenFile });
    const atGate = join(dir, 'at-gate');
    const begun = join(dir, 'begun');
    writeFileSync(input().recipe, JSON.stringify({ atGate, begun }));
    // The listing's write waits until the child has come to its wait, and
    // then holds, as a slow disk can: a child told before the write lands
    // would begin meanwhile.
    const seen: Array<{ atGate: boolean; begun: boolean }> = [];
    const write = contract.writeJsonAtomic;
    const writing = spyOn(contract, 'writeJsonAtomic').mockImplementation((path: string, value: unknown) => {
      if (path === childrenFile && seen.length === 0) {
        const there = holdUntil(() => existsSync(atGate), 30_000);
        holdUntil(() => false, hold);
        seen.push({ atGate: there, begun: existsSync(begun) });
      }
      write(path, value);
    });
    let result: Result;
    try {
      result = await launch(fleet, input());
    } finally {
      writing.mockRestore();
    }
    expect(result.success, result.error).toBe(true);
    expect(seen).toEqual([{ atGate: true, begun: false }]);
    expect(existsSync(begun)).toBe(true);
  });

  test("a child that's never told waits, doing nothing in its data directory, and ends when its stdin does, a line without its end included", async () => {
    const hold = await holdForBegin();
    for (const sent of ['', 'no newline']) {
      const dir = mkdtempSync(join(parentDataDir(), 'untold-'));
      const atGate = join(dir, 'at-gate');
      const begun = join(dir, 'begun');
      const child = standIn(dir, { atGate, begun });
      const exit = new Promise<number | null>((done) => child.on('exit', (code) => done(code)));
      await waitFor(() => existsSync(atGate), 'the child came to its wait');
      if (sent !== '') child.stdin!.write(sent);
      await Bun.sleep(hold);
      expect(child.exitCode, sent).toBeNull();
      expect(existsSync(begun), sent).toBe(false);
      expect(readdirSync(join(dir, 'data')), sent).toEqual([]);
      child.stdin!.end();
      expect(await exit, sent).toBe(1);
      expect(existsSync(begun), sent).toBe(false);
      expect(readdirSync(join(dir, 'data')), sent).toEqual([]);
    }
  });

  test("a child whose line comes in pieces begins at its newline, with the begin variable gone from its env", async () => {
    const hold = await holdForBegin();
    const dir = mkdtempSync(join(parentDataDir(), 'pieces-'));
    const atGate = join(dir, 'at-gate');
    const begun = join(dir, 'begun');
    const child = standIn(dir, { atGate, begun });
    await waitFor(() => existsSync(atGate), 'the child came to its wait');
    child.stdin!.write('a');
    await Bun.sleep(hold);
    expect(existsSync(begun)).toBe(false);
    child.stdin!.write('\n');
    await waitFor(() => existsSync(join(dir, 'data', 'launches.jsonl')), 'the child began');
    expect(existsSync(begun)).toBe(true);
    const [row] = readFileSync(join(dir, 'data', 'launches.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(row.begin).toBeNull();
  });

  test("a child whose stdin fails as it waits ends, having done nothing in its data directory", async () => {
    const dir = mkdtempSync(join(parentDataDir(), 'failing-'));
    const begun = join(dir, 'begun');
    const child = standIn(dir, { begun, stdinErrorAtGate: true });
    const code = await new Promise<number | null>((done) => child.on('close', (exited) => done(exited)));
    expect(code).toBe(1);
    // Its own exit, not an unhandled error's.
    expect(stderrOf.get(child)!.join('')).toBe('');
    expect(existsSync(begun)).toBe(false);
    expect(readdirSync(join(dir, 'data'))).toEqual([]);
  });

  test("a told child goes on once its stdin has ended", async () => {
    const hold = await holdForBegin();
    const dir = mkdtempSync(join(parentDataDir(), 'told-'));
    const atGate = join(dir, 'at-gate');
    const child = standIn(dir, { atGate });
    await waitFor(() => existsSync(atGate), 'the child came to its wait');
    child.stdin!.write('\n');
    await waitFor(() => existsSync(join(dir, 'data', 'headless.pid')), 'the told child began');
    child.stdin!.end();
    await Bun.sleep(hold);
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
  });

  test("a fleet whose child's end of the pipe is gone before its line fails that launch, and goes on", async () => {
    const childrenFile = childrenFilePath(parentDataDir());
    const { fleet, dir, input } = await startedFleet({ childrenFile, socketWaitTimeoutMs: 500 });
    const atGate = join(dir, 'at-gate');
    writeFileSync(input().recipe, JSON.stringify({ atGate, closeStdinAtGate: true }));
    // The listing's write waits until the child has closed its stdin, so the
    // line goes to a pipe nobody reads.
    const write = contract.writeJsonAtomic;
    let there: boolean | undefined;
    const writing = spyOn(contract, 'writeJsonAtomic').mockImplementation((path: string, value: unknown) => {
      if (path === childrenFile && there === undefined) there = holdUntil(() => existsSync(atGate), 30_000);
      write(path, value);
    });
    let result: Result;
    try {
      result = await launch(fleet, input());
    } finally {
      writing.mockRestore();
    }
    expect(there).toBe(true);
    expect(result.success).toBe(false);
    expect(result.error).toStartWith("Child 'leaf' didn't start (launch failed");
    // The host goes on: another launch succeeds.
    writeFileSync(join(dir, 'other.json'), JSON.stringify({}));
    expect((await launch(fleet, { name: 'twig', recipe: join(dir, 'other.json'), dataDir: join(dir, 'twig') })).success).toBe(true);
  });

  test("a launch while the fleet's record isn't written, as while it adopts, still lists its child before telling it to begin", async () => {
    const childrenFile = childrenFilePath(parentDataDir());
    const { fleet, input } = await startedFleet({ childrenFile });
    const internal = fleet as unknown as { adopting: boolean };
    internal.adopting = true;
    let result: Result;
    try {
      result = await launch(fleet, input());
    } finally {
      internal.adopting = false;
    }
    expect(result.success, result.error).toBe(true);
    expect(listed(childrenFile)).toEqual([
      { name: 'leaf', pid: fleet.getChildren().get('leaf')!.pid, bootId: machineBootId(), dataDir: input().dataDir },
    ]);
    // And a fleet with no store at all.
    const bareFile = childrenFilePath(parentDataDir());
    const dir = mkdtempSync(join(tmpdir(), 'fleet-children-file-'));
    const recipe = join(dir, 'recipe.json');
    writeFileSync(recipe, JSON.stringify({}));
    const bare = new FleetModule({
      childIndexPath: join(import.meta.dir, 'mock-fleet-lifecycle-child.ts'), childrenFile: bareFile,
      socketWaitTimeoutMs: 10_000, readyTimeoutMs: 10_000, gracefulShutdownMs: 100, sigtermEscalationMs: 100,
    });
    fixtures.push({ fleet: bare, dir });
    const bareResult = await launch(bare, { name: 'leaf', recipe, dataDir: join(dir, 'leaf') });
    expect(bareResult.success, bareResult.error).toBe(true);
    expect(listed(bareFile)).toEqual([
      { name: 'leaf', pid: bare.getChildren().get('leaf')!.pid, bootId: machineBootId(), dataDir: join(dir, 'leaf') },
    ]);
  });

  test("the note of a group left running says whether this host signalled it, and names the children file only where there is one", async () => {
    const live = await leaderlessGroup();
    try {
      const withFile = (await startedFleet({ childrenFile: childrenFilePath(parentDataDir()) })).fleet;
      const withNone = (await startedFleet()).fleet;
      const note = (fleet: FleetModule, fields: Record<string, unknown> = {}): string | undefined =>
        (fleet as unknown as { groupLeftNote: (c: unknown) => string | undefined }).groupLeftNote({
          name: 'leaf', pid: live.pid, bootId: machineBootId() ?? undefined, startedAt: Date.now(), ...fields,
        });
      const end = `Once sure that group is still the child's, whoever runs this host can end it, as a user allowed to signal it, with \`kill -KILL -- -${live.pid}\`; a process held in the kernel ends only once the kernel lets it go.`;
      expect(note(withFile)).toBe(`Its process has ended, but process group ${live.pid}, which it led, still has a process, ` +
        "which this host didn't signal, since nothing showed that group was still the child's when its process ended, " +
        'and its id may since have been taken by another. The children file lists the child while that group has a ' +
        `process, so no update goes ahead while it does. ${end}`);
      expect(note(withNone, { groupSignal: 'sent' })).toBe(`Its process has ended, but process group ${live.pid}, which ` +
        `it led, still has a process, though this host sent it SIGKILL. ${end}`);
      expect(note(withNone, { groupSignal: 'EPERM' })).toBe(`Its process has ended, but process group ${live.pid}, which ` +
        `it led, still has a process, which this host's SIGKILL couldn't reach (EPERM). ${end}`);
      expect(note(withFile, { groupEnded: true })).toBeUndefined();
      expect(note(withFile, { bootId: 'an-earlier-boot', startedAt: 1 })).toBeUndefined();
      expect(note(withFile, { pid: deadPid() })).toBeUndefined();
      // A live process at the pid is another's, the child's group having ended.
      const other = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
      try {
        expect(note(withFile, { pid: other.pid })).toBeUndefined();
      } finally {
        other.kill('SIGKILL');
      }
    } finally {
      live.end();
    }
  });

  test("a launch whose child can't be listed as its host detaches says the child, never told, ends with the host", async () => {
    const childrenFile = childrenFilePath(parentDataDir());
    const { fleet, input } = await startedFleet({ childrenFile });
    mkdirSync(`${childrenFile}.tmp`);
    const internal = fleet as unknown as { stopping: boolean };
    // The host begins to detach as the launch's record is synced.
    fleet.setStoreSync(() => {
      internal.stopping = true;
      fleet.setDetachMode(true);
    });
    const log = spyOn(console, 'error').mockImplementation(() => {});
    let result: Result;
    try {
      result = await launch(fleet, input());
    } finally {
      log.mockRestore();
      internal.stopping = false;
      fleet.setDetachMode(false);
    }
    expect(result.success).toBe(false);
    expect(result.error).toStartWith(`Child 'leaf' didn't start (it couldn't be listed in ${childrenFile}`);
    expect(result.error).toEndWith(': this host is shutting down before it told the child to begin, so the child ends ' +
      'with this host, having done nothing, and there is nothing to retry here.');
    // As the host's end closes its pipe.
    const proc = fleet.getChildren().get('leaf')!.process!;
    expect(proc.exitCode).toBeNull();
    const exit = new Promise<number | null>((done) => proc.once('exit', (exited) => done(exited)));
    proc.stdin!.end();
    expect(await exit).toBe(1);
    expect(existsSync(join(input().dataDir, 'launches.jsonl'))).toBe(false);
  });

  test("a child's environment takes no begin variable from its host's or its entry's", () => {
    const env = fleetChildEnv({ PATH: '/bin', [FLEET_BEGIN_ENV]: 'line' }, { [FLEET_BEGIN_ENV]: 'line' }, 'UTC', '/data');
    expect(env[FLEET_BEGIN_ENV]).toBeUndefined();
  });

  test("a child doesn't read the registry for an update notice, whatever its host's or its entry's environment says", () => {
    const env = fleetChildEnv({ CONNECTOME_UPDATE_CHECK: '1' }, { CONNECTOME_UPDATE_CHECK: '1' }, 'UTC', '/data');
    expect(env.CONNECTOME_UPDATE_CHECK).toBe('0');
  });

  test("a launch whose record the store can't take stops the child and fails, rather than leaving it running unwatched", async () => {
    const { fleet, input } = await startedFleet();
    const state = (fleet as unknown as { ctx: { setState: (next: Record_) => void } }).ctx;
    const setState = state.setState;
    state.setState = (next) => {
      if (next.children.leaf?.status === 'starting') throw new Error('the store refused the write');
      setState(next);
    };
    const result = await launch(fleet, input());
    expect(result.success).toBe(false);
    expect(result.error).toStartWith("Child 'leaf' didn't start (its record couldn't be kept: the store refused the write)");
    const child = fleet.getChildren().get('leaf')!;
    expect(child.status).toBe('crashed');
    expect(() => process.kill(child.pid!, 0)).toThrow();
  });

  test("a store that refuses every write gets the launch's failure, and the child's exit is logged, not thrown", async () => {
    const { fleet, input } = await startedFleet();
    (fleet as unknown as { ctx: { setState: () => void } }).ctx.setState = () => { throw new Error('the store refused the write'); };
    const logged: string[] = [];
    const log = spyOn(console, 'error').mockImplementation((line) => { logged.push(String(line)); });
    let result: Result;
    try {
      result = await launch(fleet, input());
    } finally {
      log.mockRestore();
    }
    expect(result.success).toBe(false);
    expect(result.error).toStartWith("Child 'leaf' didn't start (its record couldn't be kept: the store refused the write)");
    expect(logged).toContain('[fleet] couldn\'t record that child "leaf" exited: the store refused the write');
  });

  test("a launch whose record can't be synced stops the child and fails", async () => {
    const { fleet, input } = await startedFleet({ childrenFile: childrenFilePath(parentDataDir()) });
    fleet.setStoreSync(() => { throw new Error('the store refused the sync'); });
    const result = await launch(fleet, input());
    expect(result.success).toBe(false);
    expect(result.error).toStartWith("Child 'leaf' didn't start (its record couldn't be kept: the store refused the sync)");
    const child = fleet.getChildren().get('leaf')!;
    expect(child.status).toBe('crashed');
    expect(() => process.kill(child.pid!, 0)).toThrow();
  });

  test("a later write that fails is logged, the lifecycle goes on, and the file keeps the child's pid", async () => {
    const childrenFile = childrenFilePath(parentDataDir());
    const { fleet, input } = await startedFleet({ childrenFile });
    expect((await launch(fleet, input())).success).toBe(true);
    const pid = fleet.getChildren().get('leaf')!.pid;
    mkdirSync(`${childrenFile}.tmp`);
    const logged: string[] = [];
    const log = spyOn(console, 'error').mockImplementation((line) => { logged.push(String(line)); });
    try {
      expect((await fleet.handleToolCall({ id: 'kill', name: 'kill', input: { name: 'leaf' } })).success).toBe(true);
    } finally {
      log.mockRestore();
    }
    expect(fleet.getChildren().get('leaf')?.status).not.toBe('ready');
    expect(listed(childrenFile).map((c) => c.pid)).toEqual([pid]);
    expect(logged.some((line) => line.startsWith(`[fleet] couldn't write ${childrenFile}, which an update reads`))).toBe(true);
  });

  test('a fleet the host gave no children file writes and reads none', async () => {
    const write = spyOn(contract, 'writeJsonAtomic');
    const read = spyOn(contract, 'readRecord');
    try {
      const { fleet, dir, input } = await startedFleet();
      expect((await launch(fleet, input())).success).toBe(true);
      expect(write).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(readdirSync(dir).filter((name) => name.includes('children'))).toEqual([]);
      expect(existsSync(childrenFilePath(input().dataDir))).toBe(false);
    } finally {
      write.mockRestore();
      read.mockRestore();
    }
  });
});

describe("a fleet child and the install's root", () => {
  test('a child never gets CONNECTOME_INSTALL_ROOT, from the parent or from its own env', async () => {
    process.env.CONNECTOME_INSTALL_ROOT = '/srv/connectome';
    const { fleet, input } = await startedFleet();
    expect((await launch(fleet, {
      ...input(), env: { CONNECTOME_INSTALL_ROOT: '/srv/other', FLEET_TEST_SENTINEL: 'env reached the child' },
    })).success).toBe(true);
    const [row] = readFileSync(join(input().dataDir, 'launches.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(row).toMatchObject({ sentinel: 'env reached the child', installRoot: null });
  });
});
