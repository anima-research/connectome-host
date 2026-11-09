import { describe, test, expect } from 'bun:test';
import {
  SubagentModule,
  type ActiveSubagent,
} from '../src/modules/subagent-module.js';

interface FakeLiveState {
  frameworkAgentName: string;
  displayName: string;
  systemPrompt: string;
  contextManager: { compile: () => Promise<{ messages: unknown[] }> };
  currentStream: string;
  pendingToolCalls: Array<{ name: string; input?: unknown }>;
  activeCallIds: Set<string>;
  requestInFlightSince?: number;
}

function makeTree(): SubagentModule {
  const mod = new SubagentModule({ provider: 'mock' });
  const privateView = mod as unknown as {
    liveSubagents: Map<string, FakeLiveState>;
    frameworkNameIndex: Map<string, string>;
    runOfAttempt: Map<string, string>;
  };

  const installOne = (displayName: string, frameworkAgentName: string, parent?: string): void => {
    const live: FakeLiveState = {
      frameworkAgentName,
      displayName,
      systemPrompt: 'test',
      contextManager: { compile: async () => ({ messages: [] }) },
      currentStream: '',
      pendingToolCalls: [],
      activeCallIds: new Set(),
    };
    privateView.runOfAttempt.set(frameworkAgentName, displayName);
    privateView.liveSubagents.set(displayName, live);
    privateView.frameworkNameIndex.set(frameworkAgentName, displayName);
    const entry: ActiveSubagent = {
      name: displayName,
      type: 'spawn',
      task: `task-${displayName}`,
      status: 'running',
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      toolCallsCount: 0,
      findingsCount: 0,
    };
    mod.activeSubagents.set(`entry-${displayName}`, entry);
    if (parent !== undefined) mod.parentMap.set(displayName, parent);
  };

  installOne('child-a', 'fw-a', 'fw-top');
  installOne('child-b', 'fw-b', 'fw-top');
  installOne('grandchild-a1', 'fw-a1', 'fw-a');
  installOne('peer', 'fw-peer', 'fw-other-root');

  return mod;
}

describe('SubagentModule peek + HUD descendant scoping (P3 #8)', () => {
  test('peek() with no name and a caller returns only descendants', async () => {
    const mod = makeTree();
    const callerView = mod as unknown as {
      handlePeek: (input: { name?: string }, caller?: string) => Promise<{ success: boolean; data: unknown }>;
    };
    const result = await callerView.handlePeek({}, 'fw-top');
    const data = result.data as Array<{ name: string }>;
    const names = new Set(data.map(s => s.name));
    expect(names.has('child-a')).toBe(true);
    expect(names.has('child-b')).toBe(true);
    expect(names.has('grandchild-a1')).toBe(true);
    expect(names.has('peer')).toBe(false);
  });

  test('peek() called by a mid-tree caller scopes to that subtree', async () => {
    const mod = makeTree();
    const callerView = mod as unknown as {
      handlePeek: (input: { name?: string }, caller?: string) => Promise<{ success: boolean; data: unknown }>;
    };
    const result = await callerView.handlePeek({}, 'fw-a');
    const data = result.data as Array<{ name: string }>;
    const names = new Set(data.map(s => s.name));
    expect(names.has('grandchild-a1')).toBe(true);
    expect(names.has('child-b')).toBe(false);
    expect(names.has('peer')).toBe(false);
    expect(names.has('child-a')).toBe(false);
  });

  test('peek(name) on a non-descendant returns empty even if the name exists', async () => {
    const mod = makeTree();
    const callerView = mod as unknown as {
      handlePeek: (input: { name?: string }, caller?: string) => Promise<{ success: boolean; data: unknown }>;
    };
    const result = await callerView.handlePeek({ name: 'peer' }, 'fw-a');
    expect(result.data).toEqual({
      message: "No subagent of yours named 'peer' is running now. It may have finished (an async subagent's result arrives as a " +
        'message), or not have started yet, such as while it waits for a concurrency slot. subagent--peek with no name lists ' +
        'the ones running now.',
    });
  });

  test('peek(name) on a descendant works as before', async () => {
    const mod = makeTree();
    const callerView = mod as unknown as {
      handlePeek: (input: { name?: string }, caller?: string) => Promise<{ success: boolean; data: unknown }>;
    };
    const result = await callerView.handlePeek({ name: 'grandchild-a1' }, 'fw-a');
    const data = result.data as Array<{ name: string }>;
    expect(data.length).toBe(1);
    expect(data[0].name).toBe('grandchild-a1');
  });

  test('peek() without a caller (e.g. internal call) still sees everything', async () => {
    const mod = makeTree();
    const all = await mod.peek();
    expect(all.length).toBe(4);
  });

  test('gatherContext HUD is scoped to descendants of the calling agent', async () => {
    const mod = makeTree();
    (mod as unknown as { ctx: unknown }).ctx = {
      getState: () => ({ hudEnabled: true }),
      setState: () => {},
    };
    const injections = await mod.gatherContext('fw-a');
    expect(injections.length).toBeGreaterThan(0);
    const text = (injections[0].content[0] as { text: string }).text;
    expect(text).toMatch(/^\s*grandchild-a1 \[/m);
    expect(text).not.toMatch(/^\s*child-b \[/m);
    expect(text).not.toMatch(/^\s*peer \[/m);
    expect(text).not.toMatch(/^\s*child-a \[/m);
  });
});
