/**
 * Unit tests for the /fleet slash-command dispatcher in commands.ts.
 *
 * Covers the surface the rest of the test suite doesn't touch: argument
 * parsing, subcommand routing, unknown/usage-hint paths, and the
 * CommandResult flags (switchToFleetView, switchToFleetPeek, asyncWork)
 * that the TUI relies on for view changes.
 */
import { describe, test, expect } from 'bun:test';
import { handleCommand, type CommandResult } from '../src/commands.js';
import type { FleetModule } from '../src/modules/fleet-module.js';
import type { AgentFramework } from '@animalabs/agent-framework';
import type { ToolCall, ToolResult } from '@animalabs/agent-framework';

// --- Minimal AppContext + FleetModule stubs ------------------------------

interface StubChild {
  name: string;
  recipePath: string;
  dataDir: string;
  socketPath: string;
  pid: number | null;
  status: 'starting' | 'ready' | 'exited' | 'crashed';
  startedAt: number;
  exitedAt: number | null;
  lastEventAt: number | null;
  exitCode: number | null;
  exitReason: string | null;
  events: Array<{ type: string }>;
  subscription: string[];
}

function buildStubChild(name: string, status: StubChild['status'] = 'ready'): StubChild {
  return {
    name,
    recipePath: `recipes/${name}.json`,
    dataDir: `./data/${name}`,
    socketPath: `./data/${name}/ipc.sock`,
    pid: 9999,
    status,
    startedAt: Date.now() - 60_000,
    exitedAt: null,
    lastEventAt: Date.now() - 1_000,
    exitCode: null,
    exitReason: null,
    events: [],
    subscription: ['*'],
  };
}

interface StubFleet {
  name: 'fleet';
  lastCall: ToolCall | null;
  nextResult: ToolResult;
  children: Map<string, StubChild>;
  getChildren(): Map<string, StubChild>;
  handleToolCall(call: ToolCall): Promise<ToolResult>;
}

function buildStubFleet(children: StubChild[] = []): StubFleet {
  const map = new Map<string, StubChild>();
  for (const c of children) map.set(c.name, c);
  const stub: StubFleet = {
    name: 'fleet',
    lastCall: null,
    nextResult: { success: true, data: { ok: true } },
    children: map,
    getChildren(): Map<string, StubChild> { return this.children; },
    async handleToolCall(call: ToolCall): Promise<ToolResult> {
      this.lastCall = call;
      return this.nextResult;
    },
  };
  return stub;
}

function buildStubApp(fleet: StubFleet | null): Parameters<typeof handleCommand>[1] {
  const modules = fleet ? [fleet] : [];
  return {
    framework: {
      getAllModules: () => modules,
      // We don't need the rest of AgentFramework for /fleet dispatch.
    } as unknown as AgentFramework,
    sessionManager: {} as never,
    recipe: { name: 'test' } as never,
    branchState: {} as never,
    switchSession: async () => {},
  };
}

// --- Tests ---------------------------------------------------------------

