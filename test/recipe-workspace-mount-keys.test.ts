import { describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { WorkspaceModule, type ModuleContext } from '@animalabs/agent-framework';
import { InstructionsModule } from '../src/modules/instructions-module.js';
import { validateRecipe } from '../src/recipe.js';
import { buildWorkspaceMounts } from '../src/workspace-mounts.js';

/**
 * A workspace mount takes every key the framework's MountConfig has but
 * those recipe.ts names in MountKeyNotPassedOn, and a recipe that names a key
 * or value the host doesn't read stops loading with an error that names it
 * (#275). Before, `walkCap`, `followSymlinks`,
 * `watchDebounceMs` and `watchRootPollMs`, which the host's list didn't
 * have, were dropped without a word, and a misspelt key such as `readOnly: true` left the mount
 * as it would have been without it.
 */

function recipe(workspace: unknown) {
  return { name: 'mount-keys-test', agent: { systemPrompt: 'test' }, modules: { workspace } };
}
const mount = (extra: Record<string, unknown> = {}) => ({ name: 'notes', path: './notes', ...extra });

describe('workspace mount keys', () => {
  test('passes every mount key through to the framework, walkCap, followSymlinks, watchDebounceMs and watchRootPollMs included', () => {
    const keys = {
      mode: 'read-only', watch: 'always', watchDebounceMs: 50, watchRootPollMs: 500, ignore: ['*.tmp'],
      followSymlinks: true, maxFileSize: 4096, walkCap: 20_000, wakeOnChange: ['created'], autoMaterialize: true,
    };
    const workspace = { mounts: [mount(keys)] };
    validateRecipe(recipe(workspace));
    expect(buildWorkspaceMounts(workspace as never, '/store')![0]).toEqual({ name: 'notes', path: resolve('./notes'), ...keys });
  });

  test('refuses a key a mount does not have, naming what to write instead or the nearest key it does have', () => {
    expect(() => validateRecipe(recipe({ mounts: [mount({ readOnly: true })] })))
      .toThrow(/^workspace\.mounts\[0\] has unknown key "readOnly" \(mode: "read-only" makes a mount read-only, and a mount is read-write without it\); known: name, path, mode, watch, /);
    expect(() => validateRecipe(recipe({ mounts: [mount(), mount({ name: 'tickets', wakeOnChnage: true })] })))
      .toThrow(/^workspace\.mounts\[1\] has unknown key "wakeOnChnage" \(did you mean "wakeOnChange"\?\)/);
  });

  test("refuses include, which this host doesn't pass on to the framework yet, as a key a mount doesn't have", () => {
    expect(() => validateRecipe(recipe({ mounts: [mount({ include: ['*.json'] })] })))
      .toThrow(/^workspace\.mounts\[0\] has unknown key "include"; known: name, path, mode, watch, watchDebounceMs, watchRootPollMs, ignore, followSymlinks, maxFileSize, walkCap, wakeOnChange, autoMaterialize$/);
  });

  test("refuses backend, which this host doesn't pass on to the framework yet, as a key a mount doesn't have", () => {
    expect(() => validateRecipe(recipe({ mounts: [mount({ backend: 'direct' })] })))
      .toThrow(/^workspace\.mounts\[0\] has unknown key "backend"; known: name, path, mode, watch, watchDebounceMs, watchRootPollMs, ignore, followSymlinks, maxFileSize, walkCap, wakeOnChange, autoMaterialize$/);
  });

  test('refuses a key the workspace does not have', () => {
    expect(() => validateRecipe(recipe({ mounts: [mount()], configMounts: true })))
      .toThrow(/^workspace has unknown key "configMounts" \(did you mean "configMount"\?\); known: mounts, configMount$/);
  });

  test('refuses a value of the wrong kind, null included', () => {
    const refused: Array<[Record<string, unknown>, RegExp]> = [
      [{ watch: 'allways' }, /\.watch must be "always", "on-agent-action" or "never"$/],
      [{ watch: null }, /\.watch must be "always", "on-agent-action" or "never"$/],
      [{ mode: 'readonly' }, /\.mode must be "read-write" or "read-only"$/],
      [{ name: '' }, /\.name must be a non-empty string$/],
      // A timer runs a delay above 2147483647 ms, or below 0, at once, and truncates a fraction.
      [{ watchDebounceMs: -1 }, /\.watchDebounceMs must be a whole number of milliseconds from 0 to 2147483647$/],
      [{ watchDebounceMs: 250.5 }, /\.watchDebounceMs must be a whole number of milliseconds from 0 to 2147483647$/],
      [{ watchDebounceMs: 2147483648 }, /\.watchDebounceMs must be a whole number of milliseconds from 0 to 2147483647$/],
      [{ watchRootPollMs: 2147483648 }, /\.watchRootPollMs must be a whole number of milliseconds from 1 to 2147483647$/],
      // A poll of 0 runs as often as one of 1.
      [{ watchRootPollMs: 0 }, /\.watchRootPollMs must be a whole number of milliseconds from 1 to 2147483647$/],
      [{ watchRootPollMs: '2s' }, /\.watchRootPollMs must be a whole number of milliseconds from 1 to 2147483647$/],
      [{ maxFileSize: '5MB' }, /\.maxFileSize must be a whole number of bytes, 1 or more$/],
      [{ maxFileSize: -1 }, /\.maxFileSize must be a whole number of bytes, 1 or more$/],
      // A cap of 0 refuses every file that isn't empty.
      [{ maxFileSize: 0 }, /\.maxFileSize must be a whole number of bytes, 1 or more$/],
      [{ maxFileSize: 1024.5 }, /\.maxFileSize must be a whole number of bytes, 1 or more$/],
      // What agent-framework refuses when the workspace is built, refused here at load.
      [{ walkCap: 0 }, /\.walkCap must be a whole number of entries from 1 to 9007199254740991$/],
      [{ walkCap: -1 }, /\.walkCap must be a whole number of entries from 1 to 9007199254740991$/],
      [{ walkCap: 2.5 }, /\.walkCap must be a whole number of entries from 1 to 9007199254740991$/],
      [{ walkCap: 2 ** 53 }, /\.walkCap must be a whole number of entries from 1 to 9007199254740991$/],
      [{ walkCap: 1e20 }, /\.walkCap must be a whole number of entries from 1 to 9007199254740991$/],
      [{ followSymlinks: 'yes' }, /\.followSymlinks must be true or false$/],
      [{ autoMaterialize: 1 }, /\.autoMaterialize must be true or false$/],
      [{ ignore: 'node_modules' }, /\.ignore must be an array of strings$/],
      [{ ignore: ['node_modules', 1] }, /\.ignore must be an array of strings$/],
      [{ wakeOnChange: ['created', 'renamed'] }, /\.wakeOnChange must be true, false, or a list of "created", "modified" or "deleted"$/],
    ];
    // Each number key refuses a numeric string, null, and what only a caller
    // other than a recipe file can give: NaN and Infinity.
    for (const key of ['watchDebounceMs', 'watchRootPollMs', 'maxFileSize', 'walkCap']) {
      for (const value of ['250', null, NaN, Infinity]) {
        refused.push([{ [key]: value }, new RegExp(`\\.${key} must be a whole number of `)]);
      }
    }
    for (const [extra, message] of refused) {
      expect(() => validateRecipe(recipe({ mounts: [mount(extra)] }))).toThrow(message);
    }
    expect(() => validateRecipe(recipe({ mounts: [{ name: 'notes' }] }))).toThrow(/^workspace\.mounts\[0\]\.path must be a non-empty string$/);
    expect(() => validateRecipe(recipe({ mounts: [{ path: './notes' }] }))).toThrow(/^workspace\.mounts\[0\]\.name must be a non-empty string$/);
    expect(() => validateRecipe(recipe({ mounts: [mount()], configMount: 'yes' }))).toThrow(/workspace\.configMount must be true or false/);
    expect(() => validateRecipe(recipe({ mounts: [mount()], configMount: null }))).toThrow(/workspace\.configMount must be true or false/);
  });

  test("takes each number key's ends and empty lists, and passes them to the framework as given", () => {
    for (const extra of [
      { watchDebounceMs: 0, watchRootPollMs: 1, maxFileSize: 1, walkCap: 1 },
      // A cap past 2^53 bytes is still a whole number the framework compares with.
      { watchDebounceMs: 2147483647, watchRootPollMs: 2147483647, maxFileSize: 2 ** 53, walkCap: Number.MAX_SAFE_INTEGER },
      { wakeOnChange: [], ignore: [] },
      { wakeOnChange: false },
    ]) {
      const workspace = { mounts: [mount(extra)] };
      expect(() => validateRecipe(recipe(workspace))).not.toThrow();
      expect(buildWorkspaceMounts(workspace as never, '/store')![0]).toMatchObject(extra);
    }
  });

  test('modules is an object, and anything else stops the recipe loading', () => {
    // Anything else would read every module setting as absent and build the
    // default mounts, read-write `products` included.
    for (const modules of ['off', 0, false, true, null, [], [{ workspace: false }]]) {
      expect(() => validateRecipe({ name: 'modules-test', agent: { systemPrompt: 'test' }, modules }))
        .toThrow(/^modules must be an object of module settings, not null or a list$/);
    }
    expect(() => validateRecipe({ name: 'modules-test', agent: { systemPrompt: 'test' }, modules: {} })).not.toThrow();
  });

  test('modules.workspace is true, false or an object, and anything else stops the recipe loading', () => {
    // A string or a number would build the default mounts, read-write
    // `products` included, and null would crash the mount builder.
    for (const workspace of [null, 'off', 0, 1, [], [mount()]]) {
      expect(() => validateRecipe(recipe(workspace))).toThrow(/^modules\.workspace must be true, false or an object of settings, not null or a list$/);
    }
    for (const workspace of [true, false, { mounts: [mount()] }]) {
      expect(() => validateRecipe(recipe(workspace))).not.toThrow();
    }
  });

  test('with followSymlinks, a link inside the mount is read, and the instructions file never reads through one leading out of it', async () => {
    // The instructions file is read through readFileFromDisk, which on a
    // mount that follows links still refuses one leading outside it, as
    // `escape`, and the module says the file itself can be that link.
    const root = mkdtempSync(join(tmpdir(), 'mount-keys-'));
    const dir = join(root, 'instructions');
    const outside = join(root, 'outside');
    // The instructions module says why it injected nothing on stderr.
    const warn = spyOn(console, 'error').mockImplementation(() => {});
    try {
      mkdirSync(dir);
      mkdirSync(outside);
      writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE_SECRET');
      symlinkSync(join(outside, 'secret.txt'), join(dir, 'AGENTS.md'));
      writeFileSync(join(dir, 'notes.md'), 'INSIDE');
      symlinkSync(join(dir, 'notes.md'), join(dir, 'linked.md'));
      const workspace = { mounts: [{ name: 'instructions', path: dir, autoMaterialize: true, followSymlinks: true }] };
      validateRecipe(recipe(workspace));
      const store = JsStore.openOrCreate({ path: join(root, 'store') });
      try {
        const ws = new WorkspaceModule({ mounts: buildWorkspaceMounts(workspace as never, join(root, 'store'))! });
        ws.initStore(store);
        // Started, as the host starts it: one that isn't reads nothing.
        const alerts: string[] = [];
        const instructions = new InstructionsModule({ agentName: 'resident' });
        await instructions.start({ notifyOps: (_kind: string, _agent: string, message: string) => { alerts.push(message); } } as unknown as ModuleContext);
        instructions.setWorkspace(ws);
        expect(await instructions.gatherContext('a')).toEqual([]);
        expect(alerts).toEqual([
          'no instructions injected: "instructions/AGENTS.md" leads outside its mount through a link, the file itself or a ' +
          'directory on its path: move the file into the mount, so that neither it nor a directory on its path is a link ' +
          'that leads out',
        ]);
        // The framework's own disk read, which the instructions module and
        // the identity module's uploads read through, refuses it as `escape`,
        // and still reads a link that stays inside the mount: the option is on.
        await expect(ws.readFileFromDisk('instructions/AGENTS.md')).rejects.toMatchObject({ code: 'escape' });
        expect((await ws.readFileFromDisk('instructions/linked.md')).bytes.toString('utf-8')).toBe('INSIDE');
      } finally {
        store.close();
      }
    } finally {
      warn.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a mount using only keys and values the host read before loads, and builds, as it did', () => {
    const workspace = {
      configMount: true,
      mounts: [mount({
        mode: 'read-only', watch: 'on-agent-action', ignore: ['node_modules'], maxFileSize: 1024,
        wakeOnChange: ['created', 'deleted'], autoMaterialize: false,
      }), mount({ name: 'out', path: './out', wakeOnChange: true })],
    };
    expect(() => validateRecipe(recipe(workspace))).not.toThrow();
    // What the host built for this recipe before #275, key by key.
    expect(buildWorkspaceMounts(workspace as never, '/store')).toEqual([
      {
        name: 'notes', path: resolve('./notes'), mode: 'read-only', watch: 'on-agent-action', ignore: ['node_modules'],
        maxFileSize: 1024, wakeOnChange: ['created', 'deleted'], autoMaterialize: false,
      },
      { name: 'out', path: resolve('./out'), mode: 'read-write', watch: 'never', wakeOnChange: true },
      { name: '_config', path: resolve('/store/config'), mode: 'read-write', watch: 'always' },
    ]);
  });
});
