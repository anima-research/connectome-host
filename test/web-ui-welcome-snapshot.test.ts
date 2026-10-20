/**
 * The welcome reads its state after its awaits, and nothing yields from
 * that read to marking the client welcomed. A client skips live events until
 * then, so state copied before an await would miss whatever landed during it.
 * A fleet child's usage sample missed that way leaves the client's copy of the
 * stream one call behind, and its next sample would show two calls' prompts as
 * one context size.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModuleContext } from '@animalabs/agent-framework';
import {
  WebUiModule,
  __getSharedServerPortForTests,
  __resetSharedServerForTests,
} from '../src/modules/web-ui-module.js';
import type { FleetEventCallback } from '../src/modules/fleet-module.js';

let webUiModule: WebUiModule;

/** A fleet with one child, `c`, whose events the test emits by hand. */
function fakeFleet() {
  const listeners = new Map<string, FleetEventCallback[]>();
  return {
    name: 'fleet',
    getChildren: () => new Map([['c', { status: 'running', recipePath: '/nowhere/recipe.json' }]]),
    autoStartLaunching: () => new Set(),
    autoStartRecorded(): Promise<void> {
      throw new Error('no autoStart launch is under way, so nothing should wait for one');
    },
    onChildEvent(filter: string, callback: FleetEventCallback) {
      listeners.set(filter, [...(listeners.get(filter) ?? []), callback]);
      return () => {};
    },
    requestDescribe() {},
    emit(event: Record<string, unknown>) {
      for (const key of ['c', '*']) {
        for (const callback of listeners.get(key) ?? []) callback('c', event as never);
      }
    },
  };
}

beforeAll(async () => {
  webUiModule = new WebUiModule({ port: 0, host: '127.0.0.1' });
  await webUiModule.start({} as ModuleContext);
  if (!__getSharedServerPortForTests()) throw new Error('webui server not bound');
});

afterAll(async () => {
  await webUiModule.stop();
  await __resetSharedServerForTests();
});

