/**
 * src/history-semantic.ts — the createFramework seam for modules.history
 * (Anarchid #1, #2, #9 on PR #144): namespace is always per-session, an
 * explicit namespace is a PREFIX, host-only keys never reach the framework,
 * and a configured-but-missing semantic_search tool fails startup.
 */
import { describe, test, expect } from 'bun:test';
import { HistoryModule } from '@animalabs/agent-framework';
import { historyModuleOptions, assertSemanticSearchRegistered } from '../src/history-semantic.js';

const url = 'http://100.90.161.34:8804';

describe('historyModuleOptions', () => {
  test('boolean / no semantic → no semantic config', () => {
    expect(historyModuleOptions(true, 'Linn', 'abc')).toEqual({});
    expect(historyModuleOptions({}, 'Linn', 'abc')).toEqual({});
  });

  test('default namespace is <agent>/<sessionId>', () => {
    expect(historyModuleOptions({ semantic: { url } }, 'Linn', '9f9857cd').semantic?.namespace).toBe('Linn/9f9857cd');
  });

  test('explicit namespace is a prefix: two sessions never share an index', () => {
    const a = historyModuleOptions({ semantic: { url, namespace: 'linn' } }, 'Linn', 'aaaa').semantic!;
    const b = historyModuleOptions({ semantic: { url, namespace: 'linn' } }, 'Linn', 'bbbb').semantic!;
    expect(a.namespace).toBe('linn/aaaa');
    expect(b.namespace).toBe('linn/bbbb');
  });

  test('passes only framework keys; allowInsecureHttp stays host-side', () => {
    const s = historyModuleOptions({ semantic: { url, token: 't', syncIntervalMs: 0, maxSyncPerTick: 5, maxSyncBeforeSearch: 6, includePrivateTools: false, allowInsecureHttp: true } }, 'A', 's').semantic!;
    expect(s).toEqual({ url, token: 't', namespace: 'A/s', syncIntervalMs: 0, maxSyncPerTick: 5, maxSyncBeforeSearch: 6, includePrivateTools: false });
  });
});

describe('assertSemanticSearchRegistered', () => {
  test('passes when the installed framework offers semantic_search', () => {
    const m = new HistoryModule(historyModuleOptions({ semantic: { url } }, 'A', 's'));
    expect(() => assertSemanticSearchRegistered(m, true)).not.toThrow();
  });

  test('throws, naming the required version, when semantic is configured but the tool is missing', () => {
    const stale = { getTools: () => [{ name: 'stats' }, { name: 'extract' }, { name: 'search' }, { name: 'overview' }] };
    expect(() => assertSemanticSearchRegistered(stale, true)).toThrow(/semantic_search.*@animalabs\/agent-framework.*0\.20\.0/);
  });

  test('no-op when semantic is not configured', () => {
    const stale = { getTools: () => [{ name: 'stats' }] };
    expect(() => assertSemanticSearchRegistered(stale, false)).not.toThrow();
  });
});
