import { describe, test, expect } from 'bun:test';
import { NativeFormatter, AnthropicXmlFormatter } from '@animalabs/membrane';
import type { NormalizedMessage } from '@animalabs/membrane';
import { buildContextMakeup, buildCountTokensPayload } from '../src/web/panel-data.js';

// Regression: the makeup panel's exact count flattened every message to its
// text blocks and sent no tool definitions, so signed thinking, tool_use and
// tool_result — most of a keep-all model's prompt — were not counted and the
// "exact" number read up to ~10x below what the provider bills. A hand-rolled
// mirror of the formatter then differed in prefix bytes and block framing; the
// payload is now built by the formatter inference uses.

const SIG = 'A'.repeat(4000);
type Block = { type: string; text?: string; signature?: string; id?: string; tool_use_id?: string; source?: unknown };
const blocksOf = (m: unknown) => (m as { content: Block[] }).content;
const roleOf = (m: unknown) => (m as { role: string }).role;

// An assistant turn that ran a web search: membrane keeps each Anthropic
// server-tool block on a zero-width carrier, and inference through its
// Anthropic API adapter sends the blocks back in that turn.
const searchTurn: NormalizedMessage[] = [
  { participant: 'Lari', content: [{ type: 'text', text: 'what changed?' }] },
  { participant: 'agent', content: [
    { type: 'text', text: '', rawItem: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'changes' } } },
    { type: 'text', text: '', rawItem: {
      type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1',
      content: [{ type: 'web_search_result', url: 'https://example.com/', title: 'Example', encrypted_content: 'E'.repeat(400) }],
    } },
    { type: 'text', text: 'Here is what I found.' },
  ] },
  { participant: 'Lari', content: [{ type: 'text', text: 'thanks' }] },
];

