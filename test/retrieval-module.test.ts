/**
 * Tests for RetrievalModule fixes (fragility audit Jul 2026):
 *   3.5a — module declares contextTimeoutMs = 15_000 (per-module gatherContext budget)
 *   3.5b — a cached EMPTY result for an unchanged context is served from cache
 *          (zero Haiku calls), not re-run
 *   3.5c — a superseded (stale-generation) pipeline returns [] and doesn't
 *          poison the cache
 *   3.6  — unparseable relevance-validator output injects NOTHING (fail closed)
 */
import { describe, test, expect } from 'bun:test';
import type { ModuleContext } from '@animalabs/agent-framework';
import type { Membrane } from '@animalabs/membrane';
import { RetrievalModule } from '../src/modules/retrieval-module.js';
import type { Lesson } from '../src/modules/lessons-module.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function lesson(id: string, content: string, confidence = 0.8): Lesson {
  return {
    id,
    content,
    confidence,
    tags: ['test'],
    evidence: [],
    created: Date.now(),
    updated: Date.now(),
    deprecated: false,
  };
}

/**
 * Fake membrane: responds per call index, with a small latency so the tests
 * exercise real await interleaving (the audit's 3s-per-call problem scaled
 * down to keep tests fast).
 */
function makeMembrane(respond: (callIndex: number) => string, latencyMs = 20) {
  let calls = 0;
  const membrane = {
    complete: async (_req: unknown) => {
      const idx = calls++;
      await new Promise(r => setTimeout(r, latencyMs));
      return { content: [{ type: 'text', text: respond(idx) }] };
    },
  };
  return { membrane: membrane as unknown as Membrane, callCount: () => calls };
}

type MockMessage = { participant: string; content: Array<{ type: 'text'; text: string }> };

function makeCtx(lessons: Lesson[], getMessages: () => MockMessage[]): ModuleContext {
  return {
    getModule: (name: string) =>
      name === 'lessons' ? { getLessons: () => lessons } : null,
    queryMessages: () => {
      const messages = getMessages();
      return { messages, totalCount: messages.length };
    },
  } as unknown as ModuleContext;
}

function msg(text: string): MockMessage {
  return { participant: 'user', content: [{ type: 'text', text }] };
}

async function makeModule(opts: {
  lessons: Lesson[];
  respond: (callIndex: number) => string;
  messages: () => MockMessage[];
  latencyMs?: number;
}) {
  const { membrane, callCount } = makeMembrane(opts.respond, opts.latencyMs);
  const module = new RetrievalModule({ membrane });
  await module.start(makeCtx(opts.lessons, opts.messages));
  return { module, callCount };
}

// ---------------------------------------------------------------------------
// 3.5a — contextTimeoutMs contract
// ---------------------------------------------------------------------------

describe('RetrievalModule contextTimeoutMs', () => {
  test('declares a 15s per-module gatherContext budget', () => {
    const { membrane } = makeMembrane(() => '[]');
    const module = new RetrievalModule({ membrane });
    expect(module.contextTimeoutMs).toBe(15_000);
  });
});

// ---------------------------------------------------------------------------
// Happy path + cache behaviour
// ---------------------------------------------------------------------------

