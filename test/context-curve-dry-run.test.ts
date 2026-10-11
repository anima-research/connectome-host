/**
 * The context curve panel shows a compile and never sends it, so the compile
 * is a dry run: it must not commit fold resolutions, queue compression work,
 * or (with context-manager's thinking binding) fence the resident's stream.
 * Ada-1017's finding for context-manager #155.
 */
import { describe, expect, test } from 'bun:test';
import { buildContextCurve, type PanelAppRef } from '../src/web/panel-data.js';

function appWith(compile: (...args: unknown[]) => Promise<unknown>): PanelAppRef {
  const cm = {
    compile,
    getMessageCount: () => 1,
    getMessageWindow: () => ({ messages: [{ id: 'm1', timestamp: '2026-10-10T21:00:00Z', content: [{ type: 'text', text: 'hello' }] }] }),
    getStrategy: () => ({ summaries: [] }),
    currentBranch: () => ({ name: 'main' }),
  };
  return {
    framework: {
      getAgent: (name: string) => (name === 'scout' ? { getContextManager: () => cm } : undefined),
      getAgentRuntimeSettings: () => ({ contextBudgetTokens: 150_000 }),
    },
    recipe: { agent: { maxTokens: 8_000 } },
  } as unknown as PanelAppRef;
}

describe('the context curve', () => {
  test('compiles as a dry run, at the live budget', async () => {
    const calls: unknown[][] = [];
    const app = appWith(async (...args: unknown[]) => {
      calls.push(args);
      return { messages: [{ participant: 'scout', content: [{ type: 'text', text: 'hello' }], sourceMessageId: 'm1' }] };
    });

    const curve = await buildContextCurve(app, 'scout');

    expect(calls).toEqual([[{ maxTokens: 150_000, reserveForResponse: 8_000 }, undefined, { dryRun: true }]]);
    expect(curve.totals).toEqual({ entries: 1, rendered: 2, rawCovered: 2 });
  });
});