describe('buildCountTokensPayload', () => {
  test('is byte-identical to the NativeFormatter build, with prompt caching off as the count sends it', () => {
    const messages: NormalizedMessage[] = [
      { participant: 'Lari', content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] },
      { participant: 'agent', content: [
        { type: 'thinking', thinking: '', signature: SIG } as never,
        { type: 'tool_use', id: 't1', name: 'read', input: { path: 'a' } },
      ] },
      { participant: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: 'file body' }] },
      { participant: 'agent', content: [{ type: 'text', text: 'done' }] },
    ];
    const tools = [{ name: 'read', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }];
    const payload = buildCountTokensPayload({ system: 'sys', messages, tools }, 'agent');
    const reference = new NativeFormatter().buildMessages(messages, {
      participantMode: 'multiuser', assistantParticipant: 'agent', tools, toolMode: 'native',
      systemPrompt: 'sys', promptCaching: false, cacheMarkers: 'membrane-system',
    });
    expect(payload.messages).toEqual(reference.messages as unknown[]);
    expect(payload.tools).toEqual(reference.nativeTools as unknown[]);
    expect(payload.system).toEqual(reference.systemContent);
  });

  // The name rides in the message's own text, never as a block of its own,
  // and the first text block carries it: that much any formatter must keep,
  // and the test pins it. Which later blocks carry the name too is the
  // formatter's choice: membrane 0.5.86 prefixes every one, and membrane's
  // main (f857fff) only the first. So for the rest, the payload must equal
  // the formatter's own output.
  test('prefixes a named user message in place, as the formatter does — no standalone name block', () => {
    const messages: NormalizedMessage[] = [{ participant: 'Lari', content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] }];
    const payload = buildCountTokensPayload({ messages }, 'agent');
    const blocks = blocksOf(payload.messages[0]);
    expect(blocks.map((b) => b.type)).toEqual(['text', 'text']);
    expect(blocks[0]!.text).toBe('Lari: one');
    expect(blocks[1]!.text).toMatch(/^(Lari: )?two$/);
    const reference = new NativeFormatter().buildMessages(messages, {
      participantMode: 'multiuser', assistantParticipant: 'agent', toolMode: 'native',
      promptCaching: false, cacheMarkers: 'membrane-system',
    });
    expect(payload.messages).toEqual(reference.messages as unknown[]);
  });

  test('a named message with no text gets no name block', () => {
    const png = 'iVBORw0KGgo=';
    const payload = buildCountTokensPayload({
      messages: [{ participant: 'Lari', content: [{ type: 'image', source: { type: 'base64', mediaType: 'image/png', data: png } } as never]}],
    }, 'agent');
    const blocks = blocksOf(payload.messages[0]);
    expect(blocks.map((b) => b.type)).toEqual(['image']);
  });

  test('keeps signed thinking, tool_use and tool_result blocks with ids and signature; tools carry input_schema', () => {
    const payload = buildCountTokensPayload({
      messages: [
        { participant: 'Lari', content: [{ type: 'text', text: 'hello' }] },
        { participant: 'agent', content: [
          { type: 'thinking', thinking: '', signature: SIG } as never,
          { type: 'tool_use', id: 't1', name: 'read', input: { path: 'a' } },
        ] },
        { participant: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: 'file body' }] },
        { participant: 'agent', content: [{ type: 'text', text: 'done' }] },
      ],
      tools: [{ name: 'read', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }],
    }, 'agent');
    expect(payload.messages.map(roleOf)).toEqual(['user', 'assistant', 'user', 'assistant']);
    const asst = blocksOf(payload.messages[1]);
    expect(asst.map((b) => b.type)).toEqual(['thinking', 'tool_use']);
    expect(asst[0]!.signature).toBe(SIG);
    expect(blocksOf(payload.messages[2])[0]!.tool_use_id).toBe('t1');
    expect((payload.tools as Array<{ name: string; input_schema?: unknown }>)[0]!.name).toBe('read');
    expect((payload.tools as Array<{ input_schema?: unknown }>)[0]!.input_schema).toBeDefined();
  });

  test('merges consecutive same-role runs and omits empty tools/system', () => {
    const payload = buildCountTokensPayload({
      messages: [
        { participant: 'Lari', content: [{ type: 'text', text: 'one' }] },
        { participant: 'Antra', content: [{ type: 'text', text: 'two' }] },
        { participant: 'agent', content: [{ type: 'text', text: 'three' }] },
      ],
    }, 'agent');
    expect(payload.messages).toHaveLength(2);
    expect(blocksOf(payload.messages[0]).map((b) => b.text)).toEqual(['Lari: one', 'Antra: two']);
    expect(payload.tools).toBeUndefined();
    expect(payload.system).toBeUndefined();
  });

  // An anthropic-xml agent's count takes that formatter's path, prefill or
  // not (buildContextMakeup), and the whole payload must equal its own build:
  // system, messages and tools. The formatter sends the prefill first, in
  // place of its default opener, whenever its request would otherwise open
  // with the assistant's turn (the transcript), and so must the count; an
  // image goes in a user turn of its own, so an image-first request gets none.
  const xmlOptions = {
    participantMode: 'multiuser' as const, assistantParticipant: 'agent', toolMode: 'xml' as const,
    promptCaching: false, cacheMarkers: 'membrane-system' as const,
  };
  const xmlReference = (messages: NormalizedMessage[], extra: Record<string, unknown> = {}) => {
    const built = new AnthropicXmlFormatter().buildMessages(messages, { ...xmlOptions, ...extra });
    return { system: built.systemContent, messages: built.messages, tools: built.nativeTools };
  };
  const payloadParts = (payload: { system?: unknown; messages: unknown[]; tools?: unknown[] }) =>
    ({ system: payload.system, messages: payload.messages, tools: payload.tools });

  test('an anthropic-xml count is that formatter\'s build, with the prefill first', () => {
    const messages: NormalizedMessage[] = [
      { participant: 'agent', content: [{ type: 'text', text: 'earlier reply' }] },
      { participant: 'Lari', content: [{ type: 'text', text: 'hello' }] },
    ];
    const withPrefill = buildCountTokensPayload(
      { messages, prefillUserMessage: 'PREFILL SCAFFOLD' }, 'agent', new AnthropicXmlFormatter(), 'xml',
    );
    expect(payloadParts(withPrefill)).toEqual(xmlReference(messages, { prefillUserMessage: 'PREFILL SCAFFOLD' }) as never);
    expect(JSON.stringify(withPrefill.messages[0])).toContain('PREFILL SCAFFOLD');
    // Without a prefill, the formatter's own default opener leads instead.
    const without = buildCountTokensPayload({ messages }, 'agent', new AnthropicXmlFormatter(), 'xml');
    expect(payloadParts(without)).toEqual(xmlReference(messages) as never);
    expect(JSON.stringify(without)).not.toContain('PREFILL SCAFFOLD');
  });

  test('an anthropic-xml count with a system prompt and a prefill matches the formatter', () => {
    const messages: NormalizedMessage[] = [
      { participant: 'agent', content: [{ type: 'text', text: 'earlier reply' }] },
      { participant: 'Lari', content: [{ type: 'text', text: 'hello' }] },
    ];
    const payload = buildCountTokensPayload(
      { system: 'sys', messages, prefillUserMessage: 'PREFILL SCAFFOLD' }, 'agent', new AnthropicXmlFormatter(), 'xml',
    );
    expect(payloadParts(payload)).toEqual(xmlReference(messages, { systemPrompt: 'sys', prefillUserMessage: 'PREFILL SCAFFOLD' }) as never);
    expect(JSON.stringify(payload.messages[0])).toContain('PREFILL SCAFFOLD');
  });

  test('a request that opens with a user turn (an image) gets no prefill, in the count as in the formatter', () => {
    const png = 'iVBORw0KGgo=';
    const messages: NormalizedMessage[] = [
      { participant: 'Lari', content: [
        { type: 'text', text: 'look' },
        { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: png } } as never,
      ] },
      { participant: 'agent', content: [{ type: 'text', text: 'reply' }] },
    ];
    const payload = buildCountTokensPayload(
      { messages, prefillUserMessage: 'PREFILL SCAFFOLD' }, 'agent', new AnthropicXmlFormatter(), 'xml',
    );
    expect(payloadParts(payload)).toEqual(xmlReference(messages, { prefillUserMessage: 'PREFILL SCAFFOLD' }) as never);
    expect(JSON.stringify(payload)).not.toContain('PREFILL SCAFFOLD');
  });

  // Since membrane 0.5.87 the native formatter uses prefillUserMessage as the
  // synthetic user turn it puts before assistant-first history (it used to be
  // `[continuing]` whatever the caller passed), so a native agent's count
  // carries the prefill exactly where inference sends it.
  test('a native agent\'s count carries a prefill where the native formatter puts it: the leading user turn', () => {
    const messages: NormalizedMessage[] = [
      { participant: 'agent', content: [{ type: 'text', text: 'earlier reply' }] },
      { participant: 'Lari', content: [{ type: 'text', text: 'hello' }] },
    ];
    const reference = (extra: Record<string, unknown>) => new NativeFormatter().buildMessages(messages, {
      participantMode: 'multiuser', assistantParticipant: 'agent', toolMode: 'native',
      promptCaching: false, cacheMarkers: 'membrane-system', ...extra,
    }).messages as unknown[];
    const withPrefill = buildCountTokensPayload({ messages, prefillUserMessage: 'PREFILL SCAFFOLD' }, 'agent');
    expect(withPrefill.messages).toEqual(reference({ prefillUserMessage: 'PREFILL SCAFFOLD' }));
    expect(roleOf(withPrefill.messages[0])).toBe('user');
    expect(blocksOf(withPrefill.messages[0]).map((b) => b.text)).toEqual(['PREFILL SCAFFOLD']);
    const without = buildCountTokensPayload({ messages }, 'agent');
    expect(without.messages).toEqual(reference({}));
    expect(JSON.stringify(without)).not.toContain('PREFILL SCAFFOLD');
  });

  test("an assistant turn's server-tool blocks are counted when inference sends them, and left out when it doesn't", () => {
    const reference = (anthropicServerBlocks: boolean) => new NativeFormatter().buildMessages(searchTurn, {
      participantMode: 'multiuser', assistantParticipant: 'agent', toolMode: 'native',
      promptCaching: false, cacheMarkers: 'membrane-system', anthropicServerBlocks,
    }).messages as unknown[];
    const sent = buildCountTokensPayload({ messages: searchTurn }, 'agent', new NativeFormatter(), 'native', true);
    expect(sent.messages).toEqual(reference(true));
    expect(blocksOf(sent.messages[1]).map((b) => b.type)).toEqual(['server_tool_use', 'web_search_tool_result', 'text']);
    const leftOut = buildCountTokensPayload({ messages: searchTurn }, 'agent');
    expect(leftOut.messages).toEqual(reference(false));
    expect(JSON.stringify(leftOut.messages)).not.toContain('web_search_tool_result');
  });

  // An empty system, as text or as a list, and an empty tool list send
  // neither field.
  test('an empty system and an empty tool list leave both out of the payload', () => {
    for (const system of ['', [] as never]) {
      const payload = buildCountTokensPayload({
        system, tools: [], messages: [{ participant: 'Lari', content: [{ type: 'text', text: 'hi' }] }],
      }, 'agent');
      expect('system' in payload).toBe(false);
      expect('tools' in payload).toBe(false);
    }
  });
});

