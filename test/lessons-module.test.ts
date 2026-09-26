import { describe, expect, test } from 'bun:test';
import type { ModuleContext } from '@animalabs/agent-framework';
import {
  INITIAL_STABILITY_DAYS,
  LessonsModule,
  rankScore,
  retrievability,
  type Lesson,
} from '../src/modules/lessons-module.js';
import { bm25Scores, lexicalSimilarity } from '../src/modules/lesson-search.js';

const DAY = 86_400_000;

async function started(): Promise<LessonsModule> {
  let state: unknown;
  const mod = new LessonsModule();
  await mod.start({
    getState: () => state,
    setState: (s: unknown) => { state = s; },
  } as unknown as ModuleContext);
  return mod;
}

async function create(mod: LessonsModule, input: Record<string, unknown>) {
  return mod.handleToolCall({ id: 'c', name: 'create', input } as never);
}

function lesson(overrides: Partial<Lesson>): Lesson {
  return {
    id: 'x',
    content: 'content',
    confidence: 0.8,
    tags: [],
    evidence: [],
    created: 0,
    updated: 0,
    deprecated: false,
    ...overrides,
  };
}

describe('lexicalSimilarity', () => {
  test('ignores case, punctuation, and stopwords', () => {
    expect(lexicalSimilarity('The auth service uses JWT.', 'auth SERVICE uses jwt')).toBe(1);
  });

  test('is zero for texts with no shared content words', () => {
    expect(lexicalSimilarity('deploys run on Fridays', 'Alice owns the billing pipeline')).toBe(0);
  });
});

describe('LessonsModule near-duplicate gate', () => {
  test('refuses a restatement of a live lesson and names the match', async () => {
    const mod = await started();
    const first = await create(mod, { content: 'Alice owns the billing pipeline deploys', tags: ['people'] });
    const id = (first.data as { id: string }).id;

    const dup = await create(mod, { content: 'Alice owns billing pipeline deploys now', tags: ['people'] });

    expect(dup.success).toBe(false);
    expect(dup.error).toContain(`[${id}]`);
    expect(mod.getLessons()).toHaveLength(1);
  });

  test('creates distinct lessons without complaint', async () => {
    const mod = await started();
    await create(mod, { content: 'Alice owns the billing pipeline', tags: [] });
    const other = await create(mod, { content: 'Deploys are frozen on Fridays', tags: [] });

    expect(other.success).toBe(true);
    expect(mod.getLessons()).toHaveLength(2);
  });

  test('force creates despite a near-duplicate', async () => {
    const mod = await started();
    await create(mod, { content: 'Alice owns the billing pipeline', tags: [] });
    const forced = await create(mod, { content: 'Alice owns the billing pipeline', tags: [], force: true });

    expect(forced.success).toBe(true);
    expect(mod.getLessons()).toHaveLength(2);
  });

  test('deprecated lessons do not block creation', async () => {
    const mod = await started();
    const first = await create(mod, { content: 'Alice owns the billing pipeline', tags: [] });
    await mod.handleToolCall({
      id: 'd', name: 'deprecate', input: { id: (first.data as { id: string }).id, reason: 'wrong' },
    } as never);

    expect((await create(mod, { content: 'Alice owns the billing pipeline', tags: [] })).success).toBe(true);
  });

  test('supersedes deprecates and links the replaced lesson', async () => {
    const mod = await started();
    const first = await create(mod, { content: 'Alice owns the billing pipeline', tags: [] });
    const oldId = (first.data as { id: string }).id;

    const next = await create(mod, {
      content: 'Bob owns the billing pipeline since March', tags: [], supersedes: [oldId],
    });
    const newId = (next.data as { id: string }).id;

    expect(next.success).toBe(true);
    const old = mod.getLessons().find(l => l.id === oldId)!;
    expect(old.deprecated).toBe(true);
    expect(old.supersededBy).toBe(newId);
    expect(old.deprecationReason).toBe(`Superseded by ${newId}`);
  });

  test('supersedes rejects unknown IDs without creating anything', async () => {
    const mod = await started();
    const result = await create(mod, { content: 'anything at all', tags: [], supersedes: ['nope'] });

    expect(result.success).toBe(false);
    expect(mod.getLessons()).toHaveLength(0);
  });
});

