import { describe, expect, test } from 'bun:test';
import { buildContextCoverageSnapshot } from '../src/modules/web-ui-module.js';

function contextManager(strategy: Record<string, unknown>) {
  return {
    currentBranch: () => ({ name: 'test-branch' }),
    getStrategy: () => strategy,
    getPendingWork: () => ({ description: 'Compressing chunk 2' }),
  };
}

describe('context coverage snapshot', () => {
  test('reports unbounded summary depth, selected depth, and queued work without text', () => {
    const summaries = [
      { id: 'L1-1', level: 1, content: 'secret one', tokens: 100, mergedInto: 'L2-3' },
      { id: 'L1-2', level: 1, content: 'secret two', tokens: 120, mergedInto: 'L2-3' },
      { id: 'L2-3', level: 2, content: 'secret parent', tokens: 80, mergedInto: 'L4-4' },
      { id: 'L4-4', level: 4, content: 'secret root', tokens: 40 },
    ];
    const chunks = [
      { index: 0, tokens: 300, compressed: true, summaryId: 'L1-1', messages: [{ id: 'm1' }, { id: 'm2' }] },
      { index: 1, tokens: 200, compressed: true, summaryId: 'L1-2', messages: [{ id: 'm3' }] },
      { index: 2, tokens: 250, compressed: false, messages: [{ id: 'm4' }] },
    ];
    const snapshot = buildContextCoverageSnapshot('fable', contextManager({
      summaries,
      chunks,
      compressionQueue: [2],
      mergeQueue: [{ level: 3, sourceIds: ['L2-a', 'L2-b'] }],
      resolutions: new Map([['m1', 4], ['m2', 2], ['m3', 1]]),
      pendingCompression: Promise.resolve(),
    }));

    expect(snapshot.branch).toBe('test-branch');
    expect(snapshot.levels.map(level => level.level)).toEqual([1, 2, 4]);
    expect(snapshot.chunks[0]).toMatchObject({ maxLevel: 4, selectedMin: 2, selectedMax: 4 });
    expect(snapshot.chunks[2]).toMatchObject({ maxLevel: 0, queued: true });
    expect(snapshot.queue).toMatchObject({
      inFlight: true,
      pending: 'Compressing chunk 2',
      l1: [2],
      merges: [{ targetLevel: 3, sourceCount: 2 }],
    });
    expect(JSON.stringify(snapshot)).not.toContain('secret');
    expect(JSON.stringify(snapshot)).not.toContain('content');
  });

  test('stops coverage traversal at a dangling parent', () => {
    const snapshot = buildContextCoverageSnapshot('fable', contextManager({
      summaries: [{ id: 'L1-1', level: 1, tokens: 100, mergedInto: 'missing-L2' }],
      chunks: [{ index: 0, tokens: 200, compressed: true, summaryId: 'L1-1', messages: [{ id: 'm1' }] }],
      compressionQueue: [],
      mergeQueue: [],
      resolutions: new Map(),
      pendingCompression: null,
    }));

    expect(snapshot.chunks[0].maxLevel).toBe(1);
    expect(snapshot.queue.inFlight).toBe(false);
  });
});
