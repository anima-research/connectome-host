import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { buildWorkspaceMounts } from '../src/workspace-mounts.js';

/**
 * Contract tests for the shared mount builder. validateRecipe's instructions
 * cross-check reasons over this exact output, so these pin the properties the
 * validator depends on — most importantly that `_config` is NOT
 * auto-materialized (agent edits stay Chronicle-side between branch-changing
 * commands), which is why the validator rejects it as an instructions path.
 */
describe('buildWorkspaceMounts', () => {
  test('workspace: false disables mounts entirely', () => {
    expect(buildWorkspaceMounts(false, '/store')).toBeNull();
  });

  test('implicit default (omitted or true): input ro + products rw, neither auto-materialized', () => {
    for (const ws of [undefined, true as const]) {
      const mounts = buildWorkspaceMounts(ws, '/store')!;
      expect(mounts.map((m) => m.name)).toEqual(['input', 'products']);
      const [input, products] = mounts;
      expect(input.mode).toBe('read-only');
      expect(products.mode).toBe('read-write');
      expect(input.autoMaterialize).toBeUndefined();
      expect(products.autoMaterialize).toBeUndefined();
    }
  });

  test('explicit mounts pass through declared fields and default mode/watch', () => {
    const mounts = buildWorkspaceMounts({
      mounts: [
        { name: 'instructions', path: './instructions', autoMaterialize: true },
        { name: 'refs', path: './refs', mode: 'read-only', watch: 'always' },
      ],
    }, '/store')!;
    expect(mounts[0]).toMatchObject({
      name: 'instructions',
      path: resolve('./instructions'),
      mode: 'read-write', // defaulted
      watch: 'never', // defaulted (no chokidar by default)
      autoMaterialize: true,
    });
    expect(mounts[1]).toMatchObject({ mode: 'read-only', watch: 'always' });
    expect(mounts[1].autoMaterialize).toBeUndefined();
  });

  test("a mount's walkCap passes through, and a mount that sets none leaves agent-framework's default", () => {
    const mounts = buildWorkspaceMounts({
      mounts: [
        { name: 'corpus', path: './corpus', walkCap: 20_000 },
        { name: 'refs', path: './refs' },
      ],
    }, '/store')!;
    expect(mounts[0]!.walkCap).toBe(20_000);
    expect('walkCap' in mounts[1]!).toBe(false);
  });

  test('_config mount (configMount: true) is read-write and NOT auto-materialized', () => {
    // THE contract behind rejecting `_config/...` as an instructions path:
    // the host materializes this mount only after branch-changing commands,
    // never on ordinary agent writes. If this test starts failing because
    // `_config` gained autoMaterialize, revisit the validator's rejection.
    const mounts = buildWorkspaceMounts({ mounts: [], configMount: true }, '/store')!;
    const config = mounts.find((m) => m.name === '_config')!;
    expect(config).toBeDefined();
    expect(config.mode).toBe('read-write');
    expect(config.autoMaterialize).toBeUndefined();
    expect(config.path).toBe(resolve('/store/config'));
    expect(config.watch).toBe('always');
    // Undo and redo rewind it through materializeMount, which only a
    // chronicle mount has history for, whatever the framework's default.
    expect(config.backend).toBe('chronicle');
  });

  test('configMount composes with the implicit default mounts only in object form', () => {
    // Matches the host: `workspace: true` cannot request the config mount.
    const objForm = buildWorkspaceMounts({ mounts: undefined as never, configMount: true }, '/s');
    expect((objForm ?? []).some((m) => m.name === '_config')).toBe(true);
    const boolForm = buildWorkspaceMounts(true, '/s')!;
    expect(boolForm.some((m) => m.name === '_config')).toBe(false);
  });
});
