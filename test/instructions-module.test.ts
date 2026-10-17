import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { WorkspaceModule, WorkspaceReadError, type ModuleContext } from '@animalabs/agent-framework';
import {
  DEFAULT_INSTRUCTIONS_HEADER,
  DEFAULT_INSTRUCTIONS_PATH,
  InstructionsModule,
  type WorkspaceDiskReader,
} from '../src/modules/instructions-module.js';

type Alert = { kind: string; agent: string; message: string };

/** A module context that records the ops alerts raised through it, called
 *  through the context object, as the real ModuleContext needs. */
function contextFor(alerts: Alert[]): ModuleContext {
  const context = {
    notifyOps(this: unknown, kind: string, agent: string, message: string) {
      expect(this).toBe(context);
      alerts.push({ kind, agent, message });
    },
  } as unknown as ModuleContext;
  return context;
}

/** A reader whose reads the test settles, each call kept in order. */
function settledByTest() {
  const calls: Array<{ resolve: (read: { bytes: Buffer; size: number; truncated: boolean }) => void; reject: (error: unknown) => void }> = [];
  const reader: WorkspaceDiskReader = {
    readFileFromDisk: () => new Promise((resolve, reject) => { calls.push({ resolve, reject }); }),
  };
  return { reader, calls };
}

const readOf = (text: string) => ({ bytes: Buffer.from(text), size: Buffer.byteLength(text), truncated: false });
const missing = () => new WorkspaceReadError('not_found', 'File not found: instructions/AGENTS.md', 'lstat', 'ENOENT');
/** Lets every settled read's callbacks run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The registry's budget lowered to 400 ms, so a read's own budget is 300 ms. */
class QuickInstructionsModule extends InstructionsModule {
  override readonly contextTimeoutMs = 400;
}

/**
 * The module reads through agent-framework's own WorkspaceModule here, on a
 * real mount, as production wires it. Every link these tests make leads to a
 * file inside the same mount; a read refused as leading outside a mount is
 * stood in for (agent-framework's own tests cover that read), and so is a
 * read whose timing a test needs to settle.
 */