describe('/fleet dispatcher', () => {
  test('no fleet module → graceful hint, not a crash', () => {
    const app = buildStubApp(null);
    const res = handleCommand('/fleet list', app);
    expect(res.quit).toBeUndefined();
    expect(res.lines.length).toBeGreaterThan(0);
    expect(res.lines.some((l) => /not enabled/i.test(l.text))).toBe(true);
  });

  test('/fleet (no args) → list', () => {
    const fleet = buildStubFleet([buildStubChild('miner'), buildStubChild('clerk')]);
    const app = buildStubApp(fleet as unknown as FleetModule);
    const res = handleCommand('/fleet', app);
    expect(res.lines.some((l) => /miner/.test(l.text))).toBe(true);
    expect(res.lines.some((l) => /clerk/.test(l.text))).toBe(true);
  });

  test('/fleet list → lists every child', () => {
    const fleet = buildStubFleet([
      buildStubChild('a', 'ready'),
      buildStubChild('b', 'crashed'),
    ]);
    const app = buildStubApp(fleet as unknown as FleetModule);
    const res = handleCommand('/fleet list', app);
    expect(res.lines.some((l) => /\ba\b/.test(l.text) && /ready/.test(l.text))).toBe(true);
    expect(res.lines.some((l) => /\bb\b/.test(l.text) && /crashed/.test(l.text))).toBe(true);
  });

  test('/fleet list with no children → empty message', () => {
    const fleet = buildStubFleet([]);
    const app = buildStubApp(fleet as unknown as FleetModule);
    const res = handleCommand('/fleet list', app);
    expect(res.lines.some((l) => /no children/i.test(l.text))).toBe(true);
  });

  test('/fleet status <name> → detailed status', () => {
    const fleet = buildStubFleet([buildStubChild('miner')]);
    const app = buildStubApp(fleet as unknown as FleetModule);
    const res = handleCommand('/fleet status miner', app);
    expect(res.lines.some((l) => /recipe:/.test(l.text))).toBe(true);
    expect(res.lines.some((l) => /dataDir:/.test(l.text))).toBe(true);
    expect(res.lines.some((l) => /pid:/.test(l.text))).toBe(true);
  });

  test('/fleet status without name → falls back to list', () => {
    const fleet = buildStubFleet([buildStubChild('solo')]);
    const app = buildStubApp(fleet as unknown as FleetModule);
    const res = handleCommand('/fleet status', app);
    expect(res.lines.some((l) => /solo/.test(l.text))).toBe(true);
  });

  test('/fleet status <unknown> → error message', () => {
    const fleet = buildStubFleet([]);
    const app = buildStubApp(fleet as unknown as FleetModule);
    const res = handleCommand('/fleet status ghost', app);
    expect(res.lines.some((l) => /Unknown child/i.test(l.text))).toBe(true);
  });

  test('/fleet view → switchToFleetView flag', () => {
    const fleet = buildStubFleet([]);
    const app = buildStubApp(fleet as unknown as FleetModule);
    const res = handleCommand('/fleet view', app);
    expect(res.switchToFleetView).toBe(true);
  });

  test('/fleet peek <name> → switchToFleetPeek with name', () => {
    const fleet = buildStubFleet([buildStubChild('miner')]);
    const app = buildStubApp(fleet as unknown as FleetModule);
    const res = handleCommand('/fleet peek miner', app);
    expect(res.switchToFleetPeek).toBe('miner');
  });

  test('/fleet peek <unknown> → no switch, error message', () => {
    const fleet = buildStubFleet([]);
    const app = buildStubApp(fleet as unknown as FleetModule);
    const res = handleCommand('/fleet peek ghost', app);
    expect(res.switchToFleetPeek).toBeUndefined();
    expect(res.lines.some((l) => /Unknown child/i.test(l.text))).toBe(true);
  });

  test('/fleet peek with no name → usage hint', () => {
    const fleet = buildStubFleet([]);
    const app = buildStubApp(fleet as unknown as FleetModule);
    const res = handleCommand('/fleet peek', app);
    expect(res.lines.some((l) => /Usage/i.test(l.text) && /peek/i.test(l.text))).toBe(true);
  });

  test('/fleet stop <name> → dispatches kill via asyncWork', async () => {
    const fleet = buildStubFleet([buildStubChild('miner')]);
    fleet.nextResult = { success: true, data: { status: 'exited', exitCode: 0 } };
    const app = buildStubApp(fleet as unknown as FleetModule);
    const res = handleCommand('/fleet stop miner', app);
    expect(res.asyncWork).toBeDefined();
    expect(res.lines.some((l) => /Stopping miner/.test(l.text))).toBe(true);

    const asyncRes = await (res.asyncWork as Promise<CommandResult>);
    expect(asyncRes.lines.some((l) => /kill miner/.test(l.text))).toBe(true);
    expect(fleet.lastCall?.name).toBe('kill');
    expect((fleet.lastCall?.input as { name?: string }).name).toBe('miner');
  });

  test('/fleet stop surfaces errors from handleToolCall', async () => {
    const fleet = buildStubFleet([buildStubChild('miner')]);
    fleet.nextResult = { success: false, isError: true, error: 'boom' };
    const app = buildStubApp(fleet as unknown as FleetModule);
    const res = handleCommand('/fleet stop miner', app);
    const asyncRes = await (res.asyncWork as Promise<CommandResult>);
    expect(asyncRes.lines.some((l) => /failed/i.test(l.text) && /boom/.test(l.text))).toBe(true);
  });

  test('/fleet stop with no name → usage hint', () => {
    const fleet = buildStubFleet([]);
    const app = buildStubApp(fleet as unknown as FleetModule);
    const res = handleCommand('/fleet stop', app);
    expect(res.asyncWork).toBeUndefined();
    expect(res.lines.some((l) => /Usage/i.test(l.text) && /stop/i.test(l.text))).toBe(true);
  });

  test('/fleet restart <name> → dispatches restart via asyncWork', async () => {
    const fleet = buildStubFleet([buildStubChild('miner')]);
    fleet.nextResult = { success: true, data: { status: 'ready' } };
    const app = buildStubApp(fleet as unknown as FleetModule);
    const res = handleCommand('/fleet restart miner', app);
    expect(res.asyncWork).toBeDefined();
    await (res.asyncWork as Promise<CommandResult>);
    expect(fleet.lastCall?.name).toBe('restart');
  });

  test('/fleet restart with no name → usage hint', () => {
    const fleet = buildStubFleet([]);
    const app = buildStubApp(fleet as unknown as FleetModule);
    const res = handleCommand('/fleet restart', app);
    expect(res.asyncWork).toBeUndefined();
    expect(res.lines.some((l) => /Usage/i.test(l.text) && /restart/i.test(l.text))).toBe(true);
  });

  test('/fleet <unknown-sub> → helpful error', () => {
    const fleet = buildStubFleet([]);
    const app = buildStubApp(fleet as unknown as FleetModule);
    const res = handleCommand('/fleet spitroast miner', app);
    expect(res.lines.some((l) => /Unknown .* subcommand/i.test(l.text) && /spitroast/.test(l.text))).toBe(true);
  });

  test('/fleet kill alias = /fleet stop', async () => {
    const fleet = buildStubFleet([buildStubChild('miner')]);
    fleet.nextResult = { success: true, data: { status: 'exited', exitCode: 0 } };
    const app = buildStubApp(fleet as unknown as FleetModule);
    const res = handleCommand('/fleet kill miner', app);
    await (res.asyncWork as Promise<CommandResult>);
    expect(fleet.lastCall?.name).toBe('kill');
  });
});
