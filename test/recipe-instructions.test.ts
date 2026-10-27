import { describe, expect, test } from 'bun:test';
import { validateRecipe } from '../src/recipe.js';

function recipe(modules?: Record<string, unknown>) {
  return {
    name: 'instructions-test',
    agent: { systemPrompt: 'test' },
    ...(modules === undefined ? {} : { modules }),
  };
}

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
    expect(() => validateRecipe(recipe({ instructions: true, workspace: { mounts } })))
      .toThrow(/requires a workspace mount named\s+"instructions"/);
    expect(() => validateRecipe(recipe({
      instructions: { path: 'shared/AGENTS.md' },
      workspace: { mounts },
    }))).toThrow(/names workspace mount "shared"/);
    expect(() => validateRecipe(recipe({
      instructions: { path: 'input/AGENTS.md' },
      workspace: { mounts },
    }))).not.toThrow();
    expect(() => validateRecipe(recipe({
      instructions: { path: '_config/AGENTS.md' },
      workspace: { mounts, configMount: true },
    }))).toThrow(/host-managed "_config"/);
  });

  test('rejects a read-write Chronicle instructions mount without autoMaterialize (split-brain guard)', () => {
    expect(() => validateRecipe(recipe({
      instructions: { path: 'products/AGENTS.md' },
      workspace: { mounts: [{ name: 'products', path: './output', mode: 'read-write' }] },
    }))).toThrow(/autoMaterialize/);
    expect(() => validateRecipe(recipe({
      instructions: true,
      workspace: { mounts: [{ name: 'instructions', path: './instructions' }] },
    }))).toThrow(/autoMaterialize/);
  });

  test('accepts a direct instructions mount, read-only or read-write, with no autoMaterialize', () => {
    for (const mode of ['read-only', 'read-write']) {
      expect(() => validateRecipe(recipe({
        instructions: true,
        workspace: { mounts: [{ name: 'instructions', path: './instructions', backend: 'direct', mode }] },
      }))).not.toThrow();
    }
  });

  test('cross-checks against the implicit default workspace too', () => {
    expect(() => validateRecipe(recipe({ instructions: true })))
      .toThrow(/implicit default\s+mounts/);
    expect(() => validateRecipe(recipe({ instructions: true, workspace: true })))
      .toThrow(/implicit default\s+mounts/);
    expect(() => validateRecipe(recipe({ instructions: { path: 'input/AGENTS.md' } })))
      .not.toThrow();
    expect(() => validateRecipe(recipe({ instructions: { path: 'products/AGENTS.md' } })))
      .toThrow(/implicit default workspace can do neither/);
  });

  test('allows instructions: false alongside workspace: false', () => {
    expect(() => validateRecipe(recipe({ instructions: false, workspace: false }))).not.toThrow();
  });
});
