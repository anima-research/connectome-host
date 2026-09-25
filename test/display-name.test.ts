/**
 * agent.displayName is PRESENTATION ONLY (Sol, 2026-09-25). Setting or
 * changing it must leave the technical namespace, the memory strategy, the
 * framework agent config (so Chronicle participants), and therefore existing
 * history untouched; diagnostics show both names.
 */
import { describe, expect, test } from 'bun:test';
import { validateRecipe } from '../src/recipe.js';
import { agentDisplayName } from '../src/display-name.js';
import { buildFrameworkStrategy } from '../src/framework-strategy.js';
import { buildFrameworkAgentConfig } from '../src/framework-agent-config.js';
import { buildHealthSnapshot } from '../src/web/panel-data.js';

const base = (displayName?: string) => validateRecipe({
  name: 'sol',
  agent: {
    name: 'Sol', systemPrompt: 'sys', ...(displayName !== undefined ? { displayName } : {}),
    strategy: { type: 'autobiographical', witnessedBeforeSequence: 12409, identityReminder: 'LIVE', witnessedIdentityReminder: 'W' },
  },
});
const strategyConfig = (r: ReturnType<typeof base>) =>
  (buildFrameworkStrategy(r, 'm', 'UTC') as unknown as { config: Record<string, unknown> }).config;
const agentConfig = (r: ReturnType<typeof base>) => {
  const cfg = buildFrameworkAgentConfig(r, 'Sol', 'm', buildFrameworkStrategy(r, 'm', 'UTC')) as unknown as Record<string, unknown>;
  const { strategy: _s, ...rest } = cfg;
  return rest;
};

describe('agent.displayName', () => {
  test('defaults to the technical name; applies only to the recipe agent', () => {
    expect(agentDisplayName(base(), 'Sol')).toBe('Sol');
    expect(agentDisplayName(base('Sol (provisional)'), 'Sol')).toBe('Sol (provisional)');
    expect(agentDisplayName(base('Sol (provisional)'), 'spawn-research-1')).toBe('spawn-research-1');
  });

  test('changing it leaves the memory strategy byte-identical (namespace, participant, reminders)', () => {
    const a = strategyConfig(base());
    const b = strategyConfig(base('Sol (provisional)'));
    const c = strategyConfig(base('Someday Another Name'));
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(JSON.stringify(c)).toBe(JSON.stringify(a));
    expect(b.summaryParticipant).toBe('Sol');
  });

  test('changing it leaves the framework agent config identical (Chronicle participant stays Sol)', () => {
    const a = agentConfig(base());
    const b = agentConfig(base('Sol (provisional)'));
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(b.name).toBe('Sol');
  });

  test('diagnostics show both: technical name kept, display name beside it', () => {
    const app = {
      recipe: base('Sol (provisional)'),
      framework: { healthSnapshot: () => ({ agents: [{ name: 'Sol', status: 'idle' }] }), getAllAgents: () => [] },
    } as never;
    const h = buildHealthSnapshot(app) as { agents: Array<Record<string, unknown>> };
    expect(h.agents[0]!.name).toBe('Sol');
    expect(h.agents[0]!.displayName).toBe('Sol (provisional)');
  });

  test('validation: single line, 1-80 characters', () => {
    for (const bad of ['', '   ', 'a\nb', 'x'.repeat(81), 3]) {
      expect(() => validateRecipe({ name: 'r', agent: { systemPrompt: 's', displayName: bad } })).toThrow(/displayName/);
    }
  });
});