// #287: an anthropic-xml agent's tool definitions go into its system block when
// its recipe has a system prompt and prompt caching, and into the transcript
// otherwise, and the panel's exact count has to build the request it sends.
for (const [label, systemPrompt, where] of [
  ['with a system prompt, in the system block', 'You are agent.', 'system'],
  ['with none, in the transcript', '', 'messages'],
] as const) {
  test(`an anthropic-xml agent's context count carries its tools where its request does: ${label}`, async () => {
    const tools = [{ name: 'read_file', description: 'Read a file from the workspace', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }];
    const messages: NormalizedMessage[] = Array.from({ length: 30 }, (_, i) => ({
      participant: i % 2 === 1 ? 'agent' : 'user', content: [{ type: 'text', text: `message ${i}` }],
    }));
    const app = {
      recipe: { agent: { name: 'agent', formatter: 'anthropic-xml', systemPrompt } },
      framework: {
        getAgent: () => ({ model: 'claude-haiku-4-5', getContextManager: () => ({ getRenderStats: () => ({}) }) }),
        previewActivation: async () => ({ system: systemPrompt, messages, tools }),
      },
    };
    const sent: Array<Record<string, unknown>> = [];
    const realFetch = globalThis.fetch;
    const priorModel = process.env.COUNT_TOKENS_MODEL;
    process.env.COUNT_TOKENS_MODEL = 'claude-haiku-4-5';
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      sent.push(JSON.parse(init?.body ?? '{}'));
      return new Response(JSON.stringify({ input_tokens: 1 }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      await buildContextMakeup(app as never, 'agent');
    } finally {
      globalThis.fetch = realFetch;
      if (priorModel === undefined) delete process.env.COUNT_TOKENS_MODEL;
      else process.env.COUNT_TOKENS_MODEL = priorModel;
    }
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0]![where])).toContain('Read a file from the workspace');
    expect(JSON.stringify(sent[0]![where === 'system' ? 'messages' : 'system'] ?? '')).not.toContain('Read a file from the workspace');
  });
}

