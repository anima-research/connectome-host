import { describe, expect, test } from 'bun:test';
import { Agent } from '@animalabs/agent-framework';
import { buildFrameworkAgentConfig } from '../src/framework-agent-config.js';
import { validateRecipe } from '../src/recipe.js';

const recipe = (refusalHandling: unknown) => ({
  name: 'refusal-handling-test',
  agent: { systemPrompt: 'sys', ...(refusalHandling === undefined ? {} : { refusalHandling }) },
});

function thrown(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const shape = (got: string) =>
  `Recipe agent.refusalHandling must be an object, such as {"autoRewind": true}, or left out, got ${got}.`;
const autoRewind = (got: string) => `Recipe agent.refusalHandling.autoRewind must be true or false, got ${got}.`;

const refused: Array<[unknown, string]> = [
  [true, shape('true')],
  ['false', shape('"false"')],
  [1, shape('1')],
  [0, shape('0')],
  ['', shape('""')],
  [[], shape('a list')],
  [{ autoRewind: 'yes' }, autoRewind('"yes"')],
  [{ autoRewind: 1 }, autoRewind('1')],
];

const loads: unknown[] = [
  undefined, false, null,
  {}, { autoRewind: true }, { autoRewind: false }, { autoRewind: null }, { retries: 2, maxRewinds: 3 },
];

describe('recipe agent.refusalHandling', () => {
  for (const [value, message] of refused) {
    test(`refuses ${JSON.stringify(value)} when the recipe loads, saying what it must be`, () => {
      expect(thrown(() => validateRecipe(recipe(value)))).toBe(message);
    });
  }

  test('refuses at load what agent-framework refuses once the host passes it on, for each listed value', () => {
    for (const value of [...refused.map(([v]) => v), ...loads]) {
      const host = thrown(() => validateRecipe(recipe(value))) !== null;
      const config: Record<string, unknown> = buildFrameworkAgentConfig(validateRecipe(recipe(host ? undefined : value)), 'agent', 'model', { kind: 'strategy' } as never);
      if (host) config.refusalHandling = value;
      // agent-framework's Agent constructor checks its switches before anything
      // else, so a refusal with these stubs that names the setting is that check's.
      const framework = /refusalHandling/.test(thrown(() => new Agent(config, {} as never, {} as never)) ?? '');
      expect({ value, refused: host }).toEqual({ value, refused: framework });
    }
  });

  test('passes on what it loads as written, and a null autoRewind as left out', () => {
    const forwarded = (value: unknown) =>
      buildFrameworkAgentConfig(validateRecipe(recipe(value)), 'agent', 'model', { kind: 'strategy' } as never).refusalHandling;
    expect(forwarded({ retries: 2, maxRewinds: 3, autoRewind: true })).toEqual({ retries: 2, maxRewinds: 3, autoRewind: true });
    expect(forwarded({ retries: 2, autoRewind: null })).toEqual({ retries: 2 });
    expect(forwarded(null)).toBeUndefined();
    expect(forwarded(false)).toBeUndefined();
  });
});
