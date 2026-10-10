/**
 * The welcome reads its state after its one await, and nothing yields from
 * that read to marking the client welcomed. A client skips live events until
 * then, so state copied before an await would miss whatever landed during it.
 * A fleet child's usage sample missed that way leaves the client's copy of the
 * stream one call behind, and its next sample would show two calls' prompts as
 * one context size.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
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
});
