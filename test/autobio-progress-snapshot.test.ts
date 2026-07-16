import { describe, test, expect } from 'bun:test';
import { AutobiographicalStrategy } from '@animalabs/agent-framework';
import { ContextManager } from '@animalabs/context-manager';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function initializedStrategy() {
  const path = mkdtempSync(join(tmpdir(), 'autobio-progress-'));
  const strategy = new AutobiographicalStrategy({
    compressionModel: 'claude-sonnet-4-5-20250929',
    autoTickOnNewMessage: false,
  });
  const cm = await ContextManager.open({ path, strategy });
  return {
    strategy,
    close: () => {
      cm.close();
      rmSync(path, { recursive: true, force: true });
    },
  };
}

// Guards against silent breakage if upstream renames the protected fields
// that getProgressSnapshot reads. The shape is what warmup-session.ts relies on.
describe('AutobiographicalStrategy.getProgressSnapshot', () => {
  test('returns the expected shape after branch state is initialized', async () => {
    const { strategy, close } = await initializedStrategy();
    const snapshot = strategy.getProgressSnapshot();
    expect(snapshot).toEqual({
      totalChunks: 0,
      chunksCompressed: 0,
      l1QueueLength: 0,
      mergeQueueLength: 0,
      summaryCounts: { l1: 0, l2: 0, l3: 0 },
      pending: false,
    });
    close();
  });

  test('exposes the keys warmup-session.ts depends on', async () => {
    const { strategy, close } = await initializedStrategy();
    const s = strategy.getProgressSnapshot();
    expect(typeof s.totalChunks).toBe('number');
    expect(typeof s.chunksCompressed).toBe('number');
    expect(typeof s.l1QueueLength).toBe('number');
    expect(typeof s.mergeQueueLength).toBe('number');
    expect(typeof s.pending).toBe('boolean');
    expect(typeof s.summaryCounts.l1).toBe('number');
    expect(typeof s.summaryCounts.l2).toBe('number');
    expect(typeof s.summaryCounts.l3).toBe('number');
    close();
  });
});
