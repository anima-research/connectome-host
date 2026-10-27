import { describe, test, expect } from 'bun:test';
import { shortAgentName } from '../src/tui.js';

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

  test('numeric parts of requested names survive fork and spawn suffixes', () => {
    expect(shortAgentName('web-1-d1-1700000000000')).toBe('web-1');
    expect(shortAgentName('web-1-d2-retry1-1700000000001')).toBe('web-1');
    expect(shortAgentName('spawn-web-1-1700000000002')).toBe('web-1');
  });

  test('a requested name that looks like a fork envelope, a retry or a prefix keeps it', () => {
    expect(shortAgentName('spawn-build-d2-1700000000003')).toBe('build-d2');
    expect(shortAgentName('spawn-web-retry1-1700000000004')).toBe('web-retry1');
    expect(shortAgentName('step-d1-d1-1700000000005')).toBe('step-d1');
    expect(shortAgentName('fork-1-d1-1700000000006')).toBe('fork-1');
    expect(shortAgentName('fork-1-d1-retry2-1700000000007')).toBe('fork-1');
  });

  test('a name in none of these shapes comes back whole', () => {
    expect(shortAgentName('helper-2')).toBe('helper-2');
    expect(shortAgentName('web-1')).toBe('web-1');
    expect(shortAgentName('fork-web')).toBe('fork-web');
    expect(shortAgentName('web-retry2')).toBe('web-retry2');
    expect(shortAgentName('helper-retry2')).toBe('helper-retry2');
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
