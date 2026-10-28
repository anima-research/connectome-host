import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModuleContext } from '@animalabs/agent-framework';
import {
  WebUiModule,
  __getSharedServerPortForTests,
  stopWebUiServer,
} from '../src/modules/web-ui-module.js';
import type { FleetEventCallback } from '../src/modules/fleet-module.js';

let webUiModule: WebUiModule;

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
  await stopWebUiServer();
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

  async function welcomeNow(id: number): Promise<Array<{ name: string; recipe?: Record<string, string> }>> {
    const sent: Array<Record<string, unknown>> = [];
    const client = { id, ws: { send: (raw: string) => { sent.push(JSON.parse(raw)); } }, welcomed: false, auth: 'full', scopes: null };
    await (webUiModule as unknown as { sendWelcome(client: unknown): Promise<void> }).sendWelcome(client);
    return (sent.find((m) => m.type === 'welcome') as unknown as { childTrees: Array<{ name: string; recipe?: Record<string, string> }> }).childTrees;
  }

  test('waits for the autoStart launches under way to record their children, so it carries their recipes', async () => {
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
      delete (webUiModule as unknown as { loadChildRecipeInfo?: unknown }).loadChildRecipeInfo;
      setTimeout(record, 50);
      expect(await welcomeNow(2)).toEqual([expect.objectContaining({
        name: 'kid', recipe: { name: 'Kid', description: 'Watches the parent', agentModel: 'claude-kid-model' },
      })]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("carries the recipe of a child whose numbers don't fit this host's MODEL", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'welcome-unfit-'));
    const model = process.env.MODEL;
    process.env.MODEL = 'claude-haiku-4-5';
    try {
      const recipe = join(dir, 'kid.json');
      writeFileSync(recipe, JSON.stringify({
        name: 'Kid', description: 'Writes long', agent: { name: 'kid', systemPrompt: 'never asked', model: 'claude-opus-4-6', maxTokens: 100_000 },
      }));
      bindFleet(new Map([['kid', { status: 'starting', recipePath: recipe }]]), new Set(), () => Promise.resolve());
      delete (webUiModule as unknown as { loadChildRecipeInfo?: unknown }).loadChildRecipeInfo;
      expect(await welcomeNow(7)).toEqual([expect.objectContaining({
        name: 'kid', recipe: { name: 'Kid', description: 'Writes long', agentModel: 'claude-opus-4-6' },
      })]);
    } finally {
      if (model === undefined) delete process.env.MODEL; else process.env.MODEL = model;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('waits once per bind, a second at most: a launch not recorded by then is listed by name, and later welcomes do not wait', async () => {
    const launching = new Set(['kid']);
    delete (webUiModule as unknown as { loadChildRecipeInfo?: unknown }).loadChildRecipeInfo;
    const started = Date.now();
    const binding = bindFleet(new Map(), launching, () => new Promise<void>(() => {}));
    const [first, second] = await Promise.all([welcomeNow(3), welcomeNow(4)]);
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(950);
    expect(waited).toBeLessThan(1_900);
    for (const listed of [first, second]) {
      expect(listed.map((t) => t.name)).toEqual(['kid']);
      expect(listed[0]?.recipe).toBeUndefined();
    }
    const later = Date.now();
    const listed = await welcomeNow(5);
    expect(Date.now() - later).toBeLessThan(900);
    expect(listed.map((t) => t.name)).toEqual(['kid']);
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
    bindFleet(new Map(), new Set(), () => { throw new Error('nothing is launching, so nothing should wait'); });
    await waiting;
    expect(sent.filter((m) => m.type === 'welcome')).toEqual([]);
    expect(client.welcomed).toBe(false);
  });

  test('a welcome that a newer bind superseded while it loaded recipes sends nothing', async () => {
    bindFleet(new Map([['c', { status: 'ready', recipePath: '/unused/c.json' }]]), new Set(), () => {
      throw new Error('nothing is launching, so nothing should wait');
    });
    let loaded!: () => void;
    const loading = new Promise<undefined>((done) => { loaded = () => done(undefined); });
    (webUiModule as unknown as { loadChildRecipeInfo: () => Promise<undefined> }).loadChildRecipeInfo = () => loading;
    const sent: Array<Record<string, unknown>> = [];
    const client = { id: 8, ws: { send: (raw: string) => { sent.push(JSON.parse(raw)); } }, welcomed: false, auth: 'full', scopes: null };
    const welcoming = (webUiModule as unknown as { sendWelcome(client: unknown): Promise<void> }).sendWelcome(client);
    bindFleet(new Map(), new Set(), () => { throw new Error('nothing is launching, so nothing should wait'); });
    loaded();
    await welcoming;
    expect(sent.filter((m) => m.type === 'welcome')).toEqual([]);
    expect(client.welcomed).toBe(false);
    delete (webUiModule as unknown as { loadChildRecipeInfo?: unknown }).loadChildRecipeInfo;
  });

  test("doesn't wait when nothing is launching, whatever the bind before was waiting for", async () => {
    bindFleet(new Map(), new Set(['kid']), () => new Promise<void>(() => {}));
    bindFleet(new Map(), new Set(), () => { throw new Error('nothing is launching, so nothing should wait'); });
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
