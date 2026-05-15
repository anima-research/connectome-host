import { describe, test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  detectModel,
  levenshtein,
  rankByDistance,
  checkRetirement,
  supportsThinking,
  composeRecipe,
  loadMemoriesBlock,
  MODEL_PROMPT_SOURCES,
  RETIRED_MODELS,
  MINIMAL_DEFAULT_PROMPT,
} from '../scripts/evacuator.js';

function tmpDir(prefix = 'evac-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('detectModel', () => {
  test('returns null on empty conversation list', () => {
    expect(detectModel([])).toEqual({ model: null, surfaced: 0, total: 0 });
  });

  test('returns null when no model field is surfaced anywhere', () => {
    const result = detectModel([
      {
        uuid: 'a',
        name: 'no model',
        chat_messages: [
          { sender: 'human' },
          { sender: 'assistant', content: [{ type: 'text' }] },
        ],
      },
    ]);
    expect(result.model).toBeNull();
    expect(result.surfaced).toBe(0);
  });

  test('picks the conversation-level model when present', () => {
    const result = detectModel([
      { uuid: 'a', name: 'x', model: 'claude-opus-4-7', chat_messages: [] },
    ]);
    expect(result.model).toBe('claude-opus-4-7');
    expect(result.surfaced).toBe(1);
    expect(result.total).toBe(1);
  });

  test('aggregates per-message models and picks the most frequent', () => {
    const result = detectModel([
      {
        uuid: 'a',
        name: 'mixed',
        chat_messages: [
          { sender: 'assistant', model: 'claude-sonnet-4-5' },
          { sender: 'assistant', model: 'claude-opus-4-7' },
          { sender: 'assistant', model: 'claude-opus-4-7' },
          { sender: 'human', model: 'should-be-ignored' as never },
        ],
      },
    ]);
    expect(result.model).toBe('claude-opus-4-7');
    expect(result.surfaced).toBe(2);
    expect(result.total).toBe(3);
  });
});

describe('levenshtein', () => {
  test('identical strings have distance zero', () => {
    expect(levenshtein('claude-opus-4-7', 'claude-opus-4-7')).toBe(0);
  });

  test('empty string distance equals other length', () => {
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
  });

  test('single-char difference', () => {
    expect(levenshtein('claude-opus-4-5', 'claude-opus-4-7')).toBe(1);
  });

  test('case is treated literally (caller normalizes if needed)', () => {
    expect(levenshtein('Claude', 'claude')).toBe(1);
  });
});

describe('rankByDistance', () => {
  test('orders candidates ascending by edit distance', () => {
    const ranked = rankByDistance('claude-opus-4-7', [
      'claude-opus-4-5',
      'claude-sonnet-4-6',
      'claude-opus-4-1',
    ]);
    expect(ranked.map((r) => r.name)).toEqual([
      'claude-opus-4-5',
      'claude-opus-4-1',
      'claude-sonnet-4-6',
    ]);
    expect(ranked[0]!.distance).toBeLessThanOrEqual(ranked[1]!.distance);
    expect(ranked[1]!.distance).toBeLessThanOrEqual(ranked[2]!.distance);
  });

  test('is case-insensitive at the comparison level', () => {
    const ranked = rankByDistance('CLAUDE-OPUS-4-7', ['claude-opus-4-7']);
    expect(ranked[0]!.distance).toBe(0);
  });
});

