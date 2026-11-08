import { expect, test } from 'bun:test';
import { handleCommand } from '../src/commands.js';
import { validateRecipe } from '../src/recipe.js';

test('a recipe\'s modules.setup is true or false, and anything else is refused as the recipe loads', () => {
  const recipe = (setup: unknown) => ({ name: 'setup', agent: { systemPrompt: 'sys' }, modules: { setup } });
  expect(() => validateRecipe(recipe('true'))).toThrow('modules.setup must be true or false');
  expect(validateRecipe(recipe(true)).modules?.setup).toBe(true);
  expect(validateRecipe(recipe(false)).modules?.setup).toBe(false);
});

type App = Parameters<typeof handleCommand>[1];

const app = (modules: Record<string, unknown>): App => ({
  framework: {} as never,
  sessionManager: { getActiveSession: () => undefined } as never,
  recipe: { name: 'r', modules } as never,
  branchState: { checkpoints: new Map(), undoStack: [], redoStack: [] } as never,
  switchSession: async () => {},
});

test('in setup, /help lists what a person needs there: leaving, a new conversation, and help, and nothing else', () => {
  expect(handleCommand('/help', app({ setup: true })).lines.map((line) => line.text)).toEqual([
    '--- In setup ---',
    '  /quit                  Leave setup. Setup then says how to go on where it stopped.',
    '  /session new           Start a new conversation with setup\'s agent. What setup has done stays on disk.',
    '  /help                  This list',
  ]);
});

test('a host that isn\'t setup\'s still lists its commands', () => {
  const lines = handleCommand('/help', app({})).lines.map((line) => line.text);
  expect(lines[0]).toBe('--- Commands ---');
  expect(lines.some((line) => line.startsWith('  /undo '))).toBe(true);
});
