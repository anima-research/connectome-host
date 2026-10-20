/**
 * autoStart children launch once the parent's framework has started, not
 * while it is being built. The framework awaits every module's start() inside
 * AgentFramework.create(), before its own start() runs its agents, so a child
 * launched from the fleet's start() could have residents acting before the
 * parent's agents run. start() now only adopts living children, and the host
 * calls launchAutoStart() after framework.start() (src/start-framework.ts).
 */
import { describe, test, expect, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FleetModule } from '../src/modules/fleet-module.js';

type Ctx = Parameters<FleetModule['start']>[0];
const ctx = { getState: () => null, setState: () => {} } as unknown as Ctx;

/** A fleet whose launches are recorded rather than run. */
function fleetWith(names: Array<{ name: string; autoStart?: boolean }>) {
  const fleet = new FleetModule({
    autoStart: names.map(({ name, autoStart }) => ({ name, recipe: `${name}.json`, ...(autoStart !== undefined ? { autoStart } : {}) })),
  });
  const launches = spyOn(fleet as any, 'handleLaunch').mockResolvedValue({ success: true });
  const launched = () => launches.mock.calls.map(([input, opts]) => ({ name: (input as { name: string }).name, opts }));
  return { fleet, launches, launched };
}

/** Make start()'s adoption take back `name`, as reattaching to a living child does. */
function adopting(fleet: FleetModule, name: string) {
  spyOn(fleet as any, 'adoptPersistedChildren').mockImplementation(async () => {
    (fleet as unknown as { children: Map<string, unknown> }).children.set(name, { name, adopted: true, status: 'ready' });
  });
}

