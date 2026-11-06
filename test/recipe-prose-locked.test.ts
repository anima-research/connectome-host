import { describe, expect, test } from 'bun:test';
import { buildFrameworkAgentConfig } from '../src/framework-agent-config.js';
import { validateRecipe } from '../src/recipe.js';
import { setupFacts } from '../src/bug-report.js';

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

  test('refuses a proseLock outside locked routing, which would ignore it', () => {
    expect(() => validateRecipe(recipe({ proseLock: '#lounge' }))).toThrow(
      'Recipe agent.proseLock requires agent.proseRouting "locked", got no proseRouting (locus).',
    );
    expect(() => validateRecipe(recipe({ proseRouting: 'locus', proseLock: 'drafts' }))).toThrow(
      'Recipe agent.proseLock requires agent.proseRouting "locked", got "locus".',
    );
  });

  test('refuses locked routing with no proseLock and an allowedTools list without prose_locus, which would hold its speech as drafts for good', () => {
    const refusal =
      'Recipe agent.proseRouting "locked" without agent.proseLock needs agent.allowedTools to name "prose_locus": ' +
      "otherwise the agent can't move its prose lock, so its plain text stays held as drafts, or where it chose before, on every turn. " +
      'Add "prose_locus" to allowedTools (and "drafts", to resend drafts), or, for an agent that hasn\'t chosen yet, set agent.proseLock ' +
      '("drafts" to hold plain text on purpose); a choice it has made stays until prose_locus moves it.';
    for (const allowedTools of [['send_message', 'drafts'], []]) {
      expect(() => validateRecipe(recipe({ proseRouting: 'locked', allowedTools }))).toThrow(refusal);
    }
    expect(built({ proseRouting: 'locked', proseLock: '#lounge', allowedTools: ['send_message'] }).proseLock).toBe('#lounge');
    expect(built({ proseRouting: 'locked', proseLock: 'drafts', allowedTools: [] }).proseLock).toBe('drafts');
    expect(built({ proseRouting: 'locked', allowedTools: ['send_message', 'prose_locus'] }).proseRouting).toBe('locked');
    expect(built({ proseRouting: 'locked', allowedTools: 'all' }).proseRouting).toBe('locked');
    expect(built({ proseRouting: 'locked' }).proseRouting).toBe('locked');
    expect(built({ proseRouting: 'locus', allowedTools: ['send_message'] }).proseRouting).toBe('locus');
  });

  test('refuses locked routing beside conversations, whose forks answer the channels as locus mode does', () => {
    const withConversations = (agent: Record<string, unknown>) => ({ ...recipe(agent), conversations: {} });
    expect(() => validateRecipe(withConversations({ proseRouting: 'locked', proseLock: '#lounge' }))).toThrow(
      'Recipe agent.proseRouting "locked" can\'t be combined with conversations: the forks that answer each channel ' +
        'speak in their home channel, as in locus mode, so the lock would not govern their replies.',
    );
    expect(validateRecipe(withConversations({ proseRouting: 'disabled' })).agent.proseRouting).toBe('disabled');
  });

  test('names locked among the modes it refuses another for', () => {
    expect(() => validateRecipe(recipe({ proseRouting: 'pinned' }))).toThrow(
      `Recipe agent.proseRouting must be 'locus', 'explicit', 'hybrid', 'disabled', or 'locked', got "pinned".`,
    );
  });

  test('a bug report keeps locked as the resident\'s mode', () => {
    expect(setupFacts({ agent: { proseRouting: 'locked' } } as never).proseRouting).toBe('locked');
    expect(setupFacts({ agent: { proseRouting: 'pinned' } } as never).proseRouting).toBeNull();
  });
});
