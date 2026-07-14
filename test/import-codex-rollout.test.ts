import { describe, expect, test } from 'bun:test';
import {
  projectItem,
  reconstructEffectiveHistory,
} from '../scripts/import-codex-rollout.js';

describe('Codex rollout import', () => {
  test('uses replacement_history as the authoritative compaction boundary', () => {
    const history = reconstructEffectiveHistory([
      { type: 'response_item', payload: { type: 'message', id: 'discarded' } },
      {
        type: 'compacted', timestamp: '2026-07-13T00:00:00Z',
        payload: { replacement_history: [
          { type: 'message', role: 'user', content: 'kept' },
          { type: 'compaction', id: 'cmp_1', encrypted_content: 'opaque' },
        ] },
      },
      { type: 'response_item', payload: { type: 'reasoning', id: 'rs_2', encrypted_content: 'tail' } },
    ]);

    expect(history.map(entry => entry.item.id ?? entry.item.type)).toEqual([
      'message', 'cmp_1', 'rs_2',
    ]);
    expect(history[0]!.restoredByCompaction).toBe(true);
    expect(history[2]!.restoredByCompaction).toBe(false);
  });

  test('keeps the exact native item on the Chronicle projection block', () => {
    const item = {
      type: 'message', id: 'msg_1', role: 'assistant', phase: 'commentary',
      content: [{ type: 'output_text', text: 'hello' }],
    };
    const [block] = projectItem(item);
    expect(block).toMatchObject({ type: 'text', text: 'hello', rawItem: item });
  });
});
