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
});