describe('RetrievalModule gatherContext', () => {
  test('injects relevant lessons; identical context is served from cache with zero extra calls', async () => {
    const { module, callCount } = await makeModule({
      lessons: [lesson('l1', 'alpha protocol requires a signed RFC')],
      // Call 0 = concept flagging. Only 1 candidate (<= 3) so relevance
      // validation is skipped.
      respond: () => '["alpha"]',
      messages: () => [msg('what do we know about the alpha protocol?')],
    });

    const injections = await module.gatherContext('agent');
    expect(injections.length).toBe(1);
    const text = injections[0].content
      .map(b => (b.type === 'text' ? b.text : ''))
      .join('');
    expect(text).toContain('alpha protocol requires a signed RFC');
    expect(callCount()).toBe(1);

    // Same context again → cache hit, no new membrane calls.
    const again = await module.gatherContext('agent');
    expect(again).toEqual(injections);
    expect(callCount()).toBe(1);
  });

  test('cached EMPTY result for unchanged context is served without re-running Haiku calls', async () => {
    const { module, callCount } = await makeModule({
      lessons: [lesson('l1', 'something entirely unrelated')],
      respond: () => '[]', // concept flagging finds nothing
      messages: () => [msg('idle chatter with no concepts')],
    });

    const first = await module.gatherContext('agent');
    expect(first).toEqual([]);
    expect(callCount()).toBe(1);

    // Identical context, cached result is EMPTY — must still be a cache hit.
    // Pre-fix behaviour: `cachedInjections.length > 0` treated a cached empty
    // result as a cache miss and re-ran the pipeline every inference.
    const second = await module.gatherContext('agent');
    expect(second).toEqual([]);
    expect(callCount()).toBe(1); // ZERO additional membrane calls
  });

  test('superseded run returns [] and does not poison the cache (generation counter)', async () => {
    let messages = [msg('first context about the alpha protocol')];
    const { module, callCount } = await makeModule({
      lessons: [lesson('l1', 'alpha protocol requires a signed RFC')],
      respond: () => '["alpha"]',
      messages: () => messages,
      latencyMs: 40,
    });

    // Start run 1, then change the context and start run 2 while run 1 is
    // still awaiting its Haiku call (simulates the framework timing out a
    // slow gatherContext and starting a fresh inference).
    const p1 = module.gatherContext('agent');
    messages = [msg('second, different context about the alpha protocol')];
    const p2 = module.gatherContext('agent');

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual([]); // stale run yields nothing
    expect(r2.length).toBe(1); // fresh run wins

    // Cache belongs to run 2's context: repeating it costs no extra calls.
    const callsAfterRace = callCount();
    const r3 = await module.gatherContext('agent');
    expect(r3).toEqual(r2);
    expect(callCount()).toBe(callsAfterRace);
  });
});

// ---------------------------------------------------------------------------
// 3.6 — fail closed on unparseable validator output
// ---------------------------------------------------------------------------

describe('RetrievalModule relevance validation fail-closed', () => {
  test('malformed Haiku relevance reply injects NOTHING', async () => {
    // 4 matching candidates (> 3) forces the relevance-validation call.
    const lessons = [
      lesson('l1', 'alpha fact one'),
      lesson('l2', 'alpha fact two'),
      lesson('l3', 'alpha fact three'),
      lesson('l4', 'alpha fact four'),
    ];
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    try {
      const { module, callCount } = await makeModule({
        lessons,
        respond: (idx) =>
          idx === 0
            ? '["alpha"]' // concept flagging succeeds
            : 'Sure! I think the first and third lessons look quite relevant to this discussion.', // prose, unparseable
        messages: () => [msg('tell me about alpha')],
      });

      const injections = await module.gatherContext('agent');
      expect(injections).toEqual([]); // pre-fix: top-5 keyword matches leaked in
      expect(callCount()).toBe(2); // both pipeline calls ran
      expect(warnings.some(w => w.includes('unparseable'))).toBe(true);

      // The empty fail-closed result is cached for the unchanged context.
      await module.gatherContext('agent');
      expect(callCount()).toBe(2);
    } finally {
      console.warn = originalWarn;
    }
  });

  test('non-array but valid JSON reply also injects nothing', async () => {
    const lessons = [
      lesson('l1', 'alpha fact one'),
      lesson('l2', 'alpha fact two'),
      lesson('l3', 'alpha fact three'),
      lesson('l4', 'alpha fact four'),
    ];
    const originalWarn = console.warn;
    console.warn = () => { /* silence */ };
    try {
      const { module } = await makeModule({
        lessons,
        respond: (idx) => (idx === 0 ? '["alpha"]' : '{"relevant": ["l1"]}'),
        messages: () => [msg('tell me about alpha')],
      });
      const injections = await module.gatherContext('agent');
      expect(injections).toEqual([]);
    } finally {
      console.warn = originalWarn;
    }
  });
});
