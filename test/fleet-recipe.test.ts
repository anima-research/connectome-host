/**
 * Schema-validation tests for modules.fleet and the triumvirate.json recipe.
 * Pure JSON-in / validator-out tests — no subprocess needed.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRecipe } from '../src/recipe.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, '..');

function baseRecipe(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Test',
    agent: { systemPrompt: 'test' },
    ...extra,
  };
}

describe('validateRecipe — fleet schema', () => {
  test('boolean form is accepted', () => {
    expect(() => validateRecipe(baseRecipe({ modules: { fleet: true } }))).not.toThrow();
    expect(() => validateRecipe(baseRecipe({ modules: { fleet: false } }))).not.toThrow();
  });

  test('valid object form is accepted', () => {
    expect(() => validateRecipe(baseRecipe({
      modules: {
        fleet: {
          children: [
            { name: 'miner', recipe: 'recipes/miner.json', autoStart: true },
            { name: 'clerk', recipe: 'recipes/clerk.json' },
          ],
          allowedRecipes: ['recipes/*', 'https://trusted.example/agents/*'],
          defaultSubscription: ['lifecycle'],
        },
      },
    }))).not.toThrow();
  });

  test('rejects mid-string * in allowedRecipes', () => {
    expect(() => validateRecipe(baseRecipe({
      modules: { fleet: { allowedRecipes: ['recipes/*.json'] } },
    }))).toThrow(/mid-string "\*"/);
    expect(() => validateRecipe(baseRecipe({
      modules: { fleet: { allowedRecipes: ['rec*/miner.json'] } },
    }))).toThrow(/mid-string "\*"/);
  });

  test('children must be an array', () => {
    expect(() => validateRecipe(baseRecipe({
      modules: { fleet: { children: 'not-an-array' } },
    }))).toThrow(/children must be an array/);
  });

  test('each child must have a non-empty name', () => {
    expect(() => validateRecipe(baseRecipe({
      modules: { fleet: { children: [{ recipe: 'r.json' }] } },
    }))).toThrow(/name must be a non-empty string/);
  });

  test('each child must have a non-empty recipe', () => {
    expect(() => validateRecipe(baseRecipe({
      modules: { fleet: { children: [{ name: 'x' }] } },
    }))).toThrow(/recipe must be a non-empty string/);
  });

  test('duplicate child names are rejected', () => {
    expect(() => validateRecipe(baseRecipe({
      modules: {
        fleet: {
          children: [
            { name: 'miner', recipe: 'a.json' },
            { name: 'miner', recipe: 'b.json' },
          ],
        },
      },
    }))).toThrow(/duplicated/);
  });

  test('allowedRecipes must be an array of strings', () => {
    expect(() => validateRecipe(baseRecipe({
      modules: { fleet: { allowedRecipes: 'recipes/*.json' } },
    }))).toThrow(/allowedRecipes must be an array/);
    expect(() => validateRecipe(baseRecipe({
      modules: { fleet: { allowedRecipes: [1, 2, 3] } },
    }))).toThrow(/allowedRecipes must be an array of strings/);
  });

  test('subscription must be an array when present', () => {
    expect(() => validateRecipe(baseRecipe({
      modules: { fleet: { children: [{ name: 'x', recipe: 'r.json', subscription: 'not-array' }] } },
    }))).toThrow(/subscription must be an array/);
  });

  test('autoStart must be boolean when present', () => {
    expect(() => validateRecipe(baseRecipe({
      modules: { fleet: { children: [{ name: 'x', recipe: 'r.json', autoStart: 'yes' }] } },
    }))).toThrow(/autoStart must be a boolean/);
  });
});

describe('recipes/triumvirate.json', () => {
  test('parses and validates cleanly', () => {
    const triumviratePath = join(REPO_ROOT, 'recipes', 'triumvirate.json');
    const raw = JSON.parse(readFileSync(triumviratePath, 'utf-8'));
    const recipe = validateRecipe(raw);

    expect(recipe.name).toBe('Knowledge Mining Triumvirate');
    expect(recipe.agent.name).toBe('conductor');
    expect(recipe.modules?.fleet).toBeDefined();
    const fleet = recipe.modules?.fleet;
    if (typeof fleet === 'object' && fleet !== null) {
      expect(fleet.children).toHaveLength(3);
      const names = fleet.children!.map((c) => c.name).sort();
      expect(names).toEqual(['clerk', 'miner', 'reviewer']);
      expect(fleet.children!.every((c) => c.autoStart === true)).toBe(true);
    } else {
      throw new Error('fleet should be an object');
    }
  });
});
