import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework } from '@animalabs/agent-framework';
import { Membrane, MockAdapter } from '@animalabs/membrane';
import { DEFAULT_RECIPE, validateRecipe, type Recipe } from '../src/recipe.js';
import { buildFrameworkStrategy } from '../src/framework-strategy.js';
import { buildFrameworkAgentConfig, codeExecutionOption } from '../src/framework-agent-config.js';

const MODEL = 'claude-opus-4-6';

// Boots the framework from a recipe the way src/index.ts does for these
// options: the agent config, and code execution through codeExecutionOption.
async function toolNames(recipe: Recipe): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), 'code-execution-option-'));
  let framework: AgentFramework | undefined;
  try {
    const strategy = buildFrameworkStrategy(recipe, MODEL, 'UTC');
    framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: new Membrane(new MockAdapter()),
      agents: [buildFrameworkAgentConfig(recipe, 'agent', MODEL, strategy)],
      modules: [],
      ...codeExecutionOption(recipe),
    });
    return framework.getAllTools().map((tool) => tool.name);
  } finally {
    if (framework) await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

function withCodeExecution(codeExecution: Recipe['codeExecution']): Recipe {
  return validateRecipe({ ...structuredClone(DEFAULT_RECIPE), codeExecution });
}

describe('codeExecutionOption', () => {
  test('a recipe with codeExecution.enabled true offers the code_execution tool', async () => {
    const recipe = withCodeExecution({ enabled: true });
    expect(codeExecutionOption(recipe)).toEqual({ codeExecution: { enabled: true } });
    expect(await toolNames(recipe)).toContain('code_execution');
  });

  test('codeExecution.enabled false offers no code_execution tool', async () => {
    expect(await toolNames(withCodeExecution({ enabled: false }))).not.toContain('code_execution');
  });

  test('the built-in default recipe leaves code execution off', async () => {
    const recipe = validateRecipe(structuredClone(DEFAULT_RECIPE));
    expect(recipe.codeExecution).toBeUndefined();
    expect(codeExecutionOption(recipe)).toEqual({});
    expect(await toolNames(recipe)).not.toContain('code_execution');
  });
});
