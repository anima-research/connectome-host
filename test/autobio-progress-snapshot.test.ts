import { describe, test, expect } from 'bun:test';
import { AutobiographicalStrategy } from '@animalabs/agent-framework';
import { ContextManager } from '@animalabs/context-manager';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function initializedStrategy() {
  const root = mkdtempSync(join(tmpdir(), 'autobio-progress-'));
  const path = join(root, 'store');
  const strategy = new AutobiographicalStrategy({
    compressionModel: 'claude-sonnet-4-5-20250929',
    autoTickOnNewMessage: false,
  });
  const cm = await ContextManager.open({ path, strategy });
  return {
    strategy,
    close: () => {
      cm.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe('AutobiographicalStrategy.getProgressSnapshot', () => {
  test('exposes the keys warmup-session.ts depends on, with nothing queued in an empty store, which it reads as already converged', async () => {
    const { strategy, close } = await initializedStrategy();
    const s = strategy.getProgressSnapshot();
    expect(typeof s.totalChunks).toBe('number');
    expect(typeof s.chunksCompressed).toBe('number');
    expect(typeof s.l1QueueLength).toBe('number');
    expect(typeof s.mergeQueueLength).toBe('number');
    expect(typeof s.pending).toBe('boolean');
    expect([s.l1QueueLength, s.mergeQueueLength]).toEqual([0, 0]);
    expect(typeof s.summaryCounts.l1).toBe('number');
    expect(typeof s.summaryCounts.l2).toBe('number');
    expect(typeof s.summaryCounts.l3).toBe('number');
    close();
  });
});