describe('FleetModule autoStart, after the framework has started', () => {
  test('start() launches no autoStart child, and launchAutoStart() launches each one once', async () => {
    // The host gives an enabled child autoStart: true (src/index.ts), and a recipe can leave it out.
    const { fleet, launched } = fleetWith([{ name: 'a', autoStart: true }, { name: 'off', autoStart: false }, { name: 'b' }]);
    await fleet.start(ctx);
    expect(launched()).toEqual([]);
    fleet.launchAutoStart();
    expect(launched()).toEqual([
      { name: 'a', opts: { viaAutoStart: true } },
      { name: 'b', opts: { viaAutoStart: true } },
    ]);
    fleet.launchAutoStart();
    expect(launched()).toHaveLength(2);
    await fleet.stop();
  });

  test('a launch under way is listed until it settles, each on its own, and a refused one is logged', async () => {
    const { fleet, launches } = fleetWith([{ name: 'a', autoStart: true }, { name: 'off', autoStart: false }, { name: 'b' }]);
    const settle = new Map<string, (result: { success: boolean; error?: string }) => void>();
    launches.mockImplementation((input: { name: string }) =>
      new Promise((done) => { settle.set(input.name, done); }));
    const logged: string[] = [];
    const log = spyOn(console, 'error').mockImplementation((line) => { logged.push(String(line)); });
    try {
      await fleet.start(ctx);
      expect([...fleet.autoStartLaunching()]).toEqual([]);
      fleet.launchAutoStart();
      expect([...fleet.autoStartLaunching()]).toEqual(['a', 'b']);
      // The wait for them ends once every one has ended, whether it was refused or not.
      let waited = false;
      void fleet.autoStartRecorded().then(() => { waited = true; });
      // A refused launch ends with no record, and leaves the other still under way.
      settle.get('a')!({ success: false, error: 'refused' });
      await Bun.sleep(0);
      expect([...fleet.autoStartLaunching()]).toEqual(['b']);
      expect(logged).toEqual(['[fleet] autoStart "a" failed: refused']);
      expect(waited).toBe(false);
      settle.get('b')!({ success: true });
      await Bun.sleep(0);
      expect([...fleet.autoStartLaunching()]).toEqual([]);
      expect(waited).toBe(true);
    } finally {
      log.mockRestore();
      await fleet.stop();
    }
  });

  test('autoStartRecorded() resolves once each launch has recorded its child, before the child is ready', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-autostart-recorded-'));
    // The mock child never opens its socket, so its launch is still waiting
    // for it long after the launch has recorded the child, until the stop
    // below ends the child.
    const recipe = join(dir, 'leaf.json');
    writeFileSync(recipe, JSON.stringify({ noSocket: true }));
    const fleet = new FleetModule({
      childIndexPath: join(import.meta.dir, 'mock-fleet-lifecycle-child.ts'),
      socketWaitTimeoutMs: 10_000,
      gracefulShutdownMs: 100,
      sigtermEscalationMs: 100,
      autoStart: [{ name: 'leaf', recipe, dataDir: join(dir, 'leaf') }],
    });
    // The spy lets each launch run, and keeps what it returns.
    const launches = spyOn(fleet as any, 'handleLaunch');
    const logged: string[] = [];
    try {
      await fleet.start(ctx);
      // Nothing is under way yet, so there's nothing to wait for.
      await fleet.autoStartRecorded();
      fleet.launchAutoStart();
      expect([...fleet.autoStartLaunching()]).toEqual(['leaf']);
      await fleet.autoStartRecorded();
      expect(fleet.getChildren().get('leaf')?.status).toBe('starting');
      expect([...fleet.autoStartLaunching()]).toEqual([]);
    } finally {
      // The stop ends the child while its launch still waits for the socket,
      // so the launch fails, and logs that as it ends, which can be after the
      // stop has returned. The test waits for that end, so no line of its
      // launch lands in a later test's spy.
      const log = spyOn(console, 'error').mockImplementation((line) => { logged.push(String(line)); });
      try {
        await fleet.stop();
        await Promise.allSettled(launches.mock.results.map(({ value }) => value));
      } finally {
        log.mockRestore();
        rmSync(dir, { recursive: true, force: true });
      }
    }
    expect(logged).toEqual([expect.stringMatching(/^\[fleet\] autoStart "leaf" failed: /)]);
  });

  test('launchAutoStart() leaves a child that start() adopted alone', async () => {
    const { fleet, launched } = fleetWith([{ name: 'kept' }, { name: 'fresh' }]);
    adopting(fleet, 'kept');
    await fleet.start(ctx);
    fleet.launchAutoStart();
    expect(launched().map(({ name }) => name)).toEqual(['fresh']);
    expect([...fleet.autoStartLaunching()]).toEqual(['fresh']);
    // The adopted record is a stand-in with no process to stop.
    fleet.setDetachMode(true);
    await fleet.stop();
  });

  test('a call before start() has finished adopting launches nothing, and leaves the launch for later', async () => {
    const early = fleetWith([{ name: 'a' }]);
    early.fleet.launchAutoStart();
    expect(early.launched()).toEqual([]);
    await early.fleet.start(ctx);
    early.fleet.launchAutoStart();
    expect(early.launched().map(({ name }) => name)).toEqual(['a']);
    await early.fleet.stop();

    // While start() awaits its adoption, which takes back 'kept', nothing launches.
    const during = fleetWith([{ name: 'kept' }, { name: 'fresh' }]);
    let adopt!: () => void;
    spyOn(during.fleet as any, 'adoptPersistedChildren').mockImplementation(() => new Promise<void>((done) => {
      adopt = () => {
        (during.fleet as unknown as { children: Map<string, unknown> }).children.set('kept', { name: 'kept', adopted: true, status: 'ready' });
        done();
      };
    }));
    const starting = during.fleet.start(ctx);
    during.fleet.launchAutoStart();
    expect(during.launched()).toEqual([]);
    adopt();
    await starting;
    during.fleet.launchAutoStart();
    expect(during.launched().map(({ name }) => name)).toEqual(['fresh']);
    during.fleet.setDetachMode(true);
    await during.fleet.stop();
  });

  test('launchAutoStart() launches nothing once stop() has begun', async () => {
    const late = fleetWith([{ name: 'a' }]);
    await late.fleet.start(ctx);
    const stopped = late.fleet.stop();
    // stop() has begun and not finished: the fleet still holds its context.
    late.fleet.launchAutoStart();
    await stopped;
    late.fleet.launchAutoStart();
    expect(late.launched()).toEqual([]);
  });

  test('a launch that throws is logged, and the other children still launch', async () => {
    const { fleet, launches, launched } = fleetWith([{ name: 'a' }, { name: 'b' }]);
    launches.mockImplementation(async (input: { name: string }) => {
      if (input.name === 'a') throw new Error('loading the recipe failed');
      return { success: true };
    });
    const logged: string[] = [];
    const log = spyOn(console, 'error').mockImplementation((line) => { logged.push(String(line)); });
    try {
      await fleet.start(ctx);
      fleet.launchAutoStart();
      await Bun.sleep(0);
      expect(launched().map(({ name }) => name)).toEqual(['a', 'b']);
      expect(logged).toEqual(['[fleet] autoStart "a" threw: Error: loading the recipe failed']);
      expect([...fleet.autoStartLaunching()]).toEqual([]);
    } finally {
      log.mockRestore();
      await fleet.stop();
    }
  });
});
