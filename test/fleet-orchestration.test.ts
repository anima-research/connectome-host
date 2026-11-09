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

function settledFlag(pending: Promise<unknown>): () => boolean {
  let settled = false;
  void pending.then(() => { settled = true; });
  return () => settled;
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
    try { await fleet.stop(); } catch { }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { }
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
    try { await fleet.stop(); } catch { }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { }
  });

  test('errors when source has no completed speech yet', async () => {
    const res = await fleet.handleToolCall({
      id: 'relay-empty',
      name: 'relay',
      input: { from: 'src', to: 'dst' },
    });
    expect(res.success).toBe(false);
    expect(res.error).toStartWith("Nothing was relayed: 'src' hasn't finished a reply since this host's connection to it last opened.");
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
    expect(res.error).toBe(
      "Nothing was relayed: \"from\" and \"to\" are both 'src', and a relay passes one child's reply to another. " +
      "Give two different children's names.",
    );
  });

  test('rejects unknown children', async () => {
    const res1 = await fleet.handleToolCall({
      id: 'relay-nosrc', name: 'relay', input: { from: 'ghost', to: 'dst' },
    });
    expect(res1.success).toBe(false);
    expect(res1.error).toStartWith("There's no child named 'ghost', so nothing was relayed.");

    const res2 = await fleet.handleToolCall({
      id: 'relay-nodst', name: 'relay', input: { from: 'src', to: 'ghost' },
    });
    expect(res2.success).toBe(false);
    expect(res2.error).toStartWith("There's no child named 'ghost', so nothing was relayed.");
  });
});

