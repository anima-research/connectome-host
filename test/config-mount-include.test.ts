import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { EventGate, WorkspaceModule } from '@animalabs/agent-framework';
import type { MountConfig } from '@animalabs/agent-framework';
import { buildWorkspaceMounts } from '../src/workspace-mounts.js';

const LEFT_OUT = ['#gate.json#', '.gate.json.swp', '.gate.json.swo', 'gate.json~', 'gate.json.unreadable-1', 'notes.txt'];

type Event = { type: string; paths?: string[]; mount?: string };

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function configMount(storePath: string): MountConfig {
  const mounts = buildWorkspaceMounts({ mounts: [{ name: 'products', path: join(storePath, 'out') }], configMount: true }, storePath)!;
  return mounts.find((m) => m.name === '_config')!;
}

async function started(dir: string, mount: MountConfig, store?: ReturnType<typeof JsStore.openOrCreate>) {
  const own = store ?? JsStore.openOrCreate({ path: join(dir, 'store.chronicle') });
  const events: Event[] = [];
  const listeners: Array<() => void> = [];
  const workspace = new WorkspaceModule({ mounts: [mount] });
  workspace.initStore(own);
  await workspace.start({
    isRestart: false, getState: () => null, setState: () => {},
    pushEvent: (event: Event) => { events.push(event); for (const l of listeners) l(); },
  } as never);
  const stop = async () => { await workspace.stop().catch(() => {}); if (!store) own.close?.(); };
  cleanups.push(stop);
  const eventNaming = (path: string) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no event named ${path}: ${JSON.stringify(events)}`)), 20_000);
    const check = () => { if (events.some((e) => e.paths?.includes(path))) { clearTimeout(timer); resolve(); } };
    listeners.push(check);
    check();
  });
  const call = async (name: string, input: Record<string, unknown>) => workspace.handleToolCall({ id: 't', name, input } as never);
  return { workspace, store: own, events, eventNaming, call, stop };
}

function setUp() {
  const root = mkdtempSync(join(tmpdir(), 'config-include-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const storePath = join(root, 'session');
  const cfg = join(storePath, 'config');
  mkdirSync(cfg, { recursive: true });
  return { root, storePath, cfg };
}

describe("the _config mount's include", () => {
  test('a sync takes in the files named gate.json, gate.js or gate.recipe.json and passes over what lies beside them', async () => {
    const { root, storePath, cfg } = setUp();
    writeFileSync(join(cfg, 'gate.json'), '{}\n');
    writeFileSync(join(cfg, 'gate.js'), 'export default () => true;\n');
    writeFileSync(join(cfg, 'gate.recipe.json'), '{}\n');
    for (const name of LEFT_OUT) writeFileSync(join(cfg, name), `${name}\n`);
    mkdirSync(join(cfg, 'old'));
    writeFileSync(join(cfg, 'old', 'gate.json'), '{}\n');
    writeFileSync(join(cfg, 'old', 'notes.txt'), 'old notes\n');
    const { call } = await started(root, configMount(storePath));
    const synced = (await call('sync', {})).data as { results: Array<{ synced: string[] }> };
    expect(synced.results.flatMap((r) => r.synced).sort()).toEqual(['gate.js', 'gate.json', 'gate.recipe.json', 'old/gate.json']);
    const listed = (await call('ls', { path: '_config' })).data as { entries: Array<{ name: string }> };
    expect(listed.entries.map((e) => e.name).sort()).toEqual(['gate.js', 'gate.json', 'gate.recipe.json', 'old']);
  }, 30_000);

  test('a sync takes in every file the gate leaves in the config directory on the starts the host makes: with the recipe\'s wake rules, with them changed, and with none', async () => {
    const { root, storePath, cfg } = setUp();
    const recipeWake = (names: string[]) => ({
      policies: names.map((name) => ({ name, match: { scope: ['external-message'] }, behavior: 'always' })),
    });
    for (const names of [['a', 'b'], ['a', 'c'], undefined]) {
      new EventGate({
        configPath: join(cfg, 'gate.json'), ...(names ? { initialConfig: recipeWake(names) as never } : {}),
        emitTrace: () => {}, addMessage: () => '', requestInference: () => {}, getAgentNames: () => ['agent'],
      });
    }
    const left = (readdirSync(cfg, { recursive: true, withFileTypes: true }) as Array<{ isFile(): boolean; name: string; parentPath?: string; path?: string }>)
      .filter((e) => e.isFile())
      .map((e) => relative(cfg, join(e.parentPath ?? e.path ?? cfg, e.name)))
      .sort();
    expect(left).toContain('gate.json');
    const { call } = await started(root, configMount(storePath));
    const synced = (await call('sync', {})).data as { results: Array<{ synced: string[] }> };
    expect(synced.results.flatMap((r) => r.synced).sort()).toEqual(left);
  }, 30_000);

  test("the watcher takes in a new gate.js and nothing written beside it", async () => {
    const { root, storePath, cfg } = setUp();
    // The watcher ignores what's there when it starts: the event that takes
    // gate.json in comes from the catch-up pass it runs once it's ready.
    writeFileSync(join(cfg, 'gate.json'), '{}\n');
    const { events, eventNaming } = await started(root, configMount(storePath));
    await eventNaming('_config/gate.json');
    // The watcher doesn't promise the order it reports writes in, so once gate.js
    // arrives the test waits past another batch: the 300 ms debounce after
    // awaitWriteFinish's 100 ms.
    for (const name of LEFT_OUT) writeFileSync(join(cfg, name), `${name}\n`);
    writeFileSync(join(cfg, 'gate.js'), 'export default () => true;\n');
    await eventNaming('_config/gate.js');
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const named = events.flatMap((e) => e.paths ?? []);
    for (const name of LEFT_OUT) expect([name, named.includes(`_config/${name}`)]).toEqual([name, false]);
  }, 30_000);

  test("an agent's write to another file under _config/ is refused as outside the mount's include", async () => {
    const { root, storePath, cfg } = setUp();
    const { call } = await started(root, configMount(storePath));
    const res = await call('write', { path: '_config/notes.txt', content: 'a note' });
    expect(res.success).toBe(false);
    expect(String(res.error)).toContain('"_config/notes.txt" is outside the mount\'s include: mount "_config" holds only gate.json, gate.js, gate.recipe.json.');
    expect(existsSync(join(cfg, 'notes.txt'))).toBe(false);
  }, 30_000);

  test('a generated file registered under _config is read whatever the include covers', async () => {
    const { root, storePath } = setUp();
    const { workspace } = await started(root, configMount(storePath));
    workspace.registerGeneratedTextFile('_config/tools.md', () => '# tools\n', 'agent');
    const read = await workspace.handleToolCall({ id: 't', name: 'read', input: { path: '_config/tools.md' }, callerAgentName: 'agent' } as never);
    expect(read.success).toBe(true);
    expect(JSON.stringify(read.data)).toContain('# tools');
  }, 30_000);

  test('a materialize writes the config back at its mode and leaves every other file on disk as it is', async () => {
    const { root, storePath, cfg } = setUp();
    writeFileSync(join(cfg, 'gate.json'), '{"v":1}\n');
    chmodSync(join(cfg, 'gate.json'), 0o600);
    writeFileSync(join(cfg, 'gate.json.unreadable-1'), 'kept for the operator\n');
    chmodSync(join(cfg, 'gate.json.unreadable-1'), 0o600);
    writeFileSync(join(cfg, '#gate.json#'), 'an autosave\n');
    const { workspace, call } = await started(root, configMount(storePath));
    await call('sync', {});
    expect((await call('write', { path: '_config/gate.json', content: '{"v":2}\n' })).success).toBe(true);
    expect(readFileSync(join(cfg, 'gate.json'), 'utf8')).toBe('{"v":1}\n');
    await workspace.materializeMount('_config');
    expect(readFileSync(join(cfg, 'gate.json'), 'utf8')).toBe('{"v":2}\n');
    expect(statSync(join(cfg, 'gate.json')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(cfg, 'gate.json.unreadable-1'), 'utf8')).toBe('kept for the operator\n');
    expect(statSync(join(cfg, 'gate.json.unreadable-1')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(cfg, '#gate.json#'), 'utf8')).toBe('an autosave\n');
  }, 30_000);

  test('of what history holds from before the include, a materialize writes back the config alone', async () => {
    const { root, storePath, cfg } = setUp();
    writeFileSync(join(cfg, 'gate.json'), '{}\n');
    writeFileSync(join(cfg, '#gate.json#'), 'an autosave\n');
    const store = JsStore.openOrCreate({ path: join(root, 'store.chronicle') });
    cleanups.push(() => store.close?.());
    const { include: _, ...without } = configMount(storePath);
    const before = await started(root, { ...without, watch: 'never' }, store);
    const synced = (await before.call('sync', {})).data as { results: Array<{ synced: string[] }> };
    expect(synced.results.flatMap((r) => r.synced).sort()).toEqual(['#gate.json#', 'gate.json']);
    for (const name of ['#gate.json#', 'gate.json']) {
      expect((await before.call('write', { path: `_config/${name}`, content: 'from the store\n' })).success).toBe(true);
    }
    await before.stop();
    const after = await started(root, { ...configMount(storePath), watch: 'never' }, store);
    await after.workspace.materializeMount('_config');
    expect(readFileSync(join(cfg, 'gate.json'), 'utf8')).toBe('from the store\n');
    expect(readFileSync(join(cfg, '#gate.json#'), 'utf8')).toBe('an autosave\n');
  }, 30_000);
});
