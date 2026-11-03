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
const autoRewind = (got: string) => `Recipe agent.refusalHandling.autoRewind must be a boolean, got ${got}.`;

const refused: Array<[unknown, string]> = [
  [true, shape('true')],
  ['false', shape('"false"')],
  [1, shape('1')],
  [[], shape('[]')],
  [{ autoRewind: 'yes' }, autoRewind('"yes"')],
  [{ autoRewind: 1 }, autoRewind('1')],
];

const loads: unknown[] = [
  undefined, false, null, 0, '',
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
      const parsed = validateRecipe(recipe(undefined));
      (parsed.agent as Record<string, unknown>).refusalHandling = value;
      const config = buildFrameworkAgentConfig(parsed, 'agent', 'model', { kind: 'strategy' } as never);
      // agent-framework's Agent constructor checks its switches before anything
      // else, so a refusal with these stubs that names the setting is that check's.
      const framework = /refusalHandling/.test(thrown(() => new Agent(config, {} as never, {} as never)) ?? '');
      expect({ value, refused: host }).toEqual({ value, refused: framework });
    }
  });
});
