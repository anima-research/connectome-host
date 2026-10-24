/**
 * FleetModule.requestPanel — the promise-based panel-op verb the WebUI's
 * fleet-scope routing rides on (WS panels and the HTTP ?scope= proxy).
 *
 * Uses the mock headless child, which answers panel-request with:
 *   op 'hang' → nothing (the timeout path, or the closed-connection path)
 *   op 'fail' → {ok:false, error, status:418} (error passthrough)
 *   others    → {ok:true, data:{op, echo:params}}
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
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

describe('FleetModule.requestPanel', () => {
  let tmpDir: string;
  let fleet: FleetModule;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fkm-panel-'));
    fleet = makeFleet();
    const res = await fleet.handleToolCall({
      id: 'launch-panelkid',
      name: 'launch',
      input: { name: 'panelkid', recipe: 'mock-recipe', dataDir: join(tmpDir, 'panelkid') },
    });
    if (!res.success) throw new Error(`launch failed: ${res.error}`);
  });

  afterAll(async () => {
    try { await fleet.stop(); } catch { /* noop */ }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  });

  test('round-trips op + params and resolves the child data', async () => {
    const result = await fleet.requestPanel('panelkid', 'settings', { agent: 'clerk' });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ op: 'settings', echo: { agent: 'clerk' } });
  });

  test('concurrent requests correlate independently', async () => {
    const [a, b] = await Promise.all([
      fleet.requestPanel('panelkid', 'health', { n: 1 }),
      fleet.requestPanel('panelkid', 'pins', { n: 2 }),
    ]);
    expect(a.ok).toBe(true);
    expect((a.data as { op: string }).op).toBe('health');
    expect(b.ok).toBe(true);
    expect((b.data as { op: string }).op).toBe('pins');
    // Answered, neither waits on the connection's close any longer.
    const socket = fleet.getChildren().get('panelkid')!.socket!;
    const waiting = (fleet as unknown as { waitingOn: WeakMap<object, Set<unknown>> }).waitingOn.get(socket);
    expect(waiting?.size).toBe(0);
  });

  test('child-reported failure passes error and status through', async () => {
    const result = await fleet.requestPanel('panelkid', 'fail');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('mock failure');
    expect(result.status).toBe(418);
  });

  test('unanswered request resolves ok:false with 504 after timeoutMs', async () => {
    const started = Date.now();
    const result = await fleet.requestPanel('panelkid', 'hang', undefined, 400);
    expect(Date.now() - started).toBeGreaterThanOrEqual(380);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(504);
    expect(result.error).toBe("panel op 'hang' timed out after 400ms: child 'panelkid' sent no answer in that time");
  });

  test("a switch's request round-trips on the same path, and the child is among those it reaches", async () => {
    expect(fleet.runningChildren()).toEqual([{ name: 'panelkid' }]);
    const request = { op: 'quiesce' as const, to: '9.9.9', waitMs: 0 };
    const [quiesced, panel] = await Promise.all([fleet.requestSwitch('panelkid', request, 5_000), fleet.requestPanel('panelkid', 'health')]);
    expect(quiesced).toEqual({
      ok: true,
      data: { drained: false, activeTurnAgents: ['mock'], backgroundScripts: 0, echo: request },
    });
    expect((panel.data as { op: string }).op).toBe('health');
    expect(await fleet.requestSwitch('nobody', { op: 'resume' }, 5_000)).toMatchObject({ ok: false, status: 404 });
  });

  test('unknown child resolves ok:false with 404 without touching the wire', async () => {
    const result = await fleet.requestPanel('nobody', 'settings');
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.error).toContain('nobody');
  });
});

describe("the children a switch's quiesce reaches", () => {
  test("are those that may be running: one that has exited isn't asked, and one whose connection has closed is, and says why it can't answer", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fkm-switch-reach-'));
    const fleet = makeFleet();
    try {
      for (const name of ['up', 'gone']) {
        const res = await fleet.handleToolCall({ id: `launch-${name}`, name: 'launch', input: { name, recipe: 'mock-recipe', dataDir: join(dir, name) } });
        if (!res.success) throw new Error(`launch failed: ${res.error}`);
      }
      expect(fleet.runningChildren()).toEqual([{ name: 'up' }, { name: 'gone' }]);
      await fleet.handleToolCall({ id: 'kill-gone', name: 'kill', input: { name: 'gone' } });
      // Its entry stays, with the status it ended with.
      expect(fleet.getChildren().get('gone')?.status).toBe('exited');
      expect(fleet.runningChildren()).toEqual([{ name: 'up' }]);
      // Of the four statuses, starting and ready may be running; crashed and
      // exited can't be.
      const gone = fleet.getChildren().get('gone') as { status: string };
      for (const [status, listed] of [['starting', true], ['crashed', false], ['ready', true], ['exited', false]] as const) {
        gone.status = status;
        expect(fleet.runningChildren().some((c) => c.name === 'gone'), status).toBe(listed);
      }
      // The requests waiting on a child are answered as soon as its
      // connection closes, rather than when their wait is up, through one
      // listener on the connection however many there are.
      const up = fleet.getChildren().get('up')!;
      const socket = up.socket!;
      const listeners = socket.listenerCount('close');
      const pending = Array.from({ length: 12 }, () => fleet.requestPanel('up', 'hang', undefined, 20_000));
      expect(socket.listenerCount('close')).toBe(listeners + 1);
      // A ready child whose connection closes, its exit not yet seen, may be
      // mid-turn: the switch asks it, and hears why it can't answer.
      socket.destroy();
      for (const answer of await Promise.all(pending)) {
        expect(answer).toEqual({
          ok: false,
          error: "panel op 'hang' got no answer, since the connection to child 'up' closed before one came, so it may or may " +
            'not have taken effect',
          status: 502,
        });
      }
      await new Promise<void>((done) => { const poll = setInterval(() => { if (up.socket === null) { clearInterval(poll); done(); } }, 5); });
      expect(fleet.runningChildren()).toEqual([{ name: 'up' }]);
      const answer = await fleet.requestSwitch('up', { op: 'quiesce', to: '9.9.9', waitMs: 0 }, 5_000);
      expect(answer).toMatchObject({ ok: false, status: 502 });
      expect(answer.error).toContain("child 'up' is ready, but its connection to this host has closed and its exit hasn't been seen yet");
    } finally {
      try { await fleet.stop(); } catch { /* noop */ }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
