import { describe, expect, test } from 'bun:test';
import { validateRecipe } from '../src/recipe.js';

function recipe(ttsRelay: Record<string, unknown>) {
  return {
    name: 'tts-relay-test',
    agent: { systemPrompt: 'test' },
    modules: { ttsRelay: { url: 'ws://127.0.0.1:8800/bot', token: 't', ...ttsRelay } },
  };
}

describe('recipe modules.ttsRelay.editServerId', () => {
  test('is refused unless it names a server', () => {
    for (const editServerId of ['', 5]) {
      expect(() => validateRecipe(recipe({ editServerId }))).toThrow(/modules\.ttsRelay\.editServerId must be a non-empty string/);
    }
  });

  test('accepts any server key', () => {
    expect(validateRecipe(recipe({ editServerId: 'discord-main' })).modules?.ttsRelay).toMatchObject({ editServerId: 'discord-main' });
  });
});
