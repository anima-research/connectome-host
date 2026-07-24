import { describe, test, expect } from 'bun:test';
import { shortAgentName } from '../src/tui.js';

// Guards full↔short agent-name resolution against the naming schemes the
// SubagentModule actually produces (see its spawn/fork paths). A helper that
// misses one scheme silently breaks fleet-tree attribution for that agent
// type — forks slipped through exactly this way once.
describe('shortAgentName', () => {
  test('spawn names: spawn-{name}-{ts}', () => {
    expect(shortAgentName('spawn-web-1753221234567')).toBe('web');
    expect(shortAgentName('spawn-zulip-reader-1753221234567')).toBe('zulip-reader');
  });

  test('fork names: {name}-d{depth}-{ts}, no fork- prefix', () => {
    expect(shortAgentName('web-d1-1753221234567')).toBe('web');
    expect(shortAgentName('zulip-reader-d3-1753221234567')).toBe('zulip-reader');
  });

  test('fork retry names: {name}-d{depth}-retry{n}-{ts}', () => {
    expect(shortAgentName('web-d2-retry1-1753221234567')).toBe('web');
  });

  test('bare trailing -retryN (historical defensive strip)', () => {
    expect(shortAgentName('web-retry2')).toBe('web');
  });

  test('names that are substrings of each other stay distinct', () => {
    expect(shortAgentName('websearch-d1-1753221234567')).toBe('websearch');
    expect(shortAgentName('spawn-websearch-1753221234567')).toBe('websearch');
  });

  test('plain names pass through', () => {
    expect(shortAgentName('miner')).toBe('miner');
    expect(shortAgentName('web')).toBe('web');
  });
});
