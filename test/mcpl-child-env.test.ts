/**
 * Host composition of stdio MCPL child env (composeMcplChildEnv): the
 * framework's refusal-annotation baseline is injected for never-configured
 * deployments, and an operator's explicit value always supersedes it — the
 * host provides a default, never overrides a decision. The enforced
 * precedence below this (file key incl. [] → legacy operator env → baseline)
 * lives in the Discord adapter; what the host owns is that the injected
 * value is EXACTLY the set the framework stamps (REFUSAL_REACTION_BASELINE,
 * comma-joined) and that it rides in env — process plumbing below the model
 * line, never agent-visible text.
 */
import { describe, test, expect } from 'bun:test';
import { REFUSAL_REACTION_BASELINE } from '@animalabs/agent-framework';
import { composeMcplChildEnv } from '../src/mcpl-config.js';

const BASELINE = REFUSAL_REACTION_BASELINE.join(',');

describe('composeMcplChildEnv', () => {
  test('injects the framework baseline when the server entry does not set it', () => {
    const env = composeMcplChildEnv({ SOME_VAR: 'x' }, 'UTC');
    expect(env.DISCORD_SUPPRESSED_REACTIONS_BASELINE).toBe(BASELINE);
    expect(env.SOME_VAR).toBe('x');
  });

  test('injected value round-trips to the exact framework annotation set', () => {
    const env = composeMcplChildEnv(undefined, 'UTC');
    expect(env.DISCORD_SUPPRESSED_REACTIONS_BASELINE!.split(',')).toEqual([
      ...REFUSAL_REACTION_BASELINE,
    ]);
    expect(REFUSAL_REACTION_BASELINE.length).toBeGreaterThan(0);
  });

  test('operator-set baseline on the server entry supersedes the house value', () => {
    const env = composeMcplChildEnv(
      { DISCORD_SUPPRESSED_REACTIONS_BASELINE: '🈲' },
      'UTC',
    );
    expect(env.DISCORD_SUPPRESSED_REACTIONS_BASELINE).toBe('🈲');
  });

  test('operator empty-string baseline is preserved, not re-defaulted', () => {
    // An operator who explicitly set the var to empty chose "no baseline";
    // the house value must not reappear underneath that decision.
    const env = composeMcplChildEnv(
      { DISCORD_SUPPRESSED_REACTIONS_BASELINE: '' },
      'UTC',
    );
    expect(env.DISCORD_SUPPRESSED_REACTIONS_BASELINE).toBe('');
  });

  test('AGENT_TIMEZONE stays host-resolved (recipe wall clock, not a per-server knob)', () => {
    const env = composeMcplChildEnv({ AGENT_TIMEZONE: 'Mars/Olympus' }, 'America/Los_Angeles');
    expect(env.AGENT_TIMEZONE).toBe('America/Los_Angeles');
  });

  test('adds nothing beyond the two host-owned keys', () => {
    const env = composeMcplChildEnv({ A: '1' }, 'UTC');
    expect(Object.keys(env).sort()).toEqual([
      'A',
      'AGENT_TIMEZONE',
      'DISCORD_SUPPRESSED_REACTIONS_BASELINE',
    ]);
  });
});
