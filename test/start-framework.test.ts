import { describe, test, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FleetModule } from '../src/modules/fleet-module.js';
import { startFramework } from '../src/start-framework.js';
import { installPaths, moveCurrent, readCurrent, readJournal, switchQuiesceReason } from '../src/update/contract.js';

type Servers = Array<{ id: string; connected: boolean }>;

/** A framework as startFramework uses one: `order` records what it starts,
 *  when its stop or its resume, which each take a moment, has finished, how
 *  either fails, and what it tells the operator. */
function framework(order: string[], options: {
  fleet?: FleetModule; servers?: Servers; atStart?: () => void; stopFails?: true; quiesceReason?: string; resumeFails?: true;
} = {}) {
  let quiesced = options.quiesceReason !== undefined;
  return {
    getHostModeStatus: () => ({ quiesced, reason: options.quiesceReason }),
    resume: async () => {
      await Bun.sleep(20);
      if (options.resumeFails) throw new Error('resume refused: returning to service would OverBudget-wedge');
      quiesced = false;
      order.push('the quiesce ends');
      return {};
    },
    notifyOps: (kind: string, agent: string, message: string) => { order.push(`the operator is told (${kind}, of ${agent}): ${message}`); },
    start: () => { options.atStart?.(); order.push('framework starts its agents'); },
    stop: async () => {
      await Bun.sleep(20);
      if (options.stopFails) throw new Error('the stop failed');
      order.push('framework stopped');
    },
    // The framework finds a module by its own name, so the fake answers to the fleet's.
    getModule: (name: string) => (options.fleet && name === options.fleet.name ? options.fleet : null),
    listMcplServers: () => options.servers ?? [],
  } as unknown as Parameters<typeof startFramework>[0];
}

function watchedFleet(order: string[]): FleetModule {
  const fleet = new FleetModule({});
  spyOn(fleet, 'launchAutoStart').mockImplementation(() => { order.push('fleet launches its autoStart children'); });
  return fleet;
}

describe('startFramework', () => {
  test("starts the framework's agents before its fleet launches any autoStart child", async () => {
    const order: string[] = [];
    await startFramework(framework(order, { fleet: watchedFleet(order) }), null);
    expect(order).toEqual(['framework starts its agents', 'fleet launches its autoStart children']);
  });

  test("ends the switch's quiesce once framework.start() has run, before any child launches", async () => {
    const order: string[] = [];
    await startFramework(framework(order, { fleet: watchedFleet(order), quiesceReason: switchQuiesceReason('0.11.0') }), null);
    expect(order).toEqual(['framework starts its agents', 'the quiesce ends', 'fleet launches its autoStart children']);
  });

  test("a resume agent-framework refuses leaves the host quiesced, tells the operator, and the children launch all the same", async () => {
    const order: string[] = [];
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await startFramework(framework(order, {
        fleet: watchedFleet(order), quiesceReason: switchQuiesceReason('0.11.0'), resumeFails: true,
      }), null);
    } finally {
      errors.mockRestore();
    }
    expect(order).toEqual([
      'framework starts its agents',
      "the operator is told (update-quiesce-stays, of host): This host's switch quiesce didn't end: it stays quiesced, since " +
        'agent-framework refused its resume (resume refused: returning to service would OverBudget-wedge); a later resume, ' +
        'such as try later or the next start, can succeed once that is resolved',
      'fleet launches its autoStart children',
    ]);
  });

  test("leaves a quiesce that isn't the switch's, such as an operator's", async () => {
    const order: string[] = [];
    await startFramework(framework(order, { fleet: watchedFleet(order), quiesceReason: 'operator: maintenance' }), null);
    expect(order).toEqual(['framework starts its agents', 'fleet launches its autoStart children']);
  });

  test('starts a framework that has no fleet', async () => {
    const order: string[] = [];
    await startFramework(framework(order), null);
    expect(order).toEqual(['framework starts its agents']);
  });
});

describe('startFramework, for a host an install started', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'start-framework-install-'));
    mkdirSync(join(root, 'releases', '0.10.2'), { recursive: true });
    mkdirSync(join(root, 'releases', '0.11.0'), { recursive: true });
    moveCurrent(root, '0.10.2');
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  test('records its release as the one the install runs on before the framework starts its agents', async () => {
    let currentAtStart: string | null = null;
    const order: string[] = [];
    await startFramework(framework(order, { atStart: () => { currentAtStart = readCurrent(root); } }), { root, release: '0.11.0' });
    expect(currentAtStart).toBe('0.11.0');
    expect(readJournal(root).map(({ step, from, to, outcome }) => ({ step, from, to, outcome })))
      .toEqual([{ step: 'commit', from: '0.10.2', to: '0.11.0', outcome: 'ok' }]);
  });

  test("a start on trial with a configured server the framework didn't connect stops it, starting nothing, and names the server", async () => {
    const order: string[] = [];
    const servers = [{ id: 'discord', connected: false }, { id: 'heartbeat', connected: true }];
    await expect(startFramework(framework(order, { fleet: watchedFleet(order), servers }), { root, release: '0.11.0' }))
      .rejects.toThrow("This release couldn't connect the MCPL server discord, so it starts none of its agents, and the next start goes back to 0.10.2: ");
    expect(order).toEqual(['framework stopped']);
    expect(readCurrent(root)).toBe('0.10.2');
  });

  test('a start on the release already current writes nothing, whatever its servers did', async () => {
    const order: string[] = [];
    await startFramework(framework(order, { servers: [{ id: 'discord', connected: false }] }), { root, release: '0.10.2' });
    expect(order).toEqual(['framework starts its agents']);
    expect(readCurrent(root)).toBe('0.10.2');
    expect(existsSync(installPaths(root).journal)).toBe(false);
  });

  test("a commit that can't be recorded stops the framework, starts nothing and says why", async () => {
    const order: string[] = [];
    // Where the move's temporary link goes, a directory with something in it,
    // which stops the move for root as for anyone.
    mkdirSync(join(`${installPaths(root).current}.tmp`, 'in-the-way'), { recursive: true });
    await expect(startFramework(framework(order, { fleet: watchedFleet(order) }), { root, release: '0.11.0' })).rejects.toThrow(
      `This host couldn't record 0.11.0 as the release the install at ${root} runs on, so none of its agents started, ` +
      'and the next start goes back to 0.10.2: ',
    );
    expect(order).toEqual(['framework stopped']);
    expect(readCurrent(root)).toBe('0.10.2');
  });

  test("a stop that fails after a refused commit is logged, and the commit's refusal is what's thrown", async () => {
    const order: string[] = [];
    const logged: string[] = [];
    const log = spyOn(console, 'error').mockImplementation((line) => { logged.push(String(line)); });
    try {
      await expect(startFramework(framework(order, { servers: [{ id: 'discord', connected: false }], stopFails: true }), { root, release: '0.11.0' }))
        .rejects.toThrow("This release couldn't connect the MCPL server discord");
    } finally {
      log.mockRestore();
    }
    expect(logged).toEqual(['[update] stopping the framework after its start ended failed too: the stop failed']);
    expect(order).toEqual([]);
  });
});
