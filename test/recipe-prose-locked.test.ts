import { describe, expect, test } from 'bun:test';
import { buildFrameworkAgentConfig } from '../src/framework-agent-config.js';
import { validateRecipe } from '../src/recipe.js';

const recipe = (agent: Record<string, unknown>) => ({ name: 'locked', agent: { systemPrompt: 'sys', ...agent } });
const built = (agent: Record<string, unknown>) =>
  buildFrameworkAgentConfig(validateRecipe(recipe(agent)), 'a', 'm', { kind: 's' } as never);

describe('locked prose routing recipe wiring', () => {
  test('passes proseRouting "locked" and proseLock through to AgentConfig', () => {
    const config = built({ proseRouting: 'locked', proseLock: '#lounge' });
    expect(config.proseRouting).toBe('locked');
    expect(config.proseLock).toBe('#lounge');
    expect(built({ proseRouting: 'locked', proseLock: 'drafts' }).proseLock).toBe('drafts');
    expect('proseLock' in built({ proseRouting: 'locked' })).toBe(false);
  });

  test('refuses a proseLock that names nothing', () => {
    for (const proseLock of ['', '   ', 7, null, ['#lounge']]) {
      expect(() => validateRecipe(recipe({ proseRouting: 'locked', proseLock }))).toThrow(
        `Recipe agent.proseLock must be "#channel", "@person", a channel id or "drafts", got ${JSON.stringify(proseLock)}.`,
      );
    }
  });

  test('names locked among the modes it refuses another for', () => {
    expect(() => validateRecipe(recipe({ proseRouting: 'pinned' }))).toThrow(
      `Recipe agent.proseRouting must be 'locus', 'explicit', 'hybrid', 'disabled', or 'locked', got "pinned".`,
    );
  });
});