describe('InstructionsModule', () => {
  let dir: string;
  let storeDir: string;
  let stores: Array<{ close?: () => void }>;
  let warnSpy: ReturnType<typeof spyOn>;
  let alerts: Alert[];
  let ctx: ModuleContext;

  /** A WorkspaceModule with one mount named `mountName` over the test's directory. */
  function workspaceOver(mountName: string): WorkspaceModule {
    const store = JsStore.openOrCreate({ path: join(storeDir, `store-${stores.length}`) });
    stores.push(store as { close?: () => void });
    const workspace = new WorkspaceModule({ mounts: [{ name: mountName, path: dir, mode: 'read-only', watch: 'never' }] });
    workspace.initStore(store);
    return workspace;
  }

  /** A module started on the test's context, reading through `workspace`. */
  async function moduleOver(workspace: WorkspaceDiskReader | null, config = {}): Promise<InstructionsModule> {
    const mod = new InstructionsModule({ agentName: 'resident', ...config });
    await mod.start(ctx);
    if (workspace) mod.setWorkspace(workspace);
    return mod;
  }

  const textOf = (injections: Awaited<ReturnType<InstructionsModule['gatherContext']>>) =>
    (injections[0]!.content[0] as { text: string }).text;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'instructions-module-'));
    storeDir = mkdtempSync(join(tmpdir(), 'instructions-store-'));
    stores = [];
    warnSpy = spyOn(console, 'error').mockImplementation(() => {});
    alerts = [];
    ctx = contextFor(alerts);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    for (const store of stores) store.close?.();
    rmSync(dir, { recursive: true, force: true });
    rmSync(storeDir, { recursive: true, force: true });
  });

  test('injects file content under the default header at the default path', async () => {
    writeFileSync(join(dir, 'AGENTS.md'), 'Always be excellent.\n');
    const mod = await moduleOver(workspaceOver('instructions'));

    const injections = await mod.gatherContext('resident');
    expect(injections).toHaveLength(1);
    expect(injections[0]!.namespace).toBe('instructions');
    expect(injections[0]!.position).toBe('system');
    expect(injections[0]!.content).toEqual([{
      type: 'text',
      text: `${DEFAULT_INSTRUCTIONS_HEADER}\n\nAlways be excellent.\n`,
    }]);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(alerts).toEqual([]);
  });

  test('exposes the shared-contract defaults', () => {
    expect(DEFAULT_INSTRUCTIONS_PATH).toBe('instructions/AGENTS.md');
    expect(new InstructionsModule({ agentName: 'resident' }).contextTimeoutMs).toBe(2000);
  });

  test('honors custom path, header, and position', async () => {
    writeFileSync(join(dir, 'HOUSE-RULES.md'), 'No shouting.');
    const mod = await moduleOver(workspaceOver('shared'), {
      path: 'shared/HOUSE-RULES.md',
      header: '## House rules',
      position: 'afterUser',
    });

    const injections = await mod.gatherContext('ephemeral-worker-1');
    expect(injections).toHaveLength(1);
    expect(injections[0]!.position).toBe('afterUser');
    expect(injections[0]!.content).toEqual([{ type: 'text', text: '## House rules\n\nNo shouting.' }]);
  });

  test('supports position beforeUser', async () => {
    writeFileSync(join(dir, 'AGENTS.md'), 'x');
    const mod = await moduleOver(workspaceOver('instructions'), { position: 'beforeUser' });
    expect((await mod.gatherContext('a'))[0]!.position).toBe('beforeUser');
  });

  test('returns the same injection for every agent name', async () => {
    writeFileSync(join(dir, 'AGENTS.md'), 'shared doc');
    const mod = await moduleOver(workspaceOver('instructions'));

    const forResident = await mod.gatherContext('resident');
    const forEphemeral = await mod.gatherContext('resident_fork_3');
    expect(forEphemeral).toEqual(forResident);
  });

  test('a missing file fails open with one warning and one alert across turns and agents', async () => {
    const mod = await moduleOver(workspaceOver('instructions'));

    expect(await mod.gatherContext('resident')).toEqual([]);
    expect(await mod.gatherContext('resident_fork_3')).toEqual([]);
    expect(await mod.gatherContext('resident')).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(alerts).toEqual([{
      kind: 'instructions-unavailable',
      agent: 'resident',
      message: 'no instructions injected: File not found: instructions/AGENTS.md',
    }]);
  });

  test('an unknown mount fails open with one warning and one alert', async () => {
    const mod = await moduleOver(workspaceOver('instructions'), { path: 'nonexistent/AGENTS.md' });

    expect(await mod.gatherContext('a')).toEqual([]);
    expect(await mod.gatherContext('a')).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.message).toContain('Unknown mount');
  });

  test('no workspace wired fails open, and says so', async () => {
    const mod = await moduleOver(null);
    expect(await mod.gatherContext('a')).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(alerts).toEqual([{
      kind: 'instructions-unavailable',
      agent: 'resident',
      message: 'no instructions injected: the workspace module isn\'t wired, so no instructions can be read',
    }]);
  });

  test('recovers (and injects) once the file appears, standing the alert down once', async () => {
    const mod = await moduleOver(workspaceOver('instructions'));

    expect(await mod.gatherContext('a')).toEqual([]);
    writeFileSync(join(dir, 'AGENTS.md'), 'now I exist');
    const injections = await mod.gatherContext('a');
    expect(injections).toHaveLength(1);
    expect(textOf(injections)).toContain('now I exist');
    await mod.gatherContext('b');
    expect(alerts.map((a) => a.kind)).toEqual(['instructions-unavailable', 'instructions-unavailable-clear']);
    expect(alerts[1]!.agent).toBe('resident');

    // A recurrence warns and alerts again.
    rmSync(join(dir, 'AGENTS.md'));
    expect(await mod.gatherContext('a')).toEqual([]);
    expect(alerts.map((a) => a.kind)).toEqual(['instructions-unavailable', 'instructions-unavailable-clear', 'instructions-unavailable']);
  });

  test('an edit reaches the next turn', async () => {
    const file = join(dir, 'AGENTS.md');
    writeFileSync(file, 'version one');
    const mod = await moduleOver(workspaceOver('instructions'));

    expect(textOf(await mod.gatherContext('a'))).toContain('version one');
    writeFileSync(file, 'version two, longer');
    expect(textOf(await mod.gatherContext('a'))).toContain('version two, longer');
    writeFileSync(file, 'version 3, longer!!');
    expect(textOf(await mod.gatherContext('a'))).toContain('version 3, longer!!');
  });

  test('truncates at maxBytes with an explicit marker', async () => {
    writeFileSync(join(dir, 'AGENTS.md'), 'a'.repeat(100));
    const mod = await moduleOver(workspaceOver('instructions'), { maxBytes: 10 });

    expect(textOf(await mod.gatherContext('a'))).toBe(`${DEFAULT_INSTRUCTIONS_HEADER}\n\n${'a'.repeat(10)}\n\n[truncated: first 10 of 100 bytes]`);
  });

  test('truncation never splits a multibyte character (no U+FFFD)', async () => {
    // '€' is 3 bytes in UTF-8; maxBytes: 4 keeps one full '€' plus the lead
    // byte of the second. The incomplete sequence must be dropped and the
    // marker report the actual kept byte count.
    writeFileSync(join(dir, 'AGENTS.md'), '€€€€');
    const mod = await moduleOver(workspaceOver('instructions'), { maxBytes: 4 });

    const text = textOf(await mod.gatherContext('a'));
    expect(text).toBe(`${DEFAULT_INSTRUCTIONS_HEADER}\n\n€\n\n[truncated: first 3 of 12 bytes]`);
    expect(text).not.toContain('�');
  });

  test('a multibyte character ending exactly at the cap survives', async () => {
    // '€€' is 6 bytes; maxBytes: 3 keeps exactly one complete '€' — the
    // boundary backup must not chop a sequence that finished at the cap.
    writeFileSync(join(dir, 'AGENTS.md'), '€€');
    const mod = await moduleOver(workspaceOver('instructions'), { maxBytes: 3 });

    const text = textOf(await mod.gatherContext('a'));
    expect(text).toBe(`${DEFAULT_INSTRUCTIONS_HEADER}\n\n€\n\n[truncated: first 3 of 6 bytes]`);
    expect(text).not.toContain('�');
  });

  test('truncation never splits a 2-byte or a 4-byte character either', async () => {
    // 'é' is 2 bytes and '😀' is 4: each cap keeps one whole character and
    // the start of the next, which the backup drops.
    writeFileSync(join(dir, 'AGENTS.md'), 'éé');
    const twoByte = textOf(await (await moduleOver(workspaceOver('instructions'), { maxBytes: 3 })).gatherContext('a'));
    expect(twoByte).toBe(`${DEFAULT_INSTRUCTIONS_HEADER}\n\né\n\n[truncated: first 2 of 4 bytes]`);

    writeFileSync(join(dir, 'AGENTS.md'), '😀😀');
    const fourByte = textOf(await (await moduleOver(workspaceOver('instructions'), { maxBytes: 6 })).gatherContext('a'));
    expect(fourByte).toBe(`${DEFAULT_INSTRUCTIONS_HEADER}\n\n😀\n\n[truncated: first 4 of 8 bytes]`);
  });

  test('does not truncate a file exactly at maxBytes', async () => {
    writeFileSync(join(dir, 'AGENTS.md'), 'a'.repeat(10));
    const mod = await moduleOver(workspaceOver('instructions'), { maxBytes: 10 });

    expect(textOf(await mod.gatherContext('a'))).toBe(`${DEFAULT_INSTRUCTIONS_HEADER}\n\n${'a'.repeat(10)}`);
  });

  test('cuts at maxBytes a read that gave more, as for a file that grew while it was read', async () => {
    // agent-framework 0.22.1 reads to its end a file that was within maxBytes
    // when the read took its size and grew while it was read.
    const grown = { bytes: Buffer.from('€'.repeat(10)), size: 5, truncated: false };
    const asked: Array<{ maxBytes: number }> = [];
    const mod = await moduleOver({ readFileFromDisk: async (_path, options) => { asked.push(options); return grown; } }, { maxBytes: 7 });

    const text = textOf(await mod.gatherContext('a'));
    expect(text).toBe(`${DEFAULT_INSTRUCTIONS_HEADER}\n\n€€\n\n[truncated: first 6 of 30 bytes]`);
    // The read itself is still asked for no more than the cap.
    expect(asked).toEqual([{ maxBytes: 7 }]);
  });

  test('reads at most maxBytes from an oversized file', async () => {
    // Only the first maxBytes influence the injection, whatever the file's
    // size: the read asks for no more.
    const big = 'begin-' + 'x'.repeat(512 * 1024) + '-end';
    writeFileSync(join(dir, 'AGENTS.md'), big);
    const mod = await moduleOver(workspaceOver('instructions'), { maxBytes: 1000 });

    const text = textOf(await mod.gatherContext('a'));
    expect(text).toBe(
      `${DEFAULT_INSTRUCTIONS_HEADER}\n\n${big.slice(0, 1000)}\n\n[truncated: first 1000 of ${big.length} bytes]`,
    );
    expect(text).not.toContain('-end');
  });

  // A recipe's mounts don't follow links, so a file that is itself a link is
  // refused even when it names another file in the same mount.
  test('a file that is itself a link injects nothing, and the alert names the remedy', async () => {
    writeFileSync(join(dir, 'real.md'), 'legit content');
    symlinkSync('real.md', join(dir, 'AGENTS.md'));
    const mod = await moduleOver(workspaceOver('instructions'));

    expect(await mod.gatherContext('a')).toEqual([]);
    expect(alerts).toEqual([{
      kind: 'instructions-unavailable',
      agent: 'resident',
      message: 'no instructions injected: "instructions/AGENTS.md" is a link, which its mount doesn\'t follow: put the file itself at that path',
    }]);
  });

  test('a read refused as leading outside its mount injects nothing, and the alert names the remedy', async () => {
    const refusing: WorkspaceDiskReader = {
      readFileFromDisk: async () => {
        throw new WorkspaceReadError('escape', 'Symlink escape detected: instructions/AGENTS.md', 'realpath');
      },
    };
    const mod = await moduleOver(refusing);

    expect(await mod.gatherContext('a')).toEqual([]);
    expect(alerts[0]!.message).toBe(
      'no instructions injected: "instructions/AGENTS.md" leads outside its mount through a link, the file itself or a ' +
      'directory on its path: move the file into the mount, so that neither it nor a directory on its path is a link ' +
      'that leads out',
    );
  });

  test('a file reached through a linked directory inside the mount is read', async () => {
    // agent-framework refuses a file that is itself a link, and one whose
    // canonical path leaves the mount; a linked directory is followed while
    // what it leads to stays inside the mount.
    mkdirSync(join(dir, 'v2'));
    writeFileSync(join(dir, 'v2', 'AGENTS.md'), 'the second version');
    symlinkSync('v2', join(dir, 'current'));
    const mod = await moduleOver(workspaceOver('instructions'), { path: 'instructions/current/AGENTS.md' });

    expect(textOf(await mod.gatherContext('a'))).toContain('the second version');
    expect(alerts).toEqual([]);
  });

  test('each distinct reason in one loss raises its own alert, once', async () => {
    const mod = await moduleOver(workspaceOver('instructions'));
    expect(await mod.gatherContext('a')).toEqual([]);
    writeFileSync(join(dir, 'real.md'), 'legit content');
    symlinkSync('real.md', join(dir, 'AGENTS.md'));
    expect(await mod.gatherContext('a')).toEqual([]);
    rmSync(join(dir, 'AGENTS.md'));
    expect(await mod.gatherContext('a')).toEqual([]);

    expect(alerts.map((a) => a.message)).toEqual([
      'no instructions injected: File not found: instructions/AGENTS.md',
      'no instructions injected: "instructions/AGENTS.md" is a link, which its mount doesn\'t follow: put the file itself at that path',
    ]);
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  test('a read past its budget injects nothing and raises the alert, and turns while it hangs start no other read', async () => {
    const { reader, calls } = settledByTest();
    const mod = new QuickInstructionsModule({ agentName: 'resident' });
    await mod.start(ctx);
    mod.setWorkspace(reader);

    // Two turns while the read is pending share it, and both give up at its deadline.
    expect(await Promise.all([mod.gatherContext('resident'), mod.gatherContext('resident_fork_3')])).toEqual([[], []]);
    expect(calls).toHaveLength(1);
    expect(alerts).toEqual([{
      kind: 'instructions-unavailable',
      agent: 'resident',
      message: 'no instructions injected: reading "instructions/AGENTS.md" hasn\'t finished after 0.3 s, and no other ' +
        'read starts until it finishes, the session is switched or the host restarts',
    }]);

    // A turn after the deadline injects nothing at once, rather than waiting on the read again.
    const late = mod.gatherContext('resident');
    const first = await Promise.race([late.then(() => 'returned'), new Promise((resolve) => setTimeout(() => resolve('waited'), 100))]);
    expect(first).toBe('returned');
    expect(await late).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(alerts).toHaveLength(1);

    // Once the read settles, the next turn reads again, and its file stands the alert down.
    calls[0]!.resolve(readOf('the late read'));
    await settle();
    const next = mod.gatherContext('resident');
    expect(calls).toHaveLength(2);
    calls[1]!.resolve(readOf('the next read'));
    expect(textOf(await next)).toContain('the next read');
    expect(alerts.map((a) => a.kind)).toEqual(['instructions-unavailable', 'instructions-unavailable-clear']);
  });

  test("a step in the wall clock moves no read's budget", async () => {
    const { reader, calls } = settledByTest();
    const mod = await moduleOver(reader);
    const first = mod.gatherContext('resident');
    // An hour forward on the wall clock while the read is pending: a turn
    // that joins it still has its budget, counted on the monotonic clock.
    setSystemTime(new Date(Date.now() + 60 * 60 * 1000));
    try {
      const joining = mod.gatherContext('resident');
      calls[0]!.resolve(readOf('on time'));
      expect(textOf(await first)).toContain('on time');
      expect(textOf(await joining)).toContain('on time');
      expect(calls).toHaveLength(1);
      expect(alerts).toEqual([]);
    } finally {
      setSystemTime();
    }
  });

  test('a stop with a read pending: the next session reads afresh, and the old read settling changes nothing', async () => {
    const { reader, calls } = settledByTest();
    const mod = await moduleOver(reader);
    // An alert is up, so a stale success would have one to stand down.
    const failing = mod.gatherContext('resident');
    calls[0]!.reject(missing());
    expect(await failing).toEqual([]);
    const stale = mod.gatherContext('resident');
    expect(calls).toHaveLength(2);

    await mod.stop();
    const nextAlerts: Alert[] = [];
    await mod.start(contextFor(nextAlerts));
    mod.setWorkspace(reader);
    const fresh = mod.gatherContext('resident');
    expect(calls).toHaveLength(3);

    calls[1]!.resolve(readOf("the old session's file"));
    expect(await stale).toEqual([]);
    expect(nextAlerts).toEqual([]);
    // The old read settling leaves the next session's read in place.
    const sharing = mod.gatherContext('resident_fork_3');
    expect(calls).toHaveLength(3);

    calls[2]!.reject(missing());
    expect(await fresh).toEqual([]);
    expect(await sharing).toEqual([]);
    expect(alerts.map((a) => a.kind)).toEqual(['instructions-unavailable']);
    expect(nextAlerts.map((a) => a.kind)).toEqual(['instructions-unavailable']);
  });

  test('an alert up at a session switch is raised again in the next session, and stood down there once the file loads', async () => {
    const mod = await moduleOver(workspaceOver('instructions'));
    expect(await mod.gatherContext('resident')).toEqual([]);

    // The host keeps the module across the switch; the next session gives
    // its own context and workspace.
    await mod.stop();
    const nextAlerts: Alert[] = [];
    await mod.start(contextFor(nextAlerts));
    mod.setWorkspace(workspaceOver('instructions'));
    expect(await mod.gatherContext('resident')).toEqual([]);
    writeFileSync(join(dir, 'AGENTS.md'), 'back again');
    expect(textOf(await mod.gatherContext('resident'))).toContain('back again');

    expect(alerts.map((a) => a.kind)).toEqual(['instructions-unavailable']);
    expect(nextAlerts.map((a) => a.kind)).toEqual(['instructions-unavailable', 'instructions-unavailable-clear']);
  });

  test("an alert up at a session switch is stood down by the next session's first read of the file", async () => {
    const mod = await moduleOver(workspaceOver('instructions'));
    expect(await mod.gatherContext('resident')).toEqual([]);

    await mod.stop();
    writeFileSync(join(dir, 'AGENTS.md'), 'fixed between sessions');
    const nextAlerts: Alert[] = [];
    await mod.start(contextFor(nextAlerts));
    mod.setWorkspace(workspaceOver('instructions'));
    expect(textOf(await mod.gatherContext('resident'))).toContain('fixed between sessions');

    expect(nextAlerts).toEqual([{
      kind: 'instructions-unavailable-clear',
      agent: 'resident',
      message: '"instructions/AGENTS.md" loaded again; agents have their instructions',
    }]);
  });

  test("a stop lets go of the session's workspace", async () => {
    writeFileSync(join(dir, 'AGENTS.md'), 'this session');
    const mod = await moduleOver(workspaceOver('instructions'));
    expect(textOf(await mod.gatherContext('resident'))).toContain('this session');

    await mod.stop();
    await mod.start(ctx);
    expect(await mod.gatherContext('resident')).toEqual([]);
    expect(alerts.at(-1)!.message).toBe("no instructions injected: the workspace module isn't wired, so no instructions can be read");
  });

  test("a turn that reaches the module while it isn't started injects nothing and changes nothing", async () => {
    const { reader, calls } = settledByTest();
    const mod = await moduleOver(reader);
    await mod.stop();
    // After the stop, and given the next session's workspace before its
    // start, as the host does: no read, no log line, no alert.
    expect(await mod.gatherContext('resident')).toEqual([]);
    mod.setWorkspace(reader);
    expect(await mod.gatherContext('resident')).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(alerts).toEqual([]);

    // Started, the session's first failing read raises its alert and its
    // first successful read stands it down: nothing those turns did is left
    // to swallow the one or bring on the other.
    const nextAlerts: Alert[] = [];
    await mod.start(contextFor(nextAlerts));
    const failing = mod.gatherContext('resident');
    calls[0]!.reject(missing());
    expect(await failing).toEqual([]);
    const loading = mod.gatherContext('resident');
    calls[1]!.resolve(readOf('loaded'));
    expect(textOf(await loading)).toContain('loaded');
    expect(nextAlerts.map((a) => a.kind)).toEqual(['instructions-unavailable', 'instructions-unavailable-clear']);
  });

  test("a read that fails after its session stopped raises nothing, and the next session's own failure still does", async () => {
    const { reader, calls } = settledByTest();
    const mod = await moduleOver(reader);
    const stale = mod.gatherContext('resident');
    expect(calls).toHaveLength(1);

    await mod.stop();
    const nextAlerts: Alert[] = [];
    mod.setWorkspace(reader);
    await mod.start(contextFor(nextAlerts));

    calls[0]!.reject(missing());
    expect(await stale).toEqual([]);
    expect(alerts).toEqual([]);
    expect(nextAlerts).toEqual([]);

    const own = mod.gatherContext('resident');
    calls[1]!.reject(missing());
    expect(await own).toEqual([]);
    expect(nextAlerts.map((a) => a.kind)).toEqual(['instructions-unavailable']);
  });

  // A stop can come once the read has settled and the module has let go of
  // it, before the turn waiting on it resumes. That turn belongs to the
  // ended session as much as one that resumes after the read.
  test('a stop between a read settling and its turn resuming leaves the turn without effect', async () => {
    const { reader, calls } = settledByTest();
    const mod = await moduleOver(reader);
    const stale = mod.gatherContext('resident');
    expect(calls).toHaveLength(1);
    // A reaction to the read's outcome after the module's own two, the one
    // that lets go of the read and the turn's: it runs once the read has
    // settled and before the turn resumes.
    const { outcome } = (mod as unknown as { pending: { outcome: Promise<unknown> } }).pending;
    const stopped = outcome.then(() => mod.stop());
    calls[0]!.reject(missing());
    await stopped;
    expect(await stale).toEqual([]);
    expect(alerts).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();

    // The next session's own failure, for the same reason, raises its alert.
    const nextAlerts: Alert[] = [];
    mod.setWorkspace(reader);
    await mod.start(contextFor(nextAlerts));
    const own = mod.gatherContext('resident');
    calls[1]!.reject(missing());
    expect(await own).toEqual([]);
    expect(nextAlerts.map((a) => a.kind)).toEqual(['instructions-unavailable']);
  });

  test('a read that runs past its budget after its session stopped raises nothing in the next session', async () => {
    const { reader, calls } = settledByTest();
    const mod = new QuickInstructionsModule({ agentName: 'resident' });
    await mod.start(ctx);
    mod.setWorkspace(reader);
    const stale = mod.gatherContext('resident');
    expect(calls).toHaveLength(1);

    await mod.stop();
    const nextAlerts: Alert[] = [];
    mod.setWorkspace(reader);
    await mod.start(contextFor(nextAlerts));

    // The old read's deadline passes in the next session.
    expect(await stale).toEqual([]);
    expect(alerts).toEqual([]);
    expect(nextAlerts).toEqual([]);
  });
});
