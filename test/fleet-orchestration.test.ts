/**
 * Tests for the orchestration primitives added alongside the Phase-5 caveat fixes:
 *   - child-side synthetic events (lifecycle:idle, inference:speech)
 *   - fleet--relay (sibling messaging)
 *   - fleet--await (fan-out wait)
 *
 * Uses a minimal mock child (test/mock-headless-child.ts) so the tests don't
 * need an ANTHROPIC_API_KEY or a working framework/Membrane/Chronicle stack.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FleetModule, type FleetModuleConfig } from '../src/modules/fleet-module.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const MOCK_CHILD_PATH = join(TEST_DIR, 'mock-headless-child.ts');

function makeFleet(overrides: Partial<FleetModuleConfig> = {}): FleetModule {
  return new FleetModule({
    childIndexPath: MOCK_CHILD_PATH,
    socketWaitTimeoutMs: 10_000,
    readyTimeoutMs: 5_000,
    gracefulShutdownMs: 3_000,
    sigtermEscalationMs: 1_000,
    ...overrides,
  });
}

async function launchChild(fleet: FleetModule, name: string, dataDir: string): Promise<void> {
  const res = await fleet.handleToolCall({
    id: `launch-${name}`,
    name: 'launch',
    input: { name, recipe: 'mock-recipe', dataDir },
  });
  if (!res.success) {
    throw new Error(`launch ${name} failed: ${res.error}`);
  }
}

async function send(fleet: FleetModule, name: string, content: string): Promise<void> {
  const res = await fleet.handleToolCall({
    id: `send-${name}-${Date.now()}`,
    name: 'send',
    input: { name, content },
  });
  if (!res.success) throw new Error(`send to ${name} failed: ${res.error}`);
}

async function command(fleet: FleetModule, name: string, cmd: string): Promise<void> {
  const res = await fleet.handleToolCall({
    id: `cmd-${name}-${Date.now()}`,
    name: 'command',
    input: { name, command: cmd },
  });
  if (!res.success) throw new Error(`command ${cmd} to ${name} failed: ${res.error}`);
}

async function waitFor(check: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`waitFor timed out: ${label}`);
}

describe('lifecycle:idle + inference:speech from mock child', () => {
  let tmpDir: string;
  let fleet: FleetModule;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fkm-orch-synth-'));
    fleet = makeFleet();
    await fleet.start({} as unknown as Parameters<typeof fleet.start>[0]);
    await launchChild(fleet, 'a', join(tmpDir, 'a'));
  });

  afterAll(async () => {
    try { await fleet.stop(); } catch { /* noop */ }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  });

  test('text command triggers inference:speech and lifecycle:idle', async () => {
    await send(fleet, 'a', 'hello there');

    await waitFor(
      () => fleet.getChildren().get('a')!.lastCompletedSpeech.length > 0,
      2_000,
      'lastCompletedSpeech populated from inference:speech',
    );
    expect(fleet.getChildren().get('a')!.lastCompletedSpeech).toBe('echo: hello there');

    await waitFor(
      () => fleet.getChildren().get('a')!.events.some(
        (e) => e.type === 'lifecycle' && (e as { phase?: string }).phase === 'idle',
      ),
      2_000,
      'lifecycle:idle event recorded',
    );
  });

  test('tool-ending round does NOT update lastCompletedSpeech; final round does', async () => {
    // Before: we have "echo: hello there" from the previous test.
    const before = fleet.getChildren().get('a')!.lastCompletedSpeech;
    expect(before).toContain('echo: hello there');

    await command(fleet, 'a', '/tool-use-then-speak FINAL-ANSWER');

    await waitFor(
      () => fleet.getChildren().get('a')!.lastCompletedSpeech === 'FINAL-ANSWER',
      3_000,
      'lastCompletedSpeech updated to FINAL-ANSWER (tool-use round ignored)',
    );
  });
});

describe('fleet--relay', () => {
  let tmpDir: string;
  let fleet: FleetModule;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fkm-orch-relay-'));
    fleet = makeFleet();
    await fleet.start({} as unknown as Parameters<typeof fleet.start>[0]);
    await launchChild(fleet, 'src', join(tmpDir, 'src'));
    await launchChild(fleet, 'dst', join(tmpDir, 'dst'));
  });

  afterAll(async () => {
    try { await fleet.stop(); } catch { /* noop */ }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  });

  test('errors when source has no completed speech yet', async () => {
    const res = await fleet.handleToolCall({
      id: 'relay-empty',
      name: 'relay',
      input: { from: 'src', to: 'dst' },
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/No completed speech/i);
  });

  test('relays source speech to target (with prefix)', async () => {
    await send(fleet, 'src', 'findings summary');
    await waitFor(
      () => fleet.getChildren().get('src')!.lastCompletedSpeech === 'echo: findings summary',
      2_000,
      'src lastCompletedSpeech set',
    );

    const res = await fleet.handleToolCall({
      id: 'relay-ok',
      name: 'relay',
      input: { from: 'src', to: 'dst', prefix: 'Miner says:' },
    });
    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({ from: 'src', to: 'dst' });

    // The mock echoes whatever text it receives, so the destination's
    // lastCompletedSpeech should reflect our prefixed payload.
    await waitFor(
      () => fleet.getChildren().get('dst')!.lastCompletedSpeech.startsWith('echo: Miner says:'),
      3_000,
      'dst received relayed message and echoed',
    );
    expect(fleet.getChildren().get('dst')!.lastCompletedSpeech).toContain('findings summary');
  });

  test('rejects same-child relay', async () => {
    const res = await fleet.handleToolCall({
      id: 'relay-self',
      name: 'relay',
      input: { from: 'src', to: 'src' },
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/different children/);
  });

  test('rejects unknown children', async () => {
    const res1 = await fleet.handleToolCall({
      id: 'relay-nosrc', name: 'relay', input: { from: 'ghost', to: 'dst' },
    });
    expect(res1.success).toBe(false);
    expect(res1.error).toMatch(/Unknown source child/);

    const res2 = await fleet.handleToolCall({
      id: 'relay-nodst', name: 'relay', input: { from: 'src', to: 'ghost' },
    });
    expect(res2.success).toBe(false);
    expect(res2.error).toMatch(/Unknown child/);
  });
});

