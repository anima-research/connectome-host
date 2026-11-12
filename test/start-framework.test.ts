import { describe, test, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FleetModule } from '../src/modules/fleet-module.js';
import { startFramework } from '../src/start-framework.js';
import { installPaths, moveCurrent, readCurrent, readJournal, switchQuiesceReason, writeMark } from '../src/update/contract.js';

type Servers = Array<{ id: string; connected: boolean; closedTab?: boolean }>;

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

  test("asks each fleet child the start adopted to end a switch's quiesce the last stop may have left, and logs one it can't reach", async () => {
    const order: string[] = [];
    const fleet = watchedFleet(order);
    spyOn(fleet, 'runningChildren').mockReturnValue([{ name: 'kid' }, { name: 'gone' }]);
    spyOn(fleet, 'requestSwitch').mockImplementation(async (name, request) => {
      order.push(`${name} is asked: ${request.op}`);
      return name === 'kid' ? { ok: true, data: { resumed: true } } : { ok: false, error: 'the socket closed' };
    });
    let logged: (line: string) => void = () => {};
    const line = new Promise<string>((done) => { logged = done; });
    const errors = spyOn(console, 'error').mockImplementation((said: unknown) => {
      if (String(said).includes('"gone"')) logged(String(said));
    });
    try {
      await startFramework(framework(order, { fleet }), null);
      expect(await line).toBe('[update] Fleet child "gone" was asked at this start to end a switch\'s quiesce the last stop ' +
        'may have left, and it didn\'t answer (the socket closed), so it may still be holding its new turns until a resume ' +
        'reaches it, such as an operator\'s Resume, or until its own next start.');
    } finally {
      errors.mockRestore();
    }
    expect(order).toContain('kid is asked: resume');
    expect(order).toContain('gone is asked: resume');
    expect(order.filter((step) => step.endsWith('is asked: resume'))).toHaveLength(2);
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
      .rejects.toThrow("The MCPL server discord wasn't connected when this release went to commit, so it starts none of its agents, and the next start goes back to 0.10.2: ");
    expect(order).toEqual(['framework stopped']);
    expect(readCurrent(root)).toBe('0.10.2');
  });

  test('a start on trial whose only unconnected server is a closed tab commits', async () => {
    const order: string[] = [];
    const servers = [{ id: 'games', connected: false, closedTab: true }, { id: 'heartbeat', connected: true }];
    await startFramework(framework(order, { servers }), { root, release: '0.11.0' });
    expect(order).toEqual(['framework starts its agents']);
    expect(readCurrent(root)).toBe('0.11.0');
  });

  test('a start on trial with a closed tab and a server that failed to connect refuses, naming only the failed one', async () => {
    const order: string[] = [];
    const servers = [{ id: 'games', connected: false, closedTab: true }, { id: 'discord', connected: false, closedTab: false }];
    await expect(startFramework(framework(order, { servers }), { root, release: '0.11.0' }))
      .rejects.toThrow("The MCPL server discord wasn't connected when this release went to commit, so it starts none of its agents, and the next start goes back to 0.10.2: ");
    expect(readCurrent(root)).toBe('0.10.2');
  });

  test("a server the request recorded that the trial isn't configured with doesn't hold the commit", async () => {
    writeMark(root, { to: '0.11.0', why: 'go-back', connected: ['heartbeat', 'gone'] });
    const order: string[] = [];
    const servers = [{ id: 'heartbeat', connected: true }, { id: 'discord', connected: false }];
    const logged = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await startFramework(framework(order, { servers }), { root, release: '0.11.0' });
    } finally {
      logged.mockRestore();
    }
    expect(order).toEqual(['framework starts its agents']);
    expect(readCurrent(root)).toBe('0.11.0');
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
    // A directory with something in it where the move's temporary link goes
    // stops the move, for root as for anyone.
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
        .rejects.toThrow("The MCPL server discord wasn't connected when this release went to commit");
    } finally {
      log.mockRestore();
    }
    expect(logged).toEqual(['[update] stopping the framework after its start ended failed too: the stop failed']);
    expect(order).toEqual([]);
  });
});
