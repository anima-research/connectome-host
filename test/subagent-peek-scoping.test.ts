/**
 * Postmortem 2026-05-28 P3 #8: scope `peek` and the `gatherContext` HUD to
 * the caller's descendants only. Today both surfaces show the global roster:
 *
 *   - `peek()` (no arg) returns snapshots for every running subagent in the
 *      fleet, including peers and cousins of the caller.
 *   - `peek(name)` accepts any name — there's no descendant check.
 *   - `gatherContext` iterates `activeSubagents` directly with no parent
 *      filter, so when the HUD is on the caller's context is injected with
 *      the full fleet roster every turn.
 *
 * This invites a "coordinate with peers" anti-pattern (visible in the
 * production miner's narration: scouts gossiping about siblings being
 * zombied) and lets one slow scout's status saturate the orchestrator's
 * context and trigger retry-storm spawn behavior.
 *
 * The fix uses `parentMap` (already maintained for cancelChildren) to walk
 * descendants. A caller sees only its own subtree — peers and ancestors are
 * filtered out.
 */
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

/** Build a peek-ready SubagentModule with a tree of subagents wired up:
 *
 *      root  ('top')
 *        ├── child-a   (parent: root)
 *        │     └── grandchild-a1 (parent: child-a)
 *        ├── child-b   (parent: root)
 *        └── peer      (parent: 'other-root') — NOT in the tree
 *
 * Caller framework agent names: root = 'fw-top', child-a = 'fw-a',
 * child-b = 'fw-b', grandchild-a1 = 'fw-a1', peer = 'fw-peer'.
 */
function makeTree(): SubagentModule {
  const mod = new SubagentModule();
  const privateView = mod as unknown as {
    liveSubagents: Map<string, FakeLiveState>;
    frameworkNameIndex: Map<string, string>;
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
    // The top-level caller ('fw-top') owns child-a, child-b, grandchild-a1
    // (transitively). It does NOT own peer.
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
    // child-a's subtree is just grandchild-a1 — siblings (child-b) and
    // cousins (peer) and ancestors (root) must be invisible.
    const result = await callerView.handlePeek({}, 'fw-a');
    const data = result.data as Array<{ name: string }>;
    const names = new Set(data.map(s => s.name));
    expect(names.has('grandchild-a1')).toBe(true);
    expect(names.has('child-b')).toBe(false);
    expect(names.has('peer')).toBe(false);
    expect(names.has('child-a')).toBe(false); // caller doesn't see itself
  });

  test('peek(name) on a non-descendant returns empty even if the name exists', async () => {
    const mod = makeTree();
    const callerView = mod as unknown as {
      handlePeek: (input: { name?: string }, caller?: string) => Promise<{ success: boolean; data: unknown }>;
    };
    // child-a tries to peek peer (which exists fleet-wide but is not a
    // descendant of child-a). Should return "no such subagent" from
    // child-a's perspective.
    const result = await callerView.handlePeek({ name: 'peer' }, 'fw-a');
    expect(result.data).toEqual({ message: "No running subagent named 'peer'" });
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
    // Backward compat: not all callers thread an identity through (e.g.
    // internal observability paths, tests). When no caller is provided, the
    // descendant filter is bypassed.
    const mod = makeTree();
    const all = await mod.peek();
    expect(all.length).toBe(4); // child-a + child-b + grandchild-a1 + peer
  });

  test('gatherContext HUD is scoped to descendants of the calling agent', async () => {
    const mod = makeTree();
    // Force the HUD on by directly setting the persisted flag's source — the
    // module checks ctx?.getState().hudEnabled, but in this minimal test
    // there's no ctx, so the early return at the top of gatherContext would
    // bail. Pre-fix the function returned [] without ctx; post-fix the
    // descendant filter must still be exercised. To keep the test focused on
    // scoping (not on persistence wiring), stub ctx with a hudEnabled=true
    // state-bag and an empty setState.
    (mod as unknown as { ctx: unknown }).ctx = {
      getState: () => ({ hudEnabled: true }),
      setState: () => {},
    };
    const injections = await mod.gatherContext('fw-a');
    expect(injections.length).toBeGreaterThan(0);
    const text = (injections[0].content[0] as { text: string }).text;
    // Each HUD line begins with two spaces then the subagent name and ' [type]'.
    // Anchor on that to avoid substring collisions (grandchild-a1 contains
    // the literal 'child-a' as a substring, which would make a naïve
    // includes() check false-positive).
    expect(text).toMatch(/^\s*grandchild-a1 \[/m);
    expect(text).not.toMatch(/^\s*child-b \[/m);
    expect(text).not.toMatch(/^\s*peer \[/m);
    expect(text).not.toMatch(/^\s*child-a \[/m); // caller's own entry not surfaced
  });
});
