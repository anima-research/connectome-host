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

const PARENT_SYMLINK = 'parent_symlink' as WorkspaceReadError['code'];
const OTHER_MOUNT = 'other_mount' as WorkspaceReadError['code'];

type Alert = { kind: string; agent: string; message: string };

/** Called on the context object, as agent-framework's ModuleContext.notifyOps
 *  needs: it reads `this`. */
function contextFor(alerts: Alert[]): ModuleContext {
  const context = {
    notifyOps(this: unknown, kind: string, agent: string, message: string) {
      expect(this).toBe(context);
      alerts.push({ kind, agent, message });
    },
  } as unknown as ModuleContext;
  return context;
}

function settledByTest() {
  const calls: Array<{ resolve: (read: { bytes: Buffer; size: number; truncated: boolean }) => void; reject: (error: unknown) => void }> = [];
  const reader: WorkspaceDiskReader = {
    readFileFromDisk: () => new Promise((resolve, reject) => { calls.push({ resolve, reject }); }),
  };
  return { reader, calls };
}

const readOf = (text: string) => ({ bytes: Buffer.from(text), size: Buffer.byteLength(text), truncated: false });
const missing = () => new WorkspaceReadError('not_found', 'File not found: instructions/AGENTS.md', 'lstat', 'ENOENT');
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

class QuickInstructionsModule extends InstructionsModule {
  override readonly contextTimeoutMs = 400;
}

