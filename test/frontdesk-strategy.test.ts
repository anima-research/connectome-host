import { describe, test, expect } from 'bun:test';
import type {
  MessageStoreView,
  StoredMessage,
  ContextEntry,
} from '@animalabs/context-manager';
import { FrontdeskStrategy } from '../src/strategies/frontdesk-strategy.js';

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
  public pub_isTopicBoundary(a: StoredMessage, b: StoredMessage) {
    return this.isTopicBoundary(a, b);
  }
  public pub_chunkBoundaryHint(a: StoredMessage, b: StoredMessage) {
    return this.chunkBoundaryHint(a, b);
  }
  public pub_compressionInstruction(chunkMessages: StoredMessage[], target: number) {
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
    });
    const header = s.pub_buildHeader(m);
    expect(header).not.toBeNull();
    expect(header).not.toContain('· ·');
    expect(header).not.toMatch(/\[ /);
    expect(header).not.toMatch(/ \]/);
  });

  test('pass-through (unchanged) when no serverId (e.g. TUI-origin or summary)', () => {
    const s = makeStrategy();
    const m = msg('User', 'typed from tui', {});
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

describe('server-attributed messages (zulip-mcp `attributed` stamp)', () => {
  const HEAD = '[2026-09-14T11:42:52+03:00 id=17206924] [#qa > how to deploy?] Mykhailo Buialo: ';
  function attributed(body: string, extra: Record<string, unknown> = {}): StoredMessage {
    return msg('User', `${HEAD}${body}`, {
      serverId: 'zulip',
      channelId: 'zulip:qa',
      topic: 'how to deploy?',
      authorName: 'Mykhailo Buialo',
      messageId: '17206924',
      attributed: true,
      attributionHeader: HEAD,
      ...extra,
    });
  }

  test('no provenance header: the body already names author, place, time and id', () => {
    const s = makeStrategy();
    const m = attributed('thanks, done');
    expect(s.pub_buildHeader(m)).toBeNull();
    const store = makeStore([m]);
    const entry: ContextEntry = {
      index: 0,
      sourceMessageId: m.id,
      sourceRelation: 'copy',
      participant: 'User',
      content: m.content,
    };
    const wrapped = s.pub_wrapProvenance(entry, store);
    expect((wrapped.content[0] as { text: string }).text).toBe(`${HEAD}thanks, done`);
  });

  test('an unstamped MCPL message still gets the header (other servers, older zulip-mcp), as does one whose attributed flag is a string', () => {
    const s = makeStrategy();
    const m = msg('User', 'hello', { serverId: 'zulip', channelId: 'zulip:qa', author: { name: 'bob' } });
    expect(s.pub_buildHeader(m)).toContain('@bob');
    const loose = msg('User', 'hello', { serverId: 'zulip', channelId: 'zulip:qa', attributed: 'true' });
    expect(s.pub_buildHeader(loose)).not.toBeNull();
  });

  test('salience scans the body, not the prefix: a "?" in the topic does not make every message a question', () => {
    const s = makeStrategy();
    const statement = attributed('thanks, done');
    const question = attributed('which env do I use?');
    s.pub_updateSalience(makeStore([statement, question]));
    const state = (s as unknown as { salientSourceIds: Set<string> }).salientSourceIds;
    expect(state.has(statement.id)).toBe(false);
    expect(state.has(question.id)).toBe(true);
  });

  test('salience passes over a stored injection, even one holding a "?"', () => {
    const s = makeStrategy();
    const lessons = msg('system_context:retrieval', '## Retrieved Knowledge\n- [90%] Which env? Staging. (tags: env)', {
      system: true, kind: 'context-injection',
      contextInjection: { agent: 'Claude', namespace: 'retrieval', contentHash: 'h1', part: 0, parts: 1 },
    });
    const question = attributed('which env do I use?');
    s.pub_updateSalience(makeStore([lessons, question]));
    const state = (s as unknown as { salientSourceIds: Set<string> }).salientSourceIds;
    expect(state.has(lessons.id)).toBe(false);
    expect(state.has(question.id)).toBe(true);
  });

  test('stored injections don\'t count toward the rows an answer is looked for in', () => {
    const s = makeStrategy();
    const question = attributed('which env do I use?');
    const injected = Array.from({ length: 8 }, (_, i) => msg('system_context:retrieval', `## Retrieved Knowledge\n- [90%] lesson ${i}`, {
      system: true, kind: 'context-injection',
      contextInjection: { agent: 'Claude', namespace: 'retrieval', contentHash: `h${i}`, part: 0, parts: 1 },
    }));
    const answer = msg('Claude', 'Staging.');
    s.pub_updateSalience(makeStore([question, ...injected, answer]));
    const state = (s as unknown as { salientSourceIds: Set<string> }).salientSourceIds;
    expect(state.has(question.id)).toBe(false);
  });

  test('the compression instruction quotes the open question without the prefix', () => {
    const s = makeStrategy();
    const q = attributed('where are the packet retry constants defined?');
    s.pub_updateSalience(makeStore([q]));
    const instr = s.pub_compressionInstruction([q], 2000);
    expect(instr).toContain('"where are the packet retry constants defined?"');
    expect(instr).not.toContain('id=17206924');
  });

  test('a stamp without a matching attributionHeader skips the header but scans the text as it is', () => {
    const s = makeStrategy();
    const m = msg('User', 'plain question?', { serverId: 'zulip', attributed: true, attributionHeader: '[not the prefix] ' });
    expect(s.pub_buildHeader(m)).toBeNull();
    s.pub_updateSalience(makeStore([m]));
    const state = (s as unknown as { salientSourceIds: Set<string> }).salientSourceIds;
    expect(state.has(m.id)).toBe(true);
  });
});

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
    s.pub_updateSalience(makeStore([q, noise]));
    const instr = s.pub_compressionInstruction([q, noise], 2000);
    expect(instr).toContain('packet retry constants');
    expect(instr).toContain('Preserve verbatim');
  });
});

describe('chunk boundary hint (topic-aware chunking via the base seam)', () => {
  test('hints a close when adjacent messages change topic on one channel', () => {
    const s = makeStrategy();
    const a = msg('User', 'x', { serverId: 'zulip', channelId: 'zulip:eng', topic: 'retries' });
    const b = msg('User', 'y', { serverId: 'zulip', channelId: 'zulip:eng', topic: 'deploys' });
    expect(s.pub_chunkBoundaryHint(a, b)).toBe(true);
  });

  test('does not hint within a topic or when topic metadata is absent', () => {
    const s = makeStrategy();
    const a = msg('User', 'x', { serverId: 'zulip', channelId: 'zulip:eng', topic: 'retries' });
    const b = msg('User', 'y', { serverId: 'zulip', channelId: 'zulip:eng', topic: 'retries' });
    const bare = msg('User', 'z', {});
    expect(s.pub_chunkBoundaryHint(a, b)).toBe(false);
    expect(s.pub_chunkBoundaryHint(a, bare)).toBe(false);
    expect(s.pub_chunkBoundaryHint(bare, a)).toBe(false);
  });

  test('hint agrees with isTopicBoundary across channels (same topic name, different channel)', () => {
    const s = makeStrategy();
    const a = msg('User', 'x', { serverId: 'zulip', channelId: 'zulip:eng', topic: 'retries' });
    const b = msg('User', 'y', { serverId: 'zulip', channelId: 'zulip:ops', topic: 'retries' });
    expect(s.pub_chunkBoundaryHint(a, b)).toBe(s.pub_isTopicBoundary(a, b));
  });
});
