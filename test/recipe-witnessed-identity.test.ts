/**
 * A resident with reviewed inherited history: the recipe's witnessed and
 * live reminders reach the context-manager strategy unchanged
 * (witnessedIdentityReminder / identityReminder). identityReminderSilent is
 * retired: a reminder that should apply silently ends with its own sentence.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { PassthroughStrategy } from '@animalabs/agent-framework';
import { buildFrameworkStrategy } from '../src/framework-strategy.js';
import type { ExtensionRegistry } from '../src/extensions.js';
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
  });

  let warn: ReturnType<typeof spyOn> | undefined;
  afterEach(() => { warn?.mockRestore(); warn = undefined; });

  test('identityReminderSilent: the recipe loads, the warning names what replaced it, and the strategy gets nothing for it', () => {
    warn = spyOn(console, 'warn').mockImplementation(() => {});
    const recipe = validateRecipe({
      name: 't',
      agent: { name: 'A', systemPrompt: 's', strategy: { type: 'autobiographical', identityReminder: 'R', identityReminderSilent: true } },
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain(
      'agent.strategy.identityReminderSilent (replaced by a sentence asking for silence at the end of each reminder ' +
      'the recipe sets, agent.strategy.identityReminder and agent.strategy.witnessedIdentityReminder, if it was true; ' +
      'if it was false, nothing)',
    );
    const built = config(buildFrameworkStrategy(recipe, 'm', 'UTC'));
    expect(built.identityReminder).toBe('R');
    expect('identityReminderSilent' in built).toBe(false);
  });

  test('an extension strategy gets identityReminderSilent with the rest of its config, and no warning calls it ignored', () => {
    warn = spyOn(console, 'warn').mockImplementation(() => {});
    const recipe = validateRecipe({
      name: 't',
      agent: { name: 'A', systemPrompt: 's', strategy: { type: 'custom', identityReminderSilent: true } },
      extensions: { custom: { kind: 'strategy', path: './unused.ts' } },
    });
    expect(warn).not.toHaveBeenCalled();
    let received: Record<string, unknown> | undefined;
    const registry: ExtensionRegistry = {
      strategies: new Map([['custom', ({ config: given }) => { received = given; return new PassthroughStrategy(); }]]),
      modules: [],
    };
    buildFrameworkStrategy(recipe, 'm', 'UTC', registry);
    expect(received?.identityReminderSilent).toBe(true);
  });
});