describe('InstructionsModule', () => {
  let dir: string;
  let storeDir: string;
  let stores: Array<{ close?: () => void }>;
  let warnSpy: ReturnType<typeof spyOn>;
  let alerts: Alert[];
  let ctx: ModuleContext;

  function workspaceOver(mountName: string, mount: { followSymlinks?: boolean } = {}): WorkspaceModule {
    const store = JsStore.openOrCreate({ path: join(storeDir, `store-${stores.length}`) });
    stores.push(store as { close?: () => void });
    const workspace = new WorkspaceModule({ mounts: [{ name: mountName, path: dir, mode: 'read-only', watch: 'never', ...mount }] });
    workspace.initStore(store);
    return workspace;
  }

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

  test('off system, the instructions are placed at each compile, not stored', async () => {
    writeFileSync(join(dir, 'AGENTS.md'), 'x');
    for (const position of ['beforeUser', 'afterUser'] as const) {
      const mod = await moduleOver(workspaceOver('instructions'), { position });
      const [injection] = await mod.gatherContext('a');
      expect((injection as { placedEachCompile?: unknown }).placedEachCompile).toBe(true);
    }
    const atSystem = await moduleOver(workspaceOver('instructions'));
    const [injection] = await atSystem.gatherContext('a');
    expect('placedEachCompile' in injection!).toBe(false);
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
    const workspace = workspaceOver('instructions');
    const mod = await moduleOver(workspace, { path: 'nonexistent/AGENTS.md' });

    expect(await mod.gatherContext('a')).toEqual([]);
    expect(await mod.gatherContext('a')).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const refused = await workspace.readFileFromDisk('nonexistent/AGENTS.md').then(
      () => { throw new Error('agent-framework read a path no mount holds'); },
      (err: WorkspaceReadError) => err,
    );
    expect(refused.code).toBe('unknown_mount');
    expect(alerts).toEqual([{
      kind: 'instructions-unavailable',
      agent: 'resident',
      message: `no instructions injected: ${refused.message}`,
    }]);
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
    // '€' is 3 bytes in UTF-8.
    writeFileSync(join(dir, 'AGENTS.md'), '€€€€');
    const mod = await moduleOver(workspaceOver('instructions'), { maxBytes: 4 });

    const text = textOf(await mod.gatherContext('a'));
    expect(text).toBe(`${DEFAULT_INSTRUCTIONS_HEADER}\n\n€\n\n[truncated: first 3 of 12 bytes]`);
    expect(text).not.toContain('�');
  });

  test('a multibyte character ending exactly at the cap survives', async () => {
    writeFileSync(join(dir, 'AGENTS.md'), '€€');
    const mod = await moduleOver(workspaceOver('instructions'), { maxBytes: 3 });

    const text = textOf(await mod.gatherContext('a'));
    expect(text).toBe(`${DEFAULT_INSTRUCTIONS_HEADER}\n\n€\n\n[truncated: first 3 of 6 bytes]`);
    expect(text).not.toContain('�');
  });

  test('truncation never splits a 2-byte or a 4-byte character either', async () => {
    // 'é' is 2 bytes in UTF-8 and '😀' is 4.
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

  test('reads at most maxBytes from an oversized file', async () => {
    const big = 'begin-' + 'x'.repeat(512 * 1024) + '-end';
    writeFileSync(join(dir, 'AGENTS.md'), big);
    const mod = await moduleOver(workspaceOver('instructions'), { maxBytes: 1000 });

    const text = textOf(await mod.gatherContext('a'));
    expect(text).toBe(
      `${DEFAULT_INSTRUCTIONS_HEADER}\n\n${big.slice(0, 1000)}\n\n[truncated: first 1000 of ${big.length} bytes]`,
    );
    expect(text).not.toContain('-end');
  });

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

  test('a file reached through a linked directory inside the mount is read as the mount reads it', async () => {
    mkdirSync(join(dir, 'v2'));
    writeFileSync(join(dir, 'v2', 'AGENTS.md'), 'the second version');
    symlinkSync('v2', join(dir, 'current'));
    const workspace = workspaceOver('instructions');
    const refused = await workspace.readFileFromDisk('instructions/current/AGENTS.md').then(
      () => null,
      (err: WorkspaceReadError) => err,
    );
    const mod = await moduleOver(workspace, { path: 'instructions/current/AGENTS.md' });

    if (refused === null) {
      expect(textOf(await mod.gatherContext('a'))).toContain('the second version');
      expect(alerts).toEqual([]);
    } else {
      expect(refused.code).toBe(PARENT_SYMLINK);
      expect(await mod.gatherContext('a')).toEqual([]);
      expect(alerts.map((a) => a.message)).toEqual([`no instructions injected: ${refused.message}`]);
    }
  });

  test('a mount that follows links reads a file through a linked directory', async () => {
    mkdirSync(join(dir, 'v2'));
    writeFileSync(join(dir, 'v2', 'AGENTS.md'), 'the second version');
    symlinkSync('v2', join(dir, 'current'));
    const mod = await moduleOver(workspaceOver('instructions', { followSymlinks: true }), { path: 'instructions/current/AGENTS.md' });

    expect(textOf(await mod.gatherContext('a'))).toContain('the second version');
    expect(alerts).toEqual([]);
  });

  test("a link among the path's directories is reported in the read's own words", async () => {
    const message = 'instructions/current/AGENTS.md: "instructions/current" is a symlink to "instructions/v2", which this ' +
      'mount does not follow; the mount\'s host can set followSymlinks: true';
    const mod = await moduleOver(
      { readFileFromDisk: async () => { throw new WorkspaceReadError(PARENT_SYMLINK, message, 'readlink'); } },
      { path: 'instructions/current/AGENTS.md' },
    );

    expect(await mod.gatherContext('a')).toEqual([]);
    expect(alerts.map((a) => a.message)).toEqual([`no instructions injected: ${message}`]);
  });

  test("a path in a nested mount's directory is reported in the read's own words, which name the path to use", async () => {
    const message = '"instructions/inner/AGENTS.md" lies in mount "inner", nested in mount "instructions", which neither ' +
      'reads nor writes it: use "inner/AGENTS.md".';
    const mod = await moduleOver(
      { readFileFromDisk: async () => { throw new WorkspaceReadError(OTHER_MOUNT, message, 'parse'); } },
      { path: 'instructions/inner/AGENTS.md' },
    );

    expect(await mod.gatherContext('a')).toEqual([]);
    expect(alerts.map((a) => a.message)).toEqual([`no instructions injected: ${message}`]);
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

    expect(await Promise.all([mod.gatherContext('resident'), mod.gatherContext('resident_fork_3')])).toEqual([[], []]);
    expect(calls).toHaveLength(1);
    expect(alerts).toEqual([{
      kind: 'instructions-unavailable',
      agent: 'resident',
      message: 'no instructions injected: reading "instructions/AGENTS.md" hasn\'t finished after 0.3 s, and no other ' +
        'read starts until it finishes, the session is switched or the host restarts',
    }]);

    const late = mod.gatherContext('resident');
    const first = await Promise.race([late.then(() => 'returned'), new Promise((resolve) => setTimeout(() => resolve('waited'), 100))]);
    expect(first).toBe('returned');
    expect(await late).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(alerts).toHaveLength(1);

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
    expect(await mod.gatherContext('resident')).toEqual([]);
    mod.setWorkspace(reader);
    expect(await mod.gatherContext('resident')).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(alerts).toEqual([]);

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

  test('a stop between a read settling and its turn resuming leaves the turn without effect', async () => {
    const { reader, calls } = settledByTest();
    const mod = await moduleOver(reader);
    const stale = mod.gatherContext('resident');
    expect(calls).toHaveLength(1);
    const { outcome } = (mod as unknown as { pending: { outcome: Promise<unknown> } }).pending;
    const stopOnceTheModuleHasReacted = outcome.then(() => mod.stop());
    calls[0]!.reject(missing());
    await stopOnceTheModuleHasReacted;
    expect(await stale).toEqual([]);
    expect(alerts).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();

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

    expect(await stale).toEqual([]);
    expect(alerts).toEqual([]);
    expect(nextAlerts).toEqual([]);
  });
});