describe('the welcome', () => {
  test("copies a fleet child's tree after its await, so a sample during it is in the welcome sent", async () => {
    const fleet = fakeFleet();
    webUiModule.setApp({
      framework: {
        getAllAgents: () => [],
        getAllModules: () => [fleet],
        onTrace: () => {},
      },
      sessionManager: { getActiveSession: () => ({ id: 's', name: 's', manuallyNamed: true }) },
      recipe: { name: 'recipe', agent: {} },
    } as never);
    const ts = Date.now();
    fleet.emit({
      type: 'snapshot',
      asOfTs: ts,
      ts,
      tree: { nodes: [], callIdIndex: {} },
    });
    fleet.emit({ type: 'inference:started', agentName: 'worker', ts: ts + 1, timestamp: ts + 1 });

    // The recipe load is the welcome's await: a call ends while it's out.
    (webUiModule as unknown as { loadChildRecipeInfo: () => Promise<undefined> }).loadChildRecipeInfo = async () => {
      fleet.emit({
        type: 'inference:usage',
        agentName: 'worker',
        tokenUsage: { input: 120, output: 30, cacheCreation: 4000 },
        ts: ts + 2,
        timestamp: ts + 2,
      });
      return undefined;
    };
    // A client as the server keeps one, read through what it was sent.
    const sent: Array<Record<string, unknown>> = [];
    const client = { id: 1, ws: { send: (raw: string) => { sent.push(JSON.parse(raw)); } }, welcomed: false, auth: 'full', scopes: null };
    await (webUiModule as unknown as { sendWelcome(client: unknown): Promise<void> }).sendWelcome(client);
    expect(client.welcomed).toBe(true);
    const welcome = sent.find((m) => m.type === 'welcome') as unknown as {
      childTrees: Array<{ name: string; nodes: Array<{ name: string; tokens: Record<string, number>; streamUsage?: Record<string, number> }> }>;
    };

    const worker = welcome.childTrees.find((t) => t.name === 'c')?.nodes.find((n) => n.name === 'worker');
    expect(worker?.tokens).toEqual({ input: 4120, output: 30, cacheRead: 0, cacheWrite: 4000 });
    expect(worker?.streamUsage).toEqual({ input: 120, output: 30, cacheRead: 0, cacheCreation: 4000 });
  });

  /** Bind the Web UI to a fleet with `records` and the autoStart `launching`, as setApp does at a start or a
   *  session switch. `recorded` stands for the fleet's wait for those launches to record their children, and
   *  the answer counts the binds that asked for it. */
  function bindFleet(
    records: Map<string, { status: string; recipePath: string }>, launching: Set<string>, recorded: () => Promise<void>,
  ): { asked: () => number } {
    let asked = 0;
    webUiModule.setApp({
      framework: {
        getAllAgents: () => [],
        getAllModules: () => [{
          name: 'fleet',
          getChildren: () => records,
          // A copy, as the fleet's own is, so nothing here reads a set it kept.
          autoStartLaunching: () => new Set(launching),
          autoStartRecorded: () => { asked++; return recorded(); },
          onChildEvent: () => () => {},
          requestDescribe: () => false,
        }],
        onTrace: () => {},
      },
      sessionManager: { getActiveSession: () => ({ id: 's', name: 's', manuallyNamed: true }) },
      recipe: { name: 'recipe', agent: {} },
    } as never);
    return { asked: () => asked };
  }

  /** The children a welcome sent now lists, each with the recipe it carries, if any. */
  async function welcomeNow(id: number): Promise<Array<{ name: string; recipe?: Record<string, string> }>> {
    const sent: Array<Record<string, unknown>> = [];
    const client = { id, ws: { send: (raw: string) => { sent.push(JSON.parse(raw)); } }, welcomed: false, auth: 'full', scopes: null };
    await (webUiModule as unknown as { sendWelcome(client: unknown): Promise<void> }).sendWelcome(client);
    return (sent.find((m) => m.type === 'welcome') as unknown as { childTrees: Array<{ name: string; recipe?: Record<string, string> }> }).childTrees;
  }

  test('waits for the autoStart launches under way to record their children, so it carries their recipes', async () => {
    // As at a session switch: the Web UI is bound just after the agents start,
    // while the fleet's autoStart launches are still loading their recipes.
    const dir = mkdtempSync(join(tmpdir(), 'welcome-autostart-'));
    try {
      const recipe = join(dir, 'kid.json');
      writeFileSync(recipe, JSON.stringify({
        name: 'Kid', description: 'Watches the parent', agent: { name: 'kid', systemPrompt: 'never asked', model: 'claude-kid-model' },
      }));
      const records = new Map<string, { status: string; recipePath: string }>();
      const launching = new Set(['kid']);
      let record!: () => void;
      const recorded = new Promise<void>((done) => {
        record = () => { records.set('kid', { status: 'starting', recipePath: recipe }); launching.delete('kid'); done(); };
      });
      bindFleet(records, launching, () => recorded);
      // The earlier test replaced the recipe loader; this one uses the real one,
      // which reads a recipe only through a record.
      delete (webUiModule as unknown as { loadChildRecipeInfo?: unknown }).loadChildRecipeInfo;
      setTimeout(record, 50);
      // The whole summary the recipe pane shows: name, description and model.
      expect(await welcomeNow(2)).toEqual([expect.objectContaining({
        name: 'kid', recipe: { name: 'Kid', description: 'Watches the parent', agentModel: 'claude-kid-model' },
      })]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('waits once per bind, a second at most: a launch not recorded by then is listed by name, and later welcomes do not wait', async () => {
    const launching = new Set(['kid']);
    delete (webUiModule as unknown as { loadChildRecipeInfo?: unknown }).loadChildRecipeInfo;
    // Taken before the bind, which starts the wait's timer, so the wait can't
    // look shorter than it was.
    const started = Date.now();
    // A launch whose recipe fetch stalls never records its child.
    const binding = bindFleet(new Map(), launching, () => new Promise<void>(() => {}));
    // Two clients welcomed at the bind wait on the one wait.
    const [first, second] = await Promise.all([welcomeNow(3), welcomeNow(4)]);
    // About the second, once: two waits one after the other would take two.
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(950);
    expect(waited).toBeLessThan(1_900);
    for (const listed of [first, second]) {
      expect(listed.map((t) => t.name)).toEqual(['kid']);
      expect(listed[0]?.recipe).toBeUndefined();
    }
    // A client that connects once the wait is over, with the launch still
    // stalled, doesn't wait again: a wait of its own would take a second, and
    // would ask the fleet again.
    const later = Date.now();
    const listed = await welcomeNow(5);
    expect(Date.now() - later).toBeLessThan(900);
    expect(listed.map((t) => t.name)).toEqual(['kid']);
    // A refused launch ends with no record, so the next welcome doesn't list it.
    launching.delete('kid');
    expect(await welcomeNow(6)).toEqual([]);
    expect(binding.asked()).toBe(1);
  });

  test('a welcome that a newer bind superseded while it waited sends nothing, since that bind welcomes the client again', async () => {
    bindFleet(new Map(), new Set(['kid']), () => new Promise<void>(() => {}));
    delete (webUiModule as unknown as { loadChildRecipeInfo?: unknown }).loadChildRecipeInfo;
    const sent: Array<Record<string, unknown>> = [];
    const client = { id: 7, ws: { send: (raw: string) => { sent.push(JSON.parse(raw)); } }, welcomed: false, auth: 'full', scopes: null };
    const waiting = (webUiModule as unknown as { sendWelcome(client: unknown): Promise<void> }).sendWelcome(client);
    // A session switch while that welcome waits on the stalled launch.
    bindFleet(new Map(), new Set(), () => { throw new Error('nothing is launching, so nothing should wait'); });
    await waiting;
    expect(sent.filter((m) => m.type === 'welcome')).toEqual([]);
    expect(client.welcomed).toBe(false);
  });

  test('a welcome that a newer bind superseded while it loaded recipes sends nothing', async () => {
    // Nothing is launching, so the welcome's first await is its recipe load.
    bindFleet(new Map([['c', { status: 'ready', recipePath: '/unused/c.json' }]]), new Set(), () => {
      throw new Error('nothing is launching, so nothing should wait');
    });
    let loaded!: () => void;
    const loading = new Promise<undefined>((done) => { loaded = () => done(undefined); });
    (webUiModule as unknown as { loadChildRecipeInfo: () => Promise<undefined> }).loadChildRecipeInfo = () => loading;
    const sent: Array<Record<string, unknown>> = [];
    const client = { id: 8, ws: { send: (raw: string) => { sent.push(JSON.parse(raw)); } }, welcomed: false, auth: 'full', scopes: null };
    const welcoming = (webUiModule as unknown as { sendWelcome(client: unknown): Promise<void> }).sendWelcome(client);
    // A session switch while that welcome loads its recipes.
    bindFleet(new Map(), new Set(), () => { throw new Error('nothing is launching, so nothing should wait'); });
    loaded();
    await welcoming;
    expect(sent.filter((m) => m.type === 'welcome')).toEqual([]);
    expect(client.welcomed).toBe(false);
    delete (webUiModule as unknown as { loadChildRecipeInfo?: unknown }).loadChildRecipeInfo;
  });

  test("doesn't wait when nothing is launching, whatever the bind before was waiting for", async () => {
    bindFleet(new Map(), new Set(['kid']), () => new Promise<void>(() => {}));
    // A session switch to a framework whose fleet launches nothing.
    bindFleet(new Map(), new Set(), () => { throw new Error('nothing is launching, so nothing should wait'); });
    // Waiting on the bind before would take about the second its wait has
    // left, so a welcome that ends well inside it didn't wait.
    const started = Date.now();
    expect(await welcomeNow(6)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(900);
  });

  test('reads which children to list after its recipe loads, so a launch that ends during them is left out', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'welcome-autostart-'));
    try {
      const recipe = join(dir, 'c.json');
      writeFileSync(recipe, JSON.stringify({ name: 'Child', agent: { name: 'c', systemPrompt: 'never asked' } }));
      const launching = new Set(['kid']);
      bindFleet(new Map([['c', { status: 'ready', recipePath: recipe }]]), launching, () => Promise.resolve());
      // The recipe load is the welcome's await: the launch is refused while it's out.
      const loader = webUiModule as unknown as { loadChildRecipeInfo: (...args: unknown[]) => Promise<unknown> };
      const real = WebUiModule.prototype as unknown as typeof loader;
      loader.loadChildRecipeInfo = async (...args: unknown[]) => {
        launching.delete('kid');
        return real.loadChildRecipeInfo.apply(webUiModule, args);
      };
      expect(await welcomeNow(4)).toEqual([expect.objectContaining({ name: 'c', recipe: { name: 'Child' } })]);
    } finally {
      delete (webUiModule as unknown as { loadChildRecipeInfo?: unknown }).loadChildRecipeInfo;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
