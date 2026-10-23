/**
 * A recipe's agent.refusalHandling is refused when the recipe loads, in the
 * recipe's words, when agent-framework would refuse what the host passes on.
 * From 0.22.3 the framework's create() refuses it (assertAgentSwitches, which
 * the Agent constructor runs first), and a recipe that loaded then stopped
 * the host at start-up. The host passes it on only when it's truthy
 * (buildFrameworkAgentConfig), so a falsy one loads as before. Beside the
 * framework's rule, the host refuses refusalHandling.primarySummaryFallback
 * on its own (test/recipe-primary-summary-fallback-rejection.test.ts).
 */
import { describe, expect, test } from 'bun:test';
import { Agent } from '@animalabs/agent-framework';
import { buildFrameworkAgentConfig } from '../src/framework-agent-config.js';
import { validateRecipe } from '../src/recipe.js';

const recipe = (refusalHandling: unknown) => ({
  name: 'refusal-handling-test',
  agent: { systemPrompt: 'sys', ...(refusalHandling === undefined ? {} : { refusalHandling }) },
});

/** The message `run` throws, or null when it doesn't throw. */
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

  // The values in `loads` get no tests of their own: the framework refuses
  // none of them, so the test below fails if the recipe refuses one. It
  // checks these 16 values, so a framework release that moves its rule on
  // one of them fails it.
  test('refuses at load what agent-framework refuses once the host passes it on, for each listed value', () => {
    for (const value of [...refused.map(([v]) => v), ...loads]) {
      const host = thrown(() => validateRecipe(recipe(value))) !== null;
      // What the host would hand the framework for this value: a recipe that
      // loads, with the value put in after the check.
      const parsed = validateRecipe(recipe(undefined));
      (parsed.agent as Record<string, unknown>).refusalHandling = value;
      const config = buildFrameworkAgentConfig(parsed, 'agent', 'model', { kind: 'strategy' } as never);
      // The constructor checks its switches before anything else, so its
      // refusal names the setting; anything else it throws with these stubs
      // comes later and isn't about refusalHandling. The setting's name, not
      // the framework's wording, decides it.
      const framework = /refusalHandling/.test(thrown(() => new Agent(config, {} as never, {} as never)) ?? '');
      expect({ value, refused: host }).toEqual({ value, refused: framework });
    }
  });
});
