import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextManager } from '@animalabs/context-manager';
import { buildFrameworkStrategy } from '../src/framework-strategy.js';
import { checkOwnSettings } from '../src/own-settings.js';
import { substituteEnvVars, validateRecipe } from '../src/recipe.js';

const MODEL = 'claude-opus-4-6';
const MODEL_MAX_OUTPUT = 128_000;

type Request = { config: { maxTokens?: number } };
type Entry = { participant: string; content: Array<{ type: string; text?: string }> };

const textOf = (content: ReadonlyArray<{ type: string; text?: string }>): string => content.map((b) => b.text ?? '').join('');

/**
 * Runs a resident whose own file holds `own` through enough turns that its
 * chunks close and its summarizer writes, with a summarizer that refuses a
 * request asking for more output than the model gives, as the provider does.
 */
async function withCompression(own: Record<string, unknown>, compileTokens: number, strategy: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'chost-own-compression-'));
  try {
    const written = {
      name: 'Ember', ownSettings: 'all',
      agent: {
        name: 'Ember', model: MODEL, systemPrompt: 'hi',
        strategy: { type: 'autobiographical', targetChunkTokens: 100, recentWindowTokens: 200, headWindowTokens: 0, mergeThreshold: 3, compressionSlackRatio: 0.1, ...strategy },
      },
    };
    const origin = { kind: 'authored' as const, document: structuredClone(written) };
    const operator = { recipe: validateRecipe(substituteEnvVars(written, 'recipe.json', {}), origin), origin };
    mkdirSync(join(root, 'own-settings'));
    writeFileSync(join(root, 'own-settings', 'own.json'), JSON.stringify(own));
    const check = checkOwnSettings(operator, root);
    expect(check.entries.map((entry) => entry.notUsed)).toEqual(Object.keys(own).map(() => null));
    const requests: Request[] = [];
    let summaries = 0;
    const membrane = {
      complete: async (request: Request) => {
        requests.push(structuredClone(request));
        if ((request.config.maxTokens ?? 0) > MODEL_MAX_OUTPUT) {
          return { stopReason: 'refusal', content: [], usage: { inputTokens: 1, outputTokens: 0 } };
        }
        return { stopReason: 'end_turn', content: [{ type: 'text', text: `summary ${++summaries}` }], usage: { inputTokens: 100, outputTokens: 10 } };
      },
    };
    const manager = await ContextManager.open({
      path: join(root, 'store'),
      strategy: buildFrameworkStrategy(check.recipe, MODEL, 'UTC') as never,
      membrane: membrane as never,
    });
    try {
      for (let i = 0; i < 24; i++) {
        manager.addMessage('Antra', [{ type: 'text', text: `ask ${i}. ` + 'word '.repeat(40) }]);
        manager.addMessage('Ember', [{ type: 'text', text: `reply ${i}. ` + 'word '.repeat(40) }]);
      }
      for (let t = 0; t < 16; t++) await manager.tick();
      const entries = (await manager.compile({ maxTokens: compileTokens, reserveForResponse: 0 })).messages as Entry[];
      return { requests, entries, summaries };
    } finally {
      manager.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("a resident's summary settings at the ends of their domains, with compression running", () => {
  test('a summary target of 1 and of 10666 ask the summarizer for the default\'s 16000 max_tokens, the last target that does, and summaries are written', async () => {
    const asked = async (own: Record<string, unknown>, strategy: Record<string, unknown> = {}) => {
      const run = await withCompression(own, 2_000, strategy);
      expect(run.summaries).toBeGreaterThan(0);
      return [...new Set(run.requests.map((request) => request.config.maxTokens))];
    };
    expect(await asked({})).toEqual([16_000]);
    expect(await asked({ 'agent.strategy.summaryTargetTokens': 1 })).toEqual([16_000]);
    expect(await asked({ 'agent.strategy.summaryTargetTokens': 10_666 })).toEqual([16_000]);
    expect(await asked({}, { summaryTargetTokens: 10_667 })).toEqual([16_001]);
  }, 60_000);

  test('a compile with summaries in view, at the label\'s longest, is not refused, and shows the label before each summary', async () => {
    const label = 'L'.repeat(200);
    const run = await withCompression({ 'agent.strategy.summaryContextLabel': label }, 2_000);
    const labels = run.entries.filter((entry) => entry.participant === 'Context Manager');
    expect(labels.length).toBeGreaterThan(1);
    for (const entry of labels) expect(textOf(entry.content)).toBe(label);
  }, 60_000);

  test('a summary request at the reminder\'s longest carries the reminder, and the summary is written', async () => {
    const reminder = 'R'.repeat(2_000);
    const run = await withCompression({ 'agent.strategy.identityReminder': reminder }, 2_000);
    expect(run.summaries).toBeGreaterThan(0);
    expect(run.requests.some((request) => JSON.stringify(request).includes(reminder))).toBe(true);
  }, 60_000);
});
