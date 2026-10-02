/**
 * The host owns timezone and explicit server env. AgentFramework supplies
 * its reaction default later, when configured and retained markers are known.
 */
import { describe, test, expect } from 'bun:test';
import { composeMcplChildEnv } from '../src/mcpl-config.js';

describe('composeMcplChildEnv', () => {
  test('leaves the reaction default to framework composition', () => {
    const env = composeMcplChildEnv({ SOME_VAR: 'x' }, 'UTC');
    expect(Object.hasOwn(env, 'DISCORD_SUPPRESSED_REACTIONS_BASELINE')).toBe(false);
    expect(env.SOME_VAR).toBe('x');
  });

  test('absent server env carries only the resolved timezone', () => {
    expect(composeMcplChildEnv(undefined, 'UTC')).toEqual({ AGENT_TIMEZONE: 'UTC' });
  });

  test('preserves an operator-set baseline on the server entry', () => {
    const env = composeMcplChildEnv(
      { DISCORD_SUPPRESSED_REACTIONS_BASELINE: '🈲' },
      'UTC',
    );
    expect(env.DISCORD_SUPPRESSED_REACTIONS_BASELINE).toBe('🈲');
  });

  test('operator empty-string baseline is preserved, not re-defaulted', () => {
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

  test('adds nothing beyond the host-owned timezone', () => {
    const env = composeMcplChildEnv({ A: '1' }, 'UTC');
    expect(Object.keys(env).sort()).toEqual(['A', 'AGENT_TIMEZONE']);
  });
});
