import { describe, test, expect } from 'bun:test';
import type {
  MessageStoreView,
  StoredMessage,
  SummaryEntry,
  ContextEntry,
} from '@animalabs/context-manager';
import { FrontdeskStrategy } from '../src/strategies/frontdesk-strategy.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let idCounter = 0;
function msg(
  participant: string,
  text: string,
  metadata: Record<string, unknown> = {},
  timestamp = new Date('2026-04-17T14:32:00Z'),
): StoredMessage {
  return {
    id: `m${++idCounter}`,
    sequence: idCounter,
    participant,
    content: [{ type: 'text', text }],
    metadata,
    timestamp,
  };
}

function makeStore(messages: StoredMessage[]): MessageStoreView {
  return {
    getAll: () => messages,
    get: (id) => messages.find((m) => m.id === id) ?? null,
    getFrom: (i) => messages.slice(i),
    getTail: (n) => messages.slice(-n),
    length: () => messages.length,
    estimateTokens: (m) => {
      let t = 0;
      for (const b of m.content) if (b.type === 'text') t += Math.ceil(b.text.length / 4);
      return t;
    },
  };
}

// Expose protected methods for focused testing
class TestFrontdesk extends FrontdeskStrategy {
  public pub_wrapProvenance(entry: ContextEntry, store: MessageStoreView) {
    return this.wrapProvenance(entry, store);
  }
  public pub_buildHeader(m: StoredMessage) {
    return this.buildProvenanceHeader(m);
  }
  public pub_updateSalience(store: MessageStoreView) {
    this.updateSalience(store);
  }
  public pub_selectL1(l1: SummaryEntry[], budget: number, maxTokens: number) {
    return this.selectL1Summaries(l1, budget, maxTokens);
  }
  public pub_isTopicBoundary(a: StoredMessage, b: StoredMessage) {
    return this.isTopicBoundary(a, b);
  }
  public pub_compressionInstruction(chunkMessages: StoredMessage[], target: number) {
    // Build a minimal Chunk shape sufficient for getCompressionInstruction
    const chunk = {
      index: 0,
      startIndex: 0,
      endIndex: chunkMessages.length,
      messages: chunkMessages,
      tokens: 0,
      compressed: false,
    } as any;
    return this.getCompressionInstruction(chunk, target);
  }
}

function makeStrategy(): TestFrontdesk {
  return new TestFrontdesk({
    headWindowTokens: 0,
    recentWindowTokens: 0,
    targetChunkTokens: 50,
    autoTickOnNewMessage: false,
    maxMessageTokens: 0,
    timeZone: 'UTC',
  });
}

// ---------------------------------------------------------------------------
// Feature 1: Provenance wrapping
// ---------------------------------------------------------------------------