// Inference sends an assistant turn's server-tool blocks back only through the
// Anthropic API adapter, which the host builds for provider `anthropic` (the
// default); a Bedrock host's requests leave them out. The count sends what
// inference does.
for (const [label, provider, sendsServerBlocks] of [
  ['on the Anthropic API (the default provider), with', undefined, true],
  ['on Bedrock, without', 'bedrock', false],
] as const) {
  test(`an agent's context count ${label} the server-tool blocks its requests carry`, async () => {
    const app = {
      recipe: { agent: { name: 'agent', ...(provider ? { provider } : {}) } },
      framework: {
        getAgent: () => ({ model: 'claude-haiku-4-5', getContextManager: () => ({ getRenderStats: () => ({}) }) }),
        previewActivation: async () => ({ messages: searchTurn }),
      },
    };
    const sent: Array<Record<string, unknown>> = [];
    const realFetch = globalThis.fetch;
    const priorModel = process.env.COUNT_TOKENS_MODEL;
    process.env.COUNT_TOKENS_MODEL = 'claude-haiku-4-5';
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      sent.push(JSON.parse(init?.body ?? '{}'));
      return new Response(JSON.stringify({ input_tokens: 1 }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      await buildContextMakeup(app as never, 'agent');
    } finally {
      globalThis.fetch = realFetch;
      if (priorModel === undefined) delete process.env.COUNT_TOKENS_MODEL;
      else process.env.COUNT_TOKENS_MODEL = priorModel;
    }
    expect(sent).toHaveLength(1);
    const assistantTypes = blocksOf((sent[0]!.messages as unknown[])[1]).map((b) => b.type);
    expect(assistantTypes).toEqual(sendsServerBlocks ? ['server_tool_use', 'web_search_tool_result', 'text'] : ['text']);
  });
}

// The host's one Membrane places every agent's tools by the recipe's primary
// agent and its model, so a subagent's count asks the same, whatever its own
// model: here the subagent's model is one Bedrock's caching gate turns off, so
// asking with it would give main's placement.
test("a subagent's context count places its tools as the primary agent's model decides", async () => {
  const tools = [{ name: 'read_file', description: 'Read a file from the workspace', inputSchema: { type: 'object', properties: {} } }];
  const messages: NormalizedMessage[] = Array.from({ length: 30 }, (_, i) => ({
    participant: i % 2 === 1 ? 'sub' : 'user', content: [{ type: 'text', text: `message ${i}` }],
  }));
  const models: Record<string, string> = { agent: 'anthropic.claude-sonnet-4-5-20250929-v1:0', sub: 'anthropic.claude-3-opus-20240229-v1:0' };
  const app = {
    recipe: { agent: { name: 'agent', formatter: 'anthropic-xml', provider: 'bedrock', systemPrompt: 'You are agent.' } },
    framework: {
      getAgent: (name: string) => ({ model: models[name], getContextManager: () => ({ getRenderStats: () => ({}) }) }),
      previewActivation: async () => ({ system: 'You are sub.', messages, tools }),
    },
  };
  const sent: Array<Record<string, unknown>> = [];
  const realFetch = globalThis.fetch;
  const priorModel = process.env.COUNT_TOKENS_MODEL;
  process.env.COUNT_TOKENS_MODEL = 'claude-haiku-4-5';
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    sent.push(JSON.parse(init?.body ?? '{}'));
    return new Response(JSON.stringify({ input_tokens: 1 }), { status: 200 });
  }) as unknown as typeof fetch;
  try {
    await buildContextMakeup(app as never, 'sub');
  } finally {
    globalThis.fetch = realFetch;
    if (priorModel === undefined) delete process.env.COUNT_TOKENS_MODEL;
    else process.env.COUNT_TOKENS_MODEL = priorModel;
  }
  expect(sent).toHaveLength(1);
  expect(JSON.stringify(sent[0]!.system)).toContain('Read a file from the workspace');
  expect(JSON.stringify(sent[0]!.messages)).not.toContain('Read a file from the workspace');
});