describe('checkRetirement', () => {
  test('flags retired families by prefix', () => {
    expect(checkRetirement('claude-3-sonnet-20240229').retired).toBe(true);
    expect(checkRetirement('claude-3-haiku-20240307').retired).toBe(true);
    expect(checkRetirement('claude-3-opus-20240229').retired).toBe(true);
    expect(checkRetirement('claude-2.1').retired).toBe(true);
    expect(checkRetirement('claude-2.0').retired).toBe(true);
    expect(checkRetirement('claude-instant-1.2').retired).toBe(true);
  });

  test('does not flag living models', () => {
    expect(checkRetirement('claude-opus-4-7').retired).toBe(false);
    expect(checkRetirement('claude-sonnet-4-6').retired).toBe(false);
    expect(checkRetirement('claude-haiku-4-5').retired).toBe(false);
    expect(checkRetirement('claude-3-5-sonnet-20241022').retired).toBe(false);
    expect(checkRetirement('claude-3-7-sonnet').retired).toBe(false);
  });

  test('does not false-positive on prefix collisions in plausible future names', () => {
    // A future `claude-21-...` (whatever that may be) must NOT be confused with
    // claude-2.1; substring-based matching used to make that mistake.
    expect(checkRetirement('claude-21-orion').retired).toBe(false);
  });

  test('attaches era and closestLiving suggestions where defined', () => {
    const r = checkRetirement('claude-3-opus-20240229');
    expect(r.retired).toBe(true);
    expect(r.era).toBe('Opus 3');
    expect(r.closestLiving).toContain('claude-opus-4-1');
  });

  test('RETIRED_MODELS keys are reachable through checkRetirement', () => {
    for (const key of Object.keys(RETIRED_MODELS)) {
      const probe = key.replace(/-$/, '');
      expect(checkRetirement(probe).retired).toBe(true);
    }
  });
});

describe('supportsThinking', () => {
  test('Claude 4 opus/sonnet/haiku-4.5 + 3.7 sonnet are accepted', () => {
    expect(supportsThinking('claude-opus-4-7')).toBe(true);
    expect(supportsThinking('claude-opus-4-1')).toBe(true);
    expect(supportsThinking('claude-sonnet-4-5-20250929')).toBe(true);
    expect(supportsThinking('claude-sonnet-4-6')).toBe(true);
    expect(supportsThinking('claude-haiku-4-5-20251001')).toBe(true);
    expect(supportsThinking('claude-3-7-sonnet-20250219')).toBe(true);
  });

  test('older models are rejected', () => {
    expect(supportsThinking('claude-3-5-sonnet-20241022')).toBe(false);
    expect(supportsThinking('claude-3-5-haiku-20241022')).toBe(false);
    expect(supportsThinking('claude-3-opus-20240229')).toBe(false);
    expect(supportsThinking('claude-3-haiku-20240307')).toBe(false);
    expect(supportsThinking('claude-2.1')).toBe(false);
    expect(supportsThinking('claude-instant-1.2')).toBe(false);
  });
});

