import { describe, test, expect } from 'bun:test';
import { validateRecipe } from '../src/recipe.js';

function recipeWithSource(source: unknown) {
  return {
    name: 'source-test',
    agent: { systemPrompt: 'sys' },
    mcpServers: {
      srv: {
        command: 'npx',
        args: ['-y', 'some-pkg'],
        ...(source !== undefined ? { source } : {}),
      },
    },
  };
}

describe('mcpServers source validation', () => {
  test('accepts the git url form', () => {
    expect(() => validateRecipe(recipeWithSource({
      url: 'https://github.com/x/y.git',
      install: 'npm',
    }))).not.toThrow();
  });

  test('accepts the npm registry form', () => {
    expect(() => validateRecipe(recipeWithSource({
      npm: '@zereight/mcp-gitlab@2.1.25',
    }))).not.toThrow();
  });

  test('rejects a source with neither url nor npm', () => {
    expect(() => validateRecipe(recipeWithSource({ install: 'npm' })))
      .toThrow(/source must have a non-empty "url" \(git clone\) or "npm"/);
  });

  test('rejects a source with both url and npm', () => {
    expect(() => validateRecipe(recipeWithSource({
      url: 'https://github.com/x/y.git',
      npm: 'y@1.0.0',
    }))).toThrow(/must not set both "url" and "npm"/);
  });

  test('rejects empty-string url and npm', () => {
    expect(() => validateRecipe(recipeWithSource({ url: '' }))).toThrow(/source/);
    expect(() => validateRecipe(recipeWithSource({ npm: '' }))).toThrow(/source/);
  });
});