describe('usage strength', () => {
  test('retrievability is 0.9 after one stability period and decays from creation when never retrieved', () => {
    const l = lesson({ created: 0 });
    expect(retrievability(l, 0)).toBe(1);
    expect(retrievability(l, INITIAL_STABILITY_DAYS * DAY)).toBeCloseTo(0.9, 10);
  });

  test('disuse can at most halve the rank; confidence stays dominant', () => {
    const ancient = lesson({ confidence: 0.9, created: 0 });
    const fresh = lesson({ confidence: 0.4, created: 10_000 * DAY });
    const now = 10_000 * DAY;

    expect(rankScore(ancient, now)).toBeGreaterThan(0.45);
    expect(rankScore(ancient, now)).toBeGreaterThan(rankScore(fresh, now));
  });

  test('spaced retrievals strengthen far more than massed ones', async () => {
    const massed = await started();
    const spaced = await started();
    await create(massed, { content: 'massed lesson', tags: [] });
    await create(spaced, { content: 'spaced lesson', tags: [] });
    const m = massed.getLessons()[0];
    const s = spaced.getLessons()[0];
    const t0 = m.created;
    s.created = t0;

    for (let i = 1; i <= 5; i++) massed.recordRetrieval([m.id], t0 + i * 60_000);
    for (let i = 1; i <= 5; i++) spaced.recordRetrieval([s.id], t0 + i * 30 * DAY);

    expect(m.retrievalCount).toBe(5);
    expect(s.retrievalCount).toBe(5);
    expect(m.stability!).toBeLessThan(INITIAL_STABILITY_DAYS * 1.1);
    expect(s.stability!).toBeGreaterThan(m.stability! * 10);
  });

  test('recordRetrieval leaves `updated` alone and fails loudly on unknown IDs', async () => {
    const mod = await started();
    await create(mod, { content: 'some lesson', tags: [] });
    const l = mod.getLessons()[0];
    const updated = l.updated;

    mod.recordRetrieval([l.id], updated + DAY);

    expect(l.updated).toBe(updated);
    expect(() => mod.recordRetrieval(['missing'])).toThrow('lesson not found: missing');
  });
});

describe('nothing is lost', () => {
  test('update keeps prior wording in revision history', async () => {
    const mod = await started();
    await create(mod, { content: 'Alice owns billing', tags: [] });
    const l = mod.getLessons()[0];

    await mod.handleToolCall({ id: 'u', name: 'update', input: { id: l.id, content: 'Bob owns billing' } } as never);
    await mod.handleToolCall({ id: 'u', name: 'update', input: { id: l.id, confidence: 0.9 } } as never);

    expect(l.content).toBe('Bob owns billing');
    expect(l.previousContents!.map(p => p.content)).toEqual(['Alice owns billing']);
  });

  test('query searches superseded lessons only when asked', async () => {
    const mod = await started();
    const first = await create(mod, { content: 'Alice owns the billing pipeline', tags: [] });
    const oldId = (first.data as { id: string }).id;
    await create(mod, { content: 'Bob runs payments now', tags: [], supersedes: [oldId] });

    const live = await mod.handleToolCall({ id: 'q', name: 'query', input: { text: 'alice' } } as never);
    const archive = await mod.handleToolCall({
      id: 'q', name: 'query', input: { text: 'alice', includeDeprecated: true },
    } as never);

    expect((live.data as { count: number }).count).toBe(0);
    expect((archive.data as { lessons: Array<{ id: string; supersededBy?: string }> }).lessons)
      .toMatchObject([{ id: oldId, supersededBy: expect.any(String) }]);
  });
});

describe('bm25Scores', () => {
  const docs = [
    lesson({ id: 'a', content: 'OAuth tokens expire after one hour' }),
    lesson({ id: 'b', content: 'Deploys are frozen on Fridays' }),
    lesson({ id: 'c', content: 'tokens tokens everywhere, and the OAuth docs are thin', tags: ['docs'] }),
  ];

  test('matches whole words only and scores non-matching lessons zero', () => {
    const [a, b] = bm25Scores('expire', docs);
    expect(a).toBeGreaterThan(0);
    expect(b).toBe(0);
    expect(bm25Scores('pire', docs)).toEqual([0, 0, 0]);
  });

  test('rare terms outweigh common ones', () => {
    const [a, , c] = bm25Scores('oauth expire', docs);
    expect(a).toBeGreaterThan(c);
  });

  test('stopword-only queries match nothing', () => {
    expect(bm25Scores('the and of', docs)).toEqual([0, 0, 0]);
  });

  test('tags are searchable', () => {
    expect(bm25Scores('docs', docs)[2]).toBeGreaterThan(0);
  });
});