describe('provenance wrapping', () => {
  test('wraps a Zulip MCPL-originated entry with a full header', () => {
    const s = makeStrategy();
    const m = msg('User', 'where are the packet retry constants defined?', {
      serverId: 'zulip',
      channelId: 'zulip:tracker-miner-f',
      topic: 'packet pipeline',
      author: { id: 'u1', name: 'alice' },
      messageId: 'M987654',
      timestamp: '2026-04-17T14:32:00Z',
    });
    const header = s.pub_buildHeader(m);
    expect(header).not.toBeNull();
    expect(header).toContain('zulip');
    expect(header).toContain('#tracker-miner-f');
    expect(header).toContain('topic "packet pipeline"');
    expect(header).toContain('@alice');
    expect(header).toContain('14:32');
    expect(header).toContain('msg M987654');
    expect(header!.endsWith('\n')).toBe(true);
  });

  test('renders provenance time in the configured zone', () => {
    const s = new TestFrontdesk({ timeZone: 'America/Los_Angeles' });
    const m = msg('User', 'hello', {
      serverId: 'zulip',
      timestamp: '2026-07-17T14:32:00Z',
    });
    expect(s.pub_buildHeader(m)).toContain('07:32');
  });

  test('wrapProvenance prepends header into the first text block', () => {
    const s = makeStrategy();
    const m = msg('User', 'hello', {
      serverId: 'zulip',
      channelId: 'zulip:general',
      author: { name: 'bob' },
    });
    const store = makeStore([m]);
    const entry: ContextEntry = {
      index: 0,
      sourceMessageId: m.id,
      sourceRelation: 'copy',
      participant: 'User',
      content: [{ type: 'text', text: 'hello' }],
    };
    const wrapped = s.pub_wrapProvenance(entry, store);
    expect(wrapped.content).toHaveLength(1);
    const first = wrapped.content[0] as { type: 'text'; text: string };
    expect(first.type).toBe('text');
    expect(first.text.startsWith('[')).toBe(true);
    expect(first.text).toContain('@bob');
    expect(first.text).toContain('\nhello');
  });

  test('degrades gracefully when fields are missing (no empty separators)', () => {
    const s = makeStrategy();
    const m = msg('User', 'x', {
      serverId: 'zulip',
      // no channelId, no topic, no author, no messageId
    });
    const header = s.pub_buildHeader(m);
    expect(header).not.toBeNull();
    expect(header).not.toContain('· ·');
    expect(header).not.toMatch(/\[ /);
    expect(header).not.toMatch(/ \]/);
  });

  test('pass-through (unchanged) when no serverId (e.g. TUI-origin or summary)', () => {
    const s = makeStrategy();
    const m = msg('User', 'typed from tui', {}); // no serverId
    expect(s.pub_buildHeader(m)).toBeNull();

    const store = makeStore([m]);
    const entry: ContextEntry = {
      index: 0,
      sourceMessageId: m.id,
      sourceRelation: 'copy',
      participant: 'User',
      content: [{ type: 'text', text: 'typed from tui' }],
    };
    const wrapped = s.pub_wrapProvenance(entry, store);
    expect(wrapped).toBe(entry);
  });

  test('derived (summary) entries are not wrapped even if sourceMessageId matched', () => {
    const s = makeStrategy();
    const m = msg('User', 'x', {
      serverId: 'zulip',
      channelId: 'zulip:general',
      author: { name: 'bob' },
    });
    const store = makeStore([m]);
    const entry: ContextEntry = {
      index: 0,
      participant: 'Summary',
      content: [{ type: 'text', text: '...summary...' }],
      sourceRelation: 'derived',
    };
    const wrapped = s.pub_wrapProvenance(entry, store);
    expect(wrapped).toBe(entry);
  });
});

// ---------------------------------------------------------------------------
// Feature 2: Topic-aware chunking (boundary detection)
// ---------------------------------------------------------------------------