describe('composeRecipe', () => {
  test('produces the expected top-level recipe shape', () => {
    const recipe = composeRecipe({
      model: 'claude-opus-4-7',
      systemPrompt: 'You are Claude.',
      memoriesBlock: null,
      addendum: 'Addendum.',
      recipeName: 'Test',
    });
    expect(recipe.name).toBe('Test');
    expect(recipe).toHaveProperty('modules');
    expect(recipe).toHaveProperty('mcplServers');
    const agent = recipe.agent as Record<string, unknown>;
    expect(agent.name).toBe('agent');
    expect(agent.model).toBe('claude-opus-4-7');
    expect(agent.strategy).toEqual({ type: 'autobiographical', compressionModel: 'claude-opus-4-7' });
  });

  test('includes thinking field for models that support it', () => {
    const recipe = composeRecipe({
      model: 'claude-opus-4-7',
      systemPrompt: 'x',
      memoriesBlock: null,
      addendum: '',
      recipeName: 'T',
    });
    const agent = recipe.agent as Record<string, unknown>;
    expect(agent).toHaveProperty('thinking');
    expect(agent.thinking).toEqual({ enabled: true, budgetTokens: 4096 });
  });

  test('omits thinking field for models that do not support it', () => {
    const recipe = composeRecipe({
      model: 'claude-3-5-sonnet-20241022',
      systemPrompt: 'x',
      memoriesBlock: null,
      addendum: '',
      recipeName: 'T',
    });
    const agent = recipe.agent as Record<string, unknown>;
    expect(agent).not.toHaveProperty('thinking');
  });

  test('wraps memories block in <persistent_memories> when non-empty', () => {
    const recipe = composeRecipe({
      model: 'claude-opus-4-7',
      systemPrompt: 'base prompt',
      memoriesBlock: 'remembered text',
      addendum: 'addendum',
      recipeName: 'T',
    });
    const composed = (recipe.agent as Record<string, unknown>).systemPrompt as string;
    expect(composed).toContain('<persistent_memories>');
    expect(composed).toContain('remembered text');
    expect(composed).toContain('</persistent_memories>');
    // Order: base prompt, then memories, then addendum.
    expect(composed.indexOf('base prompt')).toBeLessThan(composed.indexOf('<persistent_memories>'));
    expect(composed.indexOf('</persistent_memories>')).toBeLessThan(composed.indexOf('addendum'));
  });

  test('skips memories section for empty / whitespace-only blocks', () => {
    const recipe = composeRecipe({
      model: 'claude-opus-4-7',
      systemPrompt: 'x',
      memoriesBlock: '   \n   ',
      addendum: '',
      recipeName: 'T',
    });
    const composed = (recipe.agent as Record<string, unknown>).systemPrompt as string;
    expect(composed).not.toContain('<persistent_memories>');
  });
});

describe('loadMemoriesBlock', () => {
  test('returns null when memories.json is absent', () => {
    const d = tmpDir();
    try {
      expect(loadMemoriesBlock(d)).toBeNull();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test('returns null for an empty array', () => {
    const d = tmpDir();
    try {
      writeFileSync(join(d, 'memories.json'), '[]');
      expect(loadMemoriesBlock(d)).toBeNull();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test('returns the single block for a one-entry file', () => {
    const d = tmpDir();
    try {
      writeFileSync(
        join(d, 'memories.json'),
        JSON.stringify([{ conversations_memory: '  hello world  ', account_uuid: 'whatever' }]),
      );
      expect(loadMemoriesBlock(d)).toBe('hello world');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test('concatenates multiple entries with a separator', () => {
    const d = tmpDir();
    try {
      writeFileSync(
        join(d, 'memories.json'),
        JSON.stringify([
          { conversations_memory: 'first' },
          { conversations_memory: 'second' },
        ]),
      );
      const block = loadMemoriesBlock(d);
      expect(block).toContain('first');
      expect(block).toContain('second');
      expect(block).toContain('---');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test('returns null when entries have no conversations_memory', () => {
    const d = tmpDir();
    try {
      writeFileSync(
        join(d, 'memories.json'),
        JSON.stringify([{}, {}]),
      );
      expect(loadMemoriesBlock(d)).toBeNull();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('constants', () => {
  test('MODEL_PROMPT_SOURCES is non-empty and entries point at remote URLs', () => {
    const keys = Object.keys(MODEL_PROMPT_SOURCES);
    expect(keys.length).toBeGreaterThan(0);
    for (const url of Object.values(MODEL_PROMPT_SOURCES)) {
      expect(url).toMatch(/^https?:\/\//);
    }
  });

  test('MINIMAL_DEFAULT_PROMPT is non-empty', () => {
    expect(MINIMAL_DEFAULT_PROMPT.length).toBeGreaterThan(0);
    expect(MINIMAL_DEFAULT_PROMPT.toLowerCase()).toContain('claude');
  });

  test('No retired model has a self-referencing closestLiving entry', () => {
    for (const [key, meta] of Object.entries(RETIRED_MODELS)) {
      for (const alt of meta.closestLiving ?? []) {
        expect(checkRetirement(alt).retired).toBe(false);
        // Sanity: closestLiving shouldn't repeat the retired prefix
        expect(alt.startsWith(key)).toBe(false);
      }
    }
  });
});
