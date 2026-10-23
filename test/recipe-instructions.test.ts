import { describe, expect, test } from 'bun:test';
import { validateRecipe } from '../src/recipe.js';

function recipe(modules?: Record<string, unknown>) {
  return {
    name: 'instructions-test',
    agent: { systemPrompt: 'test' },
    ...(modules === undefined ? {} : { modules }),
  };
}

/** A workspace declaration that satisfies the instructions cross-check for
 *  the given mount name: read-write + autoMaterialize (the validated shape
 *  for a mount agents curate). */
function wsFor(mountName: string) {
  return {
    mounts: [
      { name: mountName, path: `./${mountName}`, mode: 'read-write', autoMaterialize: true },
    ],
  };
}

describe('recipe modules.instructions validation', () => {
  test('allows the field to be omitted', () => {
    expect(validateRecipe(recipe()).modules?.instructions).toBeUndefined();
  });

  test('accepts boolean shorthand', () => {
    expect(validateRecipe(recipe({ instructions: true, workspace: wsFor('instructions') }))
      .modules?.instructions).toBe(true);
    expect(validateRecipe(recipe({ instructions: false })).modules?.instructions).toBe(false);
  });

  test('accepts a full object config', () => {
    const parsed = validateRecipe(recipe({
      workspace: wsFor('shared'),
      instructions: {
        path: 'shared/HOUSE-RULES.md',
        header: '## House rules',
        maxBytes: 4096,
        position: 'afterUser',
      },
    }));
    expect(parsed.modules?.instructions).toEqual({
      path: 'shared/HOUSE-RULES.md',
      header: '## House rules',
      maxBytes: 4096,
      position: 'afterUser',
    });
  });

  test('accepts an empty object (all defaults)', () => {
    expect(validateRecipe(recipe({ instructions: {}, workspace: wsFor('instructions') }))
      .modules?.instructions).toEqual({});
  });

  test('rejects non-boolean, non-object values', () => {
    expect(() => validateRecipe(recipe({ instructions: 'yes' }))).toThrow(/boolean or object/);
    expect(() => validateRecipe(recipe({ instructions: ['x'] }))).toThrow(/boolean or object/);
  });

  test('rejects unknown fields', () => {
    expect(() => validateRecipe(recipe({ instructions: { file: 'AGENTS.md' } })))
      .toThrow(/unknown field "file"/);
  });

  test('rejects a path without a "<mountName>/<relativePath>" shape', () => {
    expect(() => validateRecipe(recipe({ instructions: { path: 'AGENTS.md' } })))
      .toThrow(/<mountName>\/<relativePath>/);
    expect(() => validateRecipe(recipe({ instructions: { path: '/etc/passwd' } })))
      .toThrow(/<mountName>\/<relativePath>/);
    expect(() => validateRecipe(recipe({ instructions: { path: 'mount/' } })))
      .toThrow(/<mountName>\/<relativePath>/);
    expect(() => validateRecipe(recipe({ instructions: { path: '' } })))
      .toThrow(/non-empty string/);
  });

  test('rejects invalid maxBytes', () => {
    expect(() => validateRecipe(recipe({ instructions: { maxBytes: 0 } })))
      .toThrow(/positive integer/);
    expect(() => validateRecipe(recipe({ instructions: { maxBytes: 1.5 } })))
      .toThrow(/positive integer/);
    expect(() => validateRecipe(recipe({ instructions: { maxBytes: '32768' } })))
      .toThrow(/positive integer/);
  });

  test('rejects invalid position', () => {
    expect(() => validateRecipe(recipe({ instructions: { position: 'prepend' } })))
      .toThrow(/'system', 'beforeUser', or 'afterUser'/);
  });

  test('rejects non-string header', () => {
    expect(() => validateRecipe(recipe({ instructions: { header: 42 } })))
      .toThrow(/header must be a string/);
  });

  test('rejects instructions when workspace is disabled', () => {
    expect(() => validateRecipe(recipe({ instructions: true, workspace: false })))
      .toThrow(/requires modules\.workspace/);
    expect(() => validateRecipe(recipe({ instructions: {}, workspace: false })))
      .toThrow(/requires modules\.workspace/);
  });

  test('accepts a properly declared instructions mount (rw + autoMaterialize)', () => {
    expect(() => validateRecipe(recipe({
      instructions: true,
      workspace: wsFor('instructions'),
    }))).not.toThrow();
  });

  test('cross-checks the path mount against explicitly declared workspace mounts', () => {
    const mounts = [
      { name: 'input', path: './input', mode: 'read-only' },
      { name: 'products', path: './output', mode: 'read-write' },
    ];
    // Default path 'instructions/AGENTS.md' names a mount that isn't declared.
    expect(() => validateRecipe(recipe({ instructions: true, workspace: { mounts } })))
      .toThrow(/requires a workspace mount named\s+"instructions"/);
    // Same for an explicit path with a typo'd mount name.
    expect(() => validateRecipe(recipe({
      instructions: { path: 'shared/AGENTS.md' },
      workspace: { mounts },
    }))).toThrow(/names workspace mount "shared"/);
    // A read-only declared mount passes without autoMaterialize (disk is its
    // only write path).
    expect(() => validateRecipe(recipe({
      instructions: { path: 'input/AGENTS.md' },
      workspace: { mounts },
    }))).not.toThrow();
    // The '_config' mount exists under configMount but is rejected for
    // instructions: it does not auto-materialize (agent edits reach disk only
    // after branch-changing commands), so the injection would serve stale
    // content — the same split-brain the autoMaterialize check prevents.
    expect(() => validateRecipe(recipe({
      instructions: { path: '_config/AGENTS.md' },
      workspace: { mounts, configMount: true },
    }))).toThrow(/host-managed "_config"/);
  });

  test('rejects a read-write instructions mount without autoMaterialize (split-brain guard)', () => {
    // Workspace writes are Chronicle-first; the injection reads disk. A rw
    // mount that never materializes would silently freeze the injection at
    // the pre-curation content.
    expect(() => validateRecipe(recipe({
      instructions: { path: 'products/AGENTS.md' },
      workspace: { mounts: [{ name: 'products', path: './output', mode: 'read-write' }] },
    }))).toThrow(/autoMaterialize/);
    // Mode defaults to read-write, so an unmoded mount needs it too.
    expect(() => validateRecipe(recipe({
      instructions: true,
      workspace: { mounts: [{ name: 'instructions', path: './instructions' }] },
    }))).toThrow(/autoMaterialize/);
  });

  test('accepts a direct instructions mount, which is read-only', () => {
    expect(() => validateRecipe(recipe({
      instructions: true,
      workspace: { mounts: [{ name: 'instructions', path: './instructions', backend: 'direct', mode: 'read-only' }] },
    }))).not.toThrow();
  });

  test('cross-checks against the implicit default workspace too', () => {
    // `instructions: true` with the implicit workspace (mounts input +
    // products) can never inject — the default path's mount cannot exist.
    // That used to validate and be dead config; now it fails at load.
    expect(() => validateRecipe(recipe({ instructions: true })))
      .toThrow(/implicit default\s+mounts/);
    expect(() => validateRecipe(recipe({ instructions: true, workspace: true })))
      .toThrow(/implicit default\s+mounts/);
    // The implicit read-only 'input' mount is a valid target (file maintained
    // outside the agent).
    expect(() => validateRecipe(recipe({ instructions: { path: 'input/AGENTS.md' } })))
      .not.toThrow();
    // The implicit 'products' mount is rw without autoMaterialize — and the
    // implicit workspace cannot set it, so this directs to explicit mounts.
    expect(() => validateRecipe(recipe({ instructions: { path: 'products/AGENTS.md' } })))
      .toThrow(/implicit default workspace cannot/);
  });

  test('allows instructions: false alongside workspace: false', () => {
    expect(() => validateRecipe(recipe({ instructions: false, workspace: false }))).not.toThrow();
  });
});