describe('fleet--await', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fkm-orch-await-'));
  });

  afterAll(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  });

  test('returns immediately when all named children are already idle', async () => {
    const fleet = makeFleet();
    await fleet.start({} as unknown as Parameters<typeof fleet.start>[0]);
    await launchChild(fleet, 'x', join(tmpDir, 'x1'));

    // Trigger one round so child emits lifecycle:idle.
    await send(fleet, 'x', 'hi');
    await waitFor(
      () => fleet.getChildren().get('x')!.events.some(
        (e) => e.type === 'lifecycle' && (e as { phase?: string }).phase === 'idle',
      ),
      2_000,
      'x became idle',
    );

    const t0 = Date.now();
    const res = await fleet.handleToolCall({
      id: 'await-idle-fast',
      name: 'await',
      input: { names: ['x'], timeoutMs: 1_000 },
    });
    const elapsed = Date.now() - t0;
    expect(res.success).toBe(true);
    expect((res.data as { completed?: boolean }).completed).toBe(true);
    expect(elapsed).toBeLessThan(500);

    await fleet.stop();
  });

  test('blocks until all named children emit idle', async () => {
    const fleet = makeFleet();
    await fleet.start({} as unknown as Parameters<typeof fleet.start>[0]);
    await launchChild(fleet, 'p', join(tmpDir, 'p'));
    await launchChild(fleet, 'q', join(tmpDir, 'q'));

    // Kick both, then await — the await should resolve after both idle up.
    const awaitPromise = (async () => {
      // tiny delay to make sure the sends land before the wait checks "already idle"
      await new Promise((r) => setTimeout(r, 50));
      return fleet.handleToolCall({
        id: 'await-both',
        name: 'await',
        input: { names: ['p', 'q'], timeoutMs: 5_000 },
      });
    })();

    await send(fleet, 'p', 'work');
    await send(fleet, 'q', 'work');

    const res = await awaitPromise;
    expect(res.success).toBe(true);
    const data = res.data as { names: string[]; completed: boolean };
    expect(data.completed).toBe(true);
    expect(data.names.sort()).toEqual(['p', 'q']);

    await fleet.stop();
  }, 15_000);

  test('returns on any idle when requireAll is false', async () => {
    const fleet = makeFleet();
    await fleet.start({} as unknown as Parameters<typeof fleet.start>[0]);
    await launchChild(fleet, 'fast', join(tmpDir, 'fast'));
    await launchChild(fleet, 'slow', join(tmpDir, 'slow'));

    const awaitPromise = (async () => {
      await new Promise((r) => setTimeout(r, 50));
      return fleet.handleToolCall({
        id: 'await-any',
        name: 'await',
        input: { names: ['fast', 'slow'], timeoutMs: 5_000, requireAll: false },
      });
    })();

    await send(fleet, 'fast', 'quick');
    // 'slow' left unbothered — requireAll:false means we return as soon as fast idles.

    const res = await awaitPromise;
    expect(res.success).toBe(true);
    const data = res.data as { names: string[]; completed: boolean };
    expect(data.completed).toBe(true);
    expect(data.names).toContain('fast');

    await fleet.stop();
  }, 15_000);

  test('times out returning partial set', async () => {
    const fleet = makeFleet();
    await fleet.start({} as unknown as Parameters<typeof fleet.start>[0]);
    await launchChild(fleet, 'stuck', join(tmpDir, 'stuck'));

    await command(fleet, 'stuck', '/hang');

    const res = await fleet.handleToolCall({
      id: 'await-timeout',
      name: 'await',
      input: { names: ['stuck'], timeoutMs: 300 },
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/timed out/i);

    await fleet.stop();
  }, 15_000);

  test('fails fast when waited-for child crashes', async () => {
    const fleet = makeFleet();
    await fleet.start({} as unknown as Parameters<typeof fleet.start>[0]);
    await launchChild(fleet, 'doomed', join(tmpDir, 'doomed'));

    const awaitPromise = (async () => {
      await new Promise((r) => setTimeout(r, 50));
      return fleet.handleToolCall({
        id: 'await-crash',
        name: 'await',
        input: { names: ['doomed'], timeoutMs: 5_000 },
      });
    })();

    // Send the crash command.
    await command(fleet, 'doomed', '/crash');

    const res = await awaitPromise;
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/crashed|exited/);

    await fleet.stop();
  }, 15_000);

  test('rejects empty or unknown names', async () => {
    const fleet = makeFleet();
    await fleet.start({} as unknown as Parameters<typeof fleet.start>[0]);

    const empty = await fleet.handleToolCall({
      id: 'await-empty', name: 'await', input: { names: [] },
    });
    expect(empty.success).toBe(false);
    expect(empty.error).toMatch(/non-empty/);

    const unknown = await fleet.handleToolCall({
      id: 'await-unk', name: 'await', input: { names: ['ghost'] },
    });
    expect(unknown.success).toBe(false);
    expect(unknown.error).toMatch(/Unknown child/);

    await fleet.stop();
  });
});
