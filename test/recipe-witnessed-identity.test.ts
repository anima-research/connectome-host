/**
 * A resident with reviewed inherited history: the recipe's witnessed and
 * live reminders reach the context-manager strategy unchanged
 * (witnessedIdentityReminder / identityReminder / identityReminderSilent).
 */
import { describe, expect, test } from 'bun:test';
import { buildFrameworkStrategy } from '../src/framework-strategy.js';
import { validateRecipe } from '../src/recipe.js';

const config = (s: object) => (s as { config?: Record<string, unknown> }).config ?? {};

describe('witnessed / live identity reminders', () => {
  test('pass through to the strategy exactly', () => {
    const strategy = {
      type: 'autobiographical',
      witnessedBeforeSequence: 12409,
      witnessedInstruction: 'W-INSTR {targetTokens}',
      witnessedIdentityReminder: 'W-REMINDER',
      identityReminder: 'LIVE-REMINDER',
      identityReminderSilent: true,
      summaryParticipant: 'Sol',
    };
    const built = config(buildFrameworkStrategy(
      validateRecipe({ name: 't', agent: { name: 'Sol', systemPrompt: 's', strategy } }),
      'm', 'UTC',
    ));
    for (const [k, v] of Object.entries(strategy)) {
      if (k !== 'type') expect(built[k]).toEqual(v);
    }
  });

  test('absent: nothing new appears', () => {
    const built = config(buildFrameworkStrategy(
      validateRecipe({ name: 't', agent: { name: 'A', systemPrompt: 's', strategy: { type: 'autobiographical', identityReminder: 'R' } } }),
      'm', 'UTC',
    ));
    expect(built.witnessedIdentityReminder).toBeUndefined();
    expect(built.identityReminderSilent).toBeUndefined();
  });
});