describe('fleet--await', () => {
  let tmpDir: string;
  const heldUntilReleased = (name: string): { text: string; release: () => void } => {
    const path = join(tmpDir, `release-${name}`);
    return { text: `held:${path}`, release: () => writeFileSync(path, '') };
  };

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fkm-orch-await-'));
  });

  afterAll(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { }
  });

  test('returns immediately when all named children are already idle', async () => {
    const fleet = makeFleet();
    await fleet.start({} as unknown as Parameters<typeof fleet.start>[0]);
    await launchChild(fleet, 'x', join(tmpDir, 'x1'));

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

  const idlesOf = (fleet: FleetModule, name: string) => () => fleet.getChildren().get(name)!.events
    .filter((e) => e.type === 'lifecycle' && (e as { phase?: string }).phase === 'idle').length;

  test('after a text to a child that has gone idle, waits for the idle that follows it', async () => {
    const fleet = makeFleet();
    await fleet.start({} as unknown as Parameters<typeof fleet.start>[0]);
    await launchChild(fleet, 'again', join(tmpDir, 'again'));
    const idles = idlesOf(fleet, 'again');
    await send(fleet, 'again', 'first');
    await waitFor(() => idles() === 1, 2_000, 'the first idle');

    await send(fleet, 'again', 'second');
    const res = await fleet.handleToolCall({ id: 'await-again', name: 'await', input: { names: ['again'], timeoutMs: 5_000 } });
    expect(res).toMatchObject({ success: true, data: { names: ['again'], completed: true } });
    expect(idles()).toBe(2);
    expect((res.data as { waitedMs: number }).waitedMs).toBeGreaterThan(0);

    await fleet.stop();
  }, 15_000);

  test('a start and an idle the child emitted before a text, read after it, don\'t answer for the text', async () => {
    const fleet = makeFleet();
    await fleet.start({} as unknown as Parameters<typeof fleet.start>[0]);
    await launchChild(fleet, 'stale', join(tmpDir, 'stale'));
    const idles = idlesOf(fleet, 'stale');
    await send(fleet, 'stale', 'first');
    await waitFor(() => idles() === 1, 2_000, 'the first idle');
    await send(fleet, 'stale', 'stale-start-and-idle-first');
    const res = await fleet.handleToolCall({ id: 'await-stale', name: 'await', input: { names: ['stale'], timeoutMs: 5_000 } });
    expect(res).toMatchObject({ success: true, data: { completed: true } });
    expect(idles()).toBe(3);

    await fleet.stop();
  }, 15_000);

  test('an await already waiting keeps a child it counted when the child is restarted meanwhile', async () => {
    const fleet = makeFleet();
    await fleet.start({} as unknown as Parameters<typeof fleet.start>[0]);
    await launchChild(fleet, 'again2', join(tmpDir, 'again2'));
    await launchChild(fleet, 'later', join(tmpDir, 'later'));
    await send(fleet, 'again2', 'first');
    await waitFor(() => idlesOf(fleet, 'again2')() === 1, 2_000, 'again2 idle');
    const later = heldUntilReleased('later');
    await send(fleet, 'later', later.text);
    const waiting = fleet.handleToolCall({ id: 'await-restarted', name: 'await', input: { names: ['again2', 'later'], timeoutMs: 20_000 } });
    const restarted = await fleet.handleToolCall({ id: 'restart-again2', name: 'restart', input: { name: 'again2' } });
    expect(restarted.success).toBe(true);
    later.release();
    const res = await waiting;
    expect(res).toMatchObject({ success: true, data: { completed: true } });
    expect(idlesOf(fleet, 'later')()).toBe(1);

    await fleet.stop();
  }, 30_000);

  test('an await already waiting drops a restarted child once this host sends the new one work', async () => {
    const fleet = makeFleet();
    await fleet.start({} as unknown as Parameters<typeof fleet.start>[0]);
    await launchChild(fleet, 'renewed', join(tmpDir, 'renewed'));
    await launchChild(fleet, 'other', join(tmpDir, 'other'));
    await send(fleet, 'renewed', 'first');
    await waitFor(() => idlesOf(fleet, 'renewed')() === 1, 2_000, 'renewed idle');
    const other = heldUntilReleased('other');
    const renewedWork = heldUntilReleased('renewed');
    await send(fleet, 'other', other.text);
    const waiting = fleet.handleToolCall({ id: 'await-renewed', name: 'await', input: { names: ['renewed', 'other'], timeoutMs: 20_000 } });
    const settled = settledFlag(waiting);
    const restarted = await fleet.handleToolCall({ id: 'restart-renewed', name: 'restart', input: { name: 'renewed' } });
    expect(restarted.success).toBe(true);
    await send(fleet, 'renewed', renewedWork.text);
    other.release();
    await waitFor(() => idlesOf(fleet, 'other')() === 1, 3_000, 'other idle');
    expect(settled()).toBe(false);
    renewedWork.release();
    const res = await waiting;
    expect(res).toMatchObject({ success: true, data: { completed: true } });
    expect(idlesOf(fleet, 'renewed')()).toBe(1);

    await fleet.stop();
  }, 30_000);

  test('an idle from an older child, which says nothing of the texts it covers, counts as on main', async () => {
    const fleet = makeFleet();
    await fleet.start({} as unknown as Parameters<typeof fleet.start>[0]);
    await launchChild(fleet, 'older', join(tmpDir, 'older'));
    await send(fleet, 'older', 'no-texts');
    const res = await fleet.handleToolCall({ id: 'await-older', name: 'await', input: { names: ['older'], timeoutMs: 3_000 } });
    expect(res).toMatchObject({ success: true, data: { names: ['older'], completed: true } });

    await fleet.stop();
  }, 15_000);

  test('an await already waiting counts a child that went idle and then exited, as its work had finished', async () => {
    const fleet = makeFleet();
    await fleet.start({} as unknown as Parameters<typeof fleet.start>[0]);
    await launchChild(fleet, 'gone', join(tmpDir, 'gone'));
    await launchChild(fleet, 'busy', join(tmpDir, 'busy'));
    const busy = heldUntilReleased('busy');
    await send(fleet, 'busy', busy.text);
    const waiting = fleet.handleToolCall({ id: 'await-gone', name: 'await', input: { names: ['gone', 'busy'], timeoutMs: 8_000 } });
    await command(fleet, 'gone', '/exit-after-idle');
    await waitFor(() => fleet.getChildren().get('gone')!.status === 'exited', 3_000, 'gone exited');
    busy.release();
    const res = await waiting;
    expect(res).toMatchObject({ success: true, data: { completed: true } });
    expect(idlesOf(fleet, 'busy')()).toBe(1);

    await fleet.stop();
  }, 20_000);

  test('a child that goes idle and then starts a turn of its own, with no text from this host, is waited for', async () => {
    const fleet = makeFleet();
    await fleet.start({} as unknown as Parameters<typeof fleet.start>[0]);
    await launchChild(fleet, 'own', join(tmpDir, 'own'));
    const idles = idlesOf(fleet, 'own');
    const starts = () => fleet.getChildren().get('own')!.events.filter((e) => e.type === 'inference:started').length;
    await send(fleet, 'own', 'first');
    await waitFor(() => idles() === 1, 2_000, 'the first idle');

    await command(fleet, 'own', '/turn-later');
    await waitFor(() => starts() === 2, 2_000, 'its own turn\'s start');
    const res = await fleet.handleToolCall({ id: 'await-own', name: 'await', input: { names: ['own'], timeoutMs: 5_000 } });
    expect(res).toMatchObject({ success: true, data: { completed: true } });
    expect(idles()).toBe(2);
    expect((res.data as { waitedMs: number }).waitedMs).toBeGreaterThan(0);

    await fleet.stop();
  }, 15_000);

  test('an await already waiting drops a child it counted as idle once that child is sent work again', async () => {
    const fleet = makeFleet();
    await fleet.start({} as unknown as Parameters<typeof fleet.start>[0]);
    await launchChild(fleet, 'left', join(tmpDir, 'left'));
    await launchChild(fleet, 'right', join(tmpDir, 'right'));
    const leftIdles = idlesOf(fleet, 'left');
    await send(fleet, 'left', 'first');
    await waitFor(() => leftIdles() === 1, 2_000, 'left idle');

    const right = heldUntilReleased('right');
    const leftWork = heldUntilReleased('left');
    await send(fleet, 'right', right.text);
    const waiting = fleet.handleToolCall({ id: 'await-both', name: 'await', input: { names: ['left', 'right'], timeoutMs: 8_000 } });
    const settled = settledFlag(waiting);
    await send(fleet, 'left', leftWork.text);
    right.release();
    await waitFor(() => idlesOf(fleet, 'right')() === 1, 3_000, 'right idle');
    expect(settled()).toBe(false);
    leftWork.release();
    const res = await waiting;
    expect(res).toMatchObject({ success: true, data: { completed: true } });
    expect(leftIdles()).toBe(2);

    await fleet.stop();
  }, 20_000);

  test('after a command that starts no turn, a child that has gone idle still counts as idle at once', async () => {
    const fleet = makeFleet();
    await fleet.start({} as unknown as Parameters<typeof fleet.start>[0]);
    await launchChild(fleet, 'asked', join(tmpDir, 'asked'));
    await send(fleet, 'asked', 'first');
    await waitFor(() => idlesOf(fleet, 'asked')() === 1, 2_000, 'the first idle');

    await command(fleet, 'asked', '/help');
    await waitFor(
      () => fleet.getChildren().get('asked')!.events.some((e) => e.type === 'command-output'),
      2_000,
      'the command\'s output',
    );
    const res = await fleet.handleToolCall({ id: 'await-asked', name: 'await', input: { names: ['asked'], timeoutMs: 1_000 } });
    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({ names: ['asked'], waitedMs: 0, completed: true });

    await fleet.stop();
  }, 15_000);

  test('a child adopted by a new host after it had gone idle counts as idle at once', async () => {
    let state: unknown = null;
    const context = {
      getState: () => state,
      setState: (next: unknown) => { state = structuredClone(next); },
    } as unknown as Parameters<FleetModule['start']>[0];
    const first = makeFleet();
    await first.start(context);
    await launchChild(first, 'kept', join(tmpDir, 'kept'));
    await send(first, 'kept', 'first');
    await waitFor(() => idlesOf(first, 'kept')() === 1, 2_000, 'the first idle');
    const pid = first.getChildren().get('kept')!.pid!;
    first.setDetachMode(true);
    await first.stop();
    first.getChildren().get('kept')!.process?.removeAllListeners('exit');

    const second = makeFleet({ autoStart: [{ name: 'kept', recipe: 'mock-recipe', dataDir: join(tmpDir, 'kept'), autoStart: false }] });
    try {
      await second.start(context);
      expect(second.getChildren().get('kept')).toMatchObject({ pid, status: 'ready', process: null });
      const res = await second.handleToolCall({ id: 'await-kept', name: 'await', input: { names: ['kept'], timeoutMs: 1_000 } });
      expect(res).toMatchObject({ success: true, data: { names: ['kept'], waitedMs: 0, completed: true } });
    } finally {
      await second.stop();
      try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    }
  }, 20_000);

  test('a child that said idle after a turn of its own before this host connected counts as idle at once, though its boot replay shows that turn', async () => {
    const fleet = makeFleet({
      autoStart: [{ name: 'booted', recipe: 'mock-recipe', dataDir: join(tmpDir, 'booted'), env: { MOCK_BOOT_TURN: '1' }, autoStart: true }],
    });
    await fleet.start({} as unknown as Parameters<typeof fleet.start>[0]);
    fleet.launchAutoStart();
    try {
      await waitFor(
        () => fleet.getChildren().get('booted')?.events.some((e) => e.type === 'inference:completed') ?? false,
        5_000,
        'the boot replay',
      );
      const res = await fleet.handleToolCall({ id: 'await-booted', name: 'await', input: { names: ['booted'], timeoutMs: 1_000 } });
      expect(res).toMatchObject({ success: true, data: { names: ['booted'], waitedMs: 0, completed: true } });
    } finally {
      await fleet.stop();
    }
  }, 15_000);

  test('blocks until all named children emit idle', async () => {
    const fleet = makeFleet();
    await fleet.start({} as unknown as Parameters<typeof fleet.start>[0]);
    await launchChild(fleet, 'p', join(tmpDir, 'p'));
    await launchChild(fleet, 'q', join(tmpDir, 'q'));

    const awaitPromise = (async () => {
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

  test('a timeout\'s report doesn\'t name as idle a child this host sent work after the await last read it', async () => {
    const fleet = makeFleet();
    await fleet.start({} as unknown as Parameters<typeof fleet.start>[0]);
    await launchChild(fleet, 'quick', join(tmpDir, 'quick'));
    await launchChild(fleet, 'slow', join(tmpDir, 'slow'));
    await send(fleet, 'quick', 'first');
    await waitFor(() => idlesOf(fleet, 'quick')() === 1, 2_000, 'quick idle');
    await send(fleet, 'slow', heldUntilReleased('slow').text);
    await waitFor(() => fleet.getChildren().get('slow')!.events.some((e) => e.type === 'inference:started'), 2_000, 'slow started');
    const waiting = fleet.handleToolCall({ id: 'await-report', name: 'await', input: { names: ['quick', 'slow'], timeoutMs: 100 } });
    await send(fleet, 'quick', 'late:2000 again');
    const res = await waiting;
    expect(res.success).toBe(false);
    expect(res.error).toContain('Idle: none');
    expect(res.error).toContain("Not yet idle: 'quick', 'slow'");

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
    expect(empty.error).toContain('a list of one or more child names; it got an empty list');

    const unknown = await fleet.handleToolCall({
      id: 'await-unk', name: 'await', input: { names: ['ghost'] },
    });
    expect(unknown.success).toBe(false);
    expect(unknown.error).toStartWith("There's no child named 'ghost', so nothing was waited on.");

    await fleet.stop();
  });
});
