import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextManager } from '@animalabs/context-manager';
import { buildFrameworkStrategy } from '../src/framework-strategy.js';
import { validateRecipe } from '../src/recipe.js';

const LABEL = "A summary follows, standing in for earlier conversation, tool calls and results included. The exact text it replaces isn't shown.";

type Entry = { participant: string; content: Array<{ type: string; text?: string }> };

const textOf = (e: Entry): string => e.content.map((b) => b.text ?? '').join('');

describe('the label before a folded summary', () => {
  test("an agent whose recipe sets no label reads the host's sentence before each summary, which follows as its own turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'summary-label-'));
    try {
      const recipe = validateRecipe({
        name: 'summary-label',
        agent: {
          name: 'Mira',
          systemPrompt: 's',
          strategy: { type: 'autobiographical', targetChunkTokens: 100, recentWindowTokens: 200, headWindowTokens: 0, mergeThreshold: 3, compressionSlackRatio: 0.1 },
        },
      });
      const strategy = buildFrameworkStrategy(recipe, 'mock-model', 'UTC');
      let summaries = 0;
      const membrane = {
        complete: async () => ({ stopReason: 'end_turn', content: [{ type: 'text', text: `summary ${++summaries}` }] }),
      };
      const manager = await ContextManager.open({ path: join(dir, 'store'), strategy: strategy as never, membrane: membrane as never });
      try {
        manager.setToolDefinitions([{ name: 'probe_tool', description: 'probe', inputSchema: { type: 'object', properties: {} } } as never]);
        for (let i = 0; i < 12; i++) {
          manager.addMessage('User', [{ type: 'text', text: `ask ${i}. ` + 'word '.repeat(40) }]);
          manager.addMessage('Mira', [
            { type: 'text', text: `reply ${i}. ` + 'word '.repeat(20) },
            { type: 'tool_use', id: `tu-${i}`, name: 'probe_tool', input: {} } as never,
          ]);
          manager.addMessage('User', [{ type: 'tool_result', toolUseId: `tu-${i}`, content: [{ type: 'text', text: `result ${i} ` + 'word '.repeat(20) }] } as never]);
        }
        for (let t = 0; t < 8; t++) await manager.tick();
        const entries = (await manager.compile({ maxTokens: 2000, reserveForResponse: 0 })).messages as Entry[];

        const labels = entries.flatMap((e, i) => (e.participant === 'Context Manager' ? [i] : []));
        expect(labels.length).toBeGreaterThan(0);
        for (const i of labels) {
          expect(textOf(entries[i]!)).toBe(LABEL);
          expect(entries[i + 1]!.participant).toBe('Mira');
          expect(textOf(entries[i + 1]!)).toMatch(/^summary \d+$/);
        }
        const summaries = entries.flatMap((e, i) => (/^summary \d+$/.test(textOf(e)) ? [i] : []));
        for (const i of summaries) expect(entries[i - 1]?.participant).toBe('Context Manager');
      } finally {
        manager.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