describe('topic boundary detection', () => {
  test('returns true when adjacent messages have different topics in same channel', () => {
    const s = makeStrategy();
    const a = msg('User', 'a', { channelId: 'zulip:x', topic: 'T1' });
    const b = msg('User', 'b', { channelId: 'zulip:x', topic: 'T2' });
    expect(s.pub_isTopicBoundary(a, b)).toBe(true);
  });

  test('returns false when topics match', () => {
    const s = makeStrategy();
    const a = msg('User', 'a', { channelId: 'zulip:x', topic: 'T1' });
    const b = msg('User', 'b', { channelId: 'zulip:x', topic: 'T1' });
    expect(s.pub_isTopicBoundary(a, b)).toBe(false);
  });

  test('returns false when either side lacks topic metadata (graceful fallback)', () => {
    const s = makeStrategy();
    const a = msg('User', 'a', {});
    const b = msg('User', 'b', { channelId: 'zulip:x', topic: 'T1' });
    expect(s.pub_isTopicBoundary(a, b)).toBe(false);
    expect(s.pub_isTopicBoundary(b, a)).toBe(false);
  });

  test('same topic name on different channels is NOT the same boundary', () => {
    const s = makeStrategy();
    const a = msg('User', 'a', { channelId: 'zulip:x', topic: 'general' });
    const b = msg('User', 'b', { channelId: 'zulip:y', topic: 'general' });
    expect(s.pub_isTopicBoundary(a, b)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Feature 3: Salience + compression instruction + L1 selection
// ---------------------------------------------------------------------------

describe('question/mention salience', () => {
  test('marks a user question as salient when no assistant reply follows', () => {
    const s = makeStrategy();
    const q = msg('User', 'what is the packet retry policy?', {});
    const noise = msg('User', 'just ambient chat', {});
    s.pub_updateSalience(makeStore([q, noise]));
    const state = (s as unknown as { salientSourceIds: Set<string> }).salientSourceIds;
    expect(state.has(q.id)).toBe(true);
  });

  test('does NOT mark a question as salient when assistant replies within window', () => {
    const s = makeStrategy();
    const q = msg('User', 'what is x?', {});
    const a = msg('Claude', 'x is y', {});
    s.pub_updateSalience(makeStore([q, a]));
    const state = (s as unknown as { salientSourceIds: Set<string> }).salientSourceIds;
    expect(state.has(q.id)).toBe(false);
  });

  test('marks Zulip-style @mentions as salient', () => {
    const s = makeStrategy();
    const m = msg('User', 'hey @**clerk** are you around', {});
    s.pub_updateSalience(makeStore([m]));
    const state = (s as unknown as { salientSourceIds: Set<string> }).salientSourceIds;
    expect(state.has(m.id)).toBe(true);
  });
});

describe('compression instruction', () => {
  test('adds topic clause when chunk spans multiple topics', () => {
    const s = makeStrategy();
    const msgs = [
      msg('User', 'a', { channelId: 'zulip:x', topic: 'T1' }),
      msg('User', 'b', { channelId: 'zulip:x', topic: 'T2' }),
    ];
    const instr = s.pub_compressionInstruction(msgs, 2000);
    expect(instr).toContain('multiple Zulip topics');
  });

  test('omits topic clause when all messages share a topic', () => {
    const s = makeStrategy();
    const msgs = [
      msg('User', 'a', { channelId: 'zulip:x', topic: 'T1' }),
      msg('User', 'b', { channelId: 'zulip:x', topic: 'T1' }),
    ];
    const instr = s.pub_compressionInstruction(msgs, 2000);
    expect(instr).not.toContain('multiple Zulip topics');
  });

  test('preserves open-question text verbatim when the chunk has unanswered questions', () => {
    const s = makeStrategy();
    const q = msg('User', 'where are the packet retry constants defined?', {});
    const noise = msg('User', 'ok thanks', {});
    // Run salience first so the question is marked salient
    s.pub_updateSalience(makeStore([q, noise]));
    const instr = s.pub_compressionInstruction([q, noise], 2000);
    expect(instr).toContain('packet retry constants');
    expect(instr).toContain('Preserve verbatim');
  });
});

describe('salience-biased L1 selection', () => {
  function summary(id: string, tokens: number, sourceIds: string[]): SummaryEntry {
    return {
      id,
      level: 1,
      content: '',
      tokens,
      sourceLevel: 0,
      sourceIds,
      sourceRange: { first: sourceIds[0] ?? '', last: sourceIds[sourceIds.length - 1] ?? '' },
      created: Date.now(),
    };
  }

  test('prefers L1 summaries whose sources contain salient messages', () => {
    const s = makeStrategy();
    const q = msg('User', 'what is x?', {}); // salient: unanswered
    s.pub_updateSalience(makeStore([q]));

    // Two L1 summaries, each 100 tokens; budget fits only one
    const routineFirst = summary('L1-0', 100, ['unrelated-1']);
    const salientSecond = summary('L1-1', 100, [q.id]);

    const { selected } = s.pub_selectL1([routineFirst, salientSecond], 100, 100);
    expect(selected).toHaveLength(1);
    expect(selected[0].id).toBe('L1-1');
  });

  test('falls back to routine summaries once salient are exhausted', () => {
    const s = makeStrategy();
    const q = msg('User', 'what is x?', {});
    s.pub_updateSalience(makeStore([q]));

    const salient = summary('L1-1', 50, [q.id]);
    const routine = summary('L1-2', 50, ['unrelated-1']);
    const { selected } = s.pub_selectL1([routine, salient], 200, 200);
    expect(selected).toHaveLength(2);
    expect(selected[0].id).toBe('L1-1'); // salient first
    expect(selected[1].id).toBe('L1-2');
  });
});
