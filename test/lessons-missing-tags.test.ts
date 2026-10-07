import { describe, test, expect } from 'bun:test';
import { LessonsModule } from '../src/modules/lessons-module.js';

type AnyLesson = { id: string; content: string; tags: unknown };

function fakeCtx(saved?: unknown) {
  let state = saved;
  return {
    getState: () => state,
    setState: (s: unknown) => { state = s; },
  } as never;
}

async function started(saved?: unknown): Promise<LessonsModule> {
  const mod = new LessonsModule();
  await mod.start(fakeCtx(saved));
  return mod;
}

const call = (mod: LessonsModule, name: string, input: Record<string, unknown>) =>
  mod.handleToolCall({ id: `t-${name}`, name, input } as never);

describe('lessons without tags', () => {
  test('create without tags stores an empty array, and query/list still work', async () => {
    const mod = await started();
    expect((await call(mod, 'create', { content: 'no tags here' })).success).toBe(true);
    expect(mod.getLessons()[0].tags).toEqual([]);
    expect((await call(mod, 'query', { query: 'tags', tags: ['x'] })).success).toBe(true);
    expect((await call(mod, 'list', { tags: ['x'] })).success).toBe(true);
  });

  test('create/update with null or junk tags keep only strings', async () => {
    const mod = await started();
    await call(mod, 'create', { content: 'a', tags: null });
    expect(mod.getLessons()[0].tags).toEqual([]);
    const id = mod.getLessons()[0].id;
    await call(mod, 'update', { id, tags: ['ok', 3, null, 'fine'] });
    expect(mod.getLessons()[0].tags).toEqual(['ok', 'fine']);
  });

  test('lessons already stored without tags are healed on start', async () => {
    const saved = { lessons: [
      { id: 'old1', content: 'legacy', confidence: 0.5, evidence: [], created: 1, updated: 1, deprecated: false } as AnyLesson,
      { id: 'old2', content: 'tagged', confidence: 0.5, tags: ['keep'], evidence: [], created: 1, updated: 1, deprecated: false },
    ] };
    const mod = await started(saved);
    expect(mod.getLessons().map((l) => l.tags)).toEqual([[], ['keep']]);
    expect((await call(mod, 'list', { tags: ['keep'] })).success).toBe(true);
  });
});
