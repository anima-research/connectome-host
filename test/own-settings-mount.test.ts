import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { WorkspaceModule } from '@animalabs/agent-framework';
import { ownSettingsMount } from '../src/workspace-mounts.js';
import { ownSettingsDir } from '../src/own-settings-table.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function started() {
  const dataDir = mkdtempSync(join(tmpdir(), 'own-settings-mount-'));
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  mkdirSync(ownSettingsDir(dataDir));
  const store = JsStore.openOrCreate({ path: join(dataDir, 'store.chronicle') });
  const workspace = new WorkspaceModule({ mounts: [ownSettingsMount(dataDir)] });
  workspace.initStore(store);
  await workspace.start({ isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} } as never);
  cleanups.push(async () => { await workspace.stop().catch(() => {}); store.close?.(); });
  const call = (name: string, input: Record<string, unknown>) => workspace.handleToolCall({ id: 't', name, input });
  return { dir: ownSettingsDir(dataDir), call };
}

async function startsWith(mounts: unknown[], dataDir: string): Promise<boolean> {
  const store = JsStore.openOrCreate({ path: join(dataDir, 'store.chronicle') });
  const workspace = new WorkspaceModule({ mounts } as ConstructorParameters<typeof WorkspaceModule>[0]);
  workspace.initStore(store);
  cleanups.push(async () => { await workspace.stop().catch(() => {}); store.close?.(); });
  await workspace.start({ isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} } as never);
  return true;
}

describe('the _settings mount beside what can be at its path', () => {
  const dataDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'own-settings-mount-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  };

  test('a workspace starts where own-settings is a file', async () => {
    const dir = dataDir();
    writeFileSync(ownSettingsDir(dir), 'a file');
    expect(await startsWith([ownSettingsMount(dir)], dir)).toBe(true);
  }, 30_000);

  test('a workspace starts beside a recipe mount over the data directory, or at own-settings itself', async () => {
    const over = dataDir();
    mkdirSync(ownSettingsDir(over));
    expect(await startsWith([{ name: 'data', path: over, mode: 'read-write', backend: 'direct' }, ownSettingsMount(over)], over)).toBe(true);
    const at = dataDir();
    mkdirSync(ownSettingsDir(at));
    expect(await startsWith([{ name: 'own', path: ownSettingsDir(at), mode: 'read-write', backend: 'direct' }, ownSettingsMount(at)], at)).toBe(true);
  }, 30_000);
});

describe('the _settings mount (case 18)', () => {
  test('a write, an edit and a delete of _settings/own.json are on disk when they answer', async () => {
    const { dir, call } = await started();
    expect((await call('write', { path: '_settings/own.json', content: '{"agent.proseRouting": "explicit"}\n' })).success).toBe(true);
    expect(readFileSync(join(dir, 'own.json'), 'utf-8')).toBe('{"agent.proseRouting": "explicit"}\n');
    expect((await call('edit', { path: '_settings/own.json', oldString: 'explicit', newString: 'hybrid' })).success).toBe(true);
    expect(readFileSync(join(dir, 'own.json'), 'utf-8')).toBe('{"agent.proseRouting": "hybrid"}\n');
    expect((await call('delete', { path: '_settings/own.json' })).success).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  }, 30_000);

  test('a write or a delete of another name there is refused', async () => {
    const { dir, call } = await started();
    expect((await call('write', { path: '_settings/other.json', content: '{}' })).success).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
    writeFileSync(join(dir, 'other.json'), '{}');
    expect((await call('delete', { path: '_settings/other.json' })).success).toBe(false);
    expect(readdirSync(dir)).toEqual(['other.json']);
  }, 30_000);

  test('a file of the same name in a directory beneath is refused', async () => {
    const { dir, call } = await started();
    expect((await call('write', { path: '_settings/sub/own.json', content: '{}' })).success).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  }, 30_000);
});
