import { expect, test } from 'bun:test';
import { AnthropicAdapter, type ProviderRequest } from '@animalabs/membrane';
import { LoggingAnthropicAdapter } from '../src/logging-adapter.js';
import { validateRecipe } from '../src/recipe.js';
import { filterStoredHistoryExtracts } from '../src/stored-history-extract.js';

const extractName = 'history--extract';
const call = { type: 'tool_use', name: extractName, id: 'toolu_extract', input: { format: 'raw' } };
const thinking = { type: 'thinking', thinking: 'placeholder', signature: 'fixture-signature' };
const redacted = { type: 'redacted_thinking', data: 'fixture-data' };
const ordinaryCall = {
  type: 'tool_use',
  name: 'fixture--read',
  id: 'toolu_read',
  // Looks like a private block but is just public tool input.
  input: { path: 'notes', options: thinking },
};
const publicText = { type: 'text', text: 'Public text about signature and data.' };

function projected(...content: unknown[]) {
  return { id: 'message-1', timestamp: '2026-01-01T00:00:00.000Z', participant: 'agent', author: 'agent', channelId: null, content };
}

function extract(...messages: unknown[]) {
  return { anchorId: 'message-1', returned: messages.length, messages };
}

const exposed = JSON.stringify(extract(projected(thinking, redacted, publicText, ordinaryCall)), null, 2);
const cleaned = JSON.stringify(extract(projected(publicText, ordinaryCall)));

function requestWith(content: unknown, preceding = call, resultId = call.id) {
  const result = { type: 'tool_result', tool_use_id: resultId, content, is_error: false };
  const request = {
    model: 'claude-opus-4-6',
    maxTokens: 1024,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Retrieve my earlier tool call.' }] },
      { role: 'assistant', content: [thinking, redacted, preceding] },
      { role: 'user', content: [result] },
    ],
  } satisfies ProviderRequest;
  return { request, result };
}

function resultOf(request: ProviderRequest): Record<string, unknown> {
  return (request.messages[2] as { content: Record<string, unknown>[] }).content[0]!;
}

test('filters a paired extract on copies, preserves result metadata and native thinking, and is idempotent', () => {
  const { request, result } = requestWith(exposed);
  const original = JSON.stringify(request);
  const altered: unknown[] = [];
  const sent = filterStoredHistoryExtracts(request, (block) => altered.push(block));
  expect(resultOf(sent)).toEqual({ ...result, content: cleaned });
  expect(sent.messages[1]).toBe(request.messages[1]);
  expect(JSON.stringify(request)).toBe(original);
  expect(altered).toEqual([result]);
  expect(altered[0]).toBe(result);
  expect(filterStoredHistoryExtracts(sent)).toBe(sent);
});

test('filters JSON in text parts of paired results without replacing other parts', () => {
  const ordinary = { type: 'text', text: 'signature and data' };
  const image = { type: 'image', source: { type: 'url', url: 'https://example.invalid/image' } };
  const { request } = requestWith([{ type: 'text', text: exposed }, ordinary, image]);
  const sent = filterStoredHistoryExtracts(request);
  const parts = resultOf(sent).content as unknown[];
  expect(parts).toEqual([{ type: 'text', text: cleaned }, ordinary, image]);
  expect(parts[1]).toBe(ordinary);
  expect(parts[2]).toBe(image);
});

test('filters nested extracts only when their archived call is present', () => {
  const archivedResult = { type: 'tool_result', toolUseId: call.id, content: exposed };
  const otherTool = { ...ordinaryCall, input: { copied: extract(projected(thinking)) } };
  const otherResult = { ...archivedResult, toolUseId: otherTool.id, toolName: extractName };
  const orphan = { ...archivedResult, toolUseId: 'lost', toolName: extractName };
  const { request } = requestWith(JSON.stringify(extract(
    projected(call, otherTool),
    projected(archivedResult, otherResult, orphan),
  )));
  const sent = filterStoredHistoryExtracts(request);
  expect(JSON.parse(resultOf(sent).content as string)).toEqual(extract(
    projected(call, otherTool),
    projected({ ...archivedResult, content: cleaned }, otherResult, orphan),
  ));
  expect(filterStoredHistoryExtracts(sent)).toBe(sent);
});

test('withholds an extract cut inside a paired nested result string carrying private thinking', () => {
  for (const wrap of [(text: string) => text, (text: string) => [{ type: 'text', text }]]) {
    for (const suffix of ['\n\n[truncated — fixture]', '\\']) {
      const serialized = JSON.stringify(extract(
        projected(call),
        projected({ type: 'tool_result', toolUseId: call.id, content: wrap(exposed) }),
      ));
      // Cut in the middle of the outer string, after the escaped private block.
      const text = serialized.slice(0, serialized.indexOf('fixture-signature') + 'fixture-signature'.length) + suffix;
      const { request, result } = requestWith(text);
      const sent = filterStoredHistoryExtracts(request);
      expect(resultOf(sent)).toEqual({
        ...result,
        content: '[history--extract result withheld: malformed JSON contains a private thinking block.]',
      });
      expect(result.content).toBe(text);
    }
  }
});

test('does not filter another tool, a missing call, or a call only found later', () => {
  for (const text of [exposed, exposed.slice(0, -5)]) {
    const other = requestWith(text, { ...call, name: 'history--extract-other' }).request;
    const unpaired = requestWith(text, call, 'lost').request;
    const later = requestWith(text).request;
    later.messages.push(...later.messages.splice(1, 1));
    for (const request of [other, unpaired, later]) {
      expect(filterStoredHistoryExtracts(request)).toBe(request);
    }
  }
});

test('does not reserialize clean JSON or mistake lookalike data for projected blocks', () => {
  for (const payload of [
    extract(projected({ type: 'thinking' }, { type: 'redacted_thinking', data: 42 }, ordinaryCall)),
    { ...extract(projected(publicText)), metadata: thinking },
    { messages: [{ content: [thinking] }] },
    extract({ ...projected(), content: JSON.stringify(thinking) }),
  ]) {
    const { request } = requestWith(JSON.stringify(payload, null, 2));
    expect(filterStoredHistoryExtracts(request)).toBe(request);
  }
});

test('withholds a malformed paired body with a structural private block marker', () => {
  for (const text of [
    exposed.slice(0, -5),
    exposed.slice(0, exposed.indexOf('placeholder') + 3) + '\n\n[truncated — fixture]',
    JSON.stringify(extract(projected(redacted))).split('fixture-data')[0] + 'fixture',
  ]) {
    const { request, result } = requestWith(text);
    const sent = filterStoredHistoryExtracts(request);
    const content = resultOf(sent).content;
    expect(content).toMatch(/^\[history--extract result withheld:/);
    expect(resultOf(sent)).toEqual({ ...result, content });
    expect(filterStoredHistoryExtracts(sent)).toBe(sent);
    expect(result.content).toBe(text);
  }
});

test('withholds a paired extract cut after a private row before the truncation notice', () => {
  const row = projected(thinking);
  const serialized = JSON.stringify(extract(row, projected(publicText)));
  const rowJson = JSON.stringify(row);
  const prefix = serialized.slice(0, serialized.indexOf(rowJson) + rowJson.length);
  for (const spill of ['', '; full serialized result: workspace file tool-results/extract.json']) {
    const text = prefix + `\n\n[truncated — original was ${serialized.length} chars${spill}]`;
    const { request } = requestWith(text);
    expect(resultOf(filterStoredHistoryExtracts(request)).content).toMatch(/^\[history--extract result withheld:/);
  }
});

// AF 0.35.1 spillNotice, spillPageAdvice and noFileMountText.
const spillRow = projected(thinking);
const spillExtract = JSON.stringify(extract(spillRow, projected(publicText)));
const spillRowEnd = spillExtract.indexOf(JSON.stringify(spillRow)) + JSON.stringify(spillRow).length;
const spillHead = spillExtract.slice(0, spillRowEnd);
const spillPath = 'work/tool-results/2026-01-01-toolu_extract.txt';
const showing = `showing ${spillHead.length} of ${spillExtract.length} chars`;
const original = `original was ${spillExtract.length} chars`;
const success = `${showing}; full content: workspace file ${spillPath}. Page with workspace--read `
  + JSON.stringify({ path: spillPath, offsetChars: 0, limitChars: 1 })
  + '; use nextOffsetChars as offsetChars until null, keeping limitChars.';
const failure = `${showing}; spill to workspace file ${spillPath} FAILED (write refused); content over the cap was not retained`;
const noMount = `${original}; no writable workspace mount without an include`;

test.each([
  ['spill succeeded', success],
  ['spill succeeded with cap advice', success + ' Or raise the inline cap via agent_settings update tool_result_inline_max_chars.'],
  ['spill failed', failure],
  ['spill failed with a multiline error', failure.replace('write refused', 'write refused\nMount quota exceeded')],
  ['no writable mount', noMount + ', full content not retained'],
  ['direct-only mount', noMount + ' that keeps its files in the store, full content not retained'],
])('withholds a paired extract cut after a private row (%s)', (_label, notice) => {
  const { request, result } = requestWith(spillHead + `\n\n[truncated — ${notice}]`);
  expect(resultOf(filterStoredHistoryExtracts(request))).toEqual({
    ...result,
    content: '[history--extract result withheld: malformed JSON contains a private thinking block.]',
  });
});

test('does not strip spill notices with missing text or trailing content', () => {
  for (const suffix of [
    `\n\n[truncated — ${showing}; full content: workspace file ${spillPath}]`,
    `\n\n[truncated — ${failure.replace('; content over the cap was not retained', '')}]`,
    `\n\n[truncated — ${noMount}]`,
    `\n\n[truncated — ${success}]\n`,
    `\n\n[truncated — ${success}]\nmore text`,
  ]) {
    const { request } = requestWith(spillHead + suffix);
    expect(filterStoredHistoryExtracts(request)).toBe(request);
  }
});

test('preserves malformed bodies with markers only in arguments, quoted text, metadata or unknown shapes', () => {
  for (const payload of [
    extract(projected(ordinaryCall)),
    extract(projected({ type: 'text', text: exposed })),
    extract(projected(ordinaryCall, { type: 'tool_result', toolUseId: ordinaryCall.id, content: exposed })),
    extract(projected({ type: 'thinking', signature: 'not enough to recognize a block' })),
    { ...extract(projected(publicText)), metadata: redacted },
    { content: [thinking] },
  ]) {
    const text = JSON.stringify(payload);
    const cut = text.indexOf('fixture-signature');
    const { request } = requestWith(text.slice(0, cut < 0 ? -3 : cut + 'fixture-signature'.length));
    expect(filterStoredHistoryExtracts(request)).toBe(request);
  }
});

for (const lane of ['complete', 'stream'] as const) {
  test(`${lane} sends filtered copies only when explicitly enabled`, async () => {
    const { request, result } = requestWith(exposed);
    const original = JSON.stringify(request);
    const bodies: string[] = [];
    const reply = {
      id: 'msg_fixture', type: 'message', role: 'assistant', model: request.model,
      content: [], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const server = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      async fetch(req) {
        bodies.push(await req.text());
        if (lane === 'complete') return Response.json(reply);
        const events = [
          { type: 'message_start', message: { ...reply, stop_reason: null } },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
          { type: 'message_stop' },
        ];
        return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    });
    const config = { apiKey: 'test', baseURL: server.url.href, cacheKeepalive: { enabled: false } };
    const send = (adapter: AnthropicAdapter) => lane === 'complete'
      ? adapter.complete(request, { timeoutMs: 2000 })
      : adapter.stream(request, { onChunk() {} }, { timeoutMs: 2000 });
    try {
      await send(new AnthropicAdapter(config));
      await send(new LoggingAnthropicAdapter(config, '/dev/null'));
      await send(new LoggingAnthropicAdapter({ ...config, filterStoredHistoryExtractThinking: false }, '/dev/null'));
      await send(new LoggingAnthropicAdapter({ ...config, filterStoredHistoryExtractThinking: true }, '/dev/null'));
    } finally {
      server.stop(true);
    }
    expect(bodies).toHaveLength(4);
    expect(bodies[1]).toBe(bodies[0]);
    expect(bodies[2]).toBe(bodies[0]);
    expect(resultOf(JSON.parse(bodies[1]!))).toEqual(result);
    expect(resultOf(JSON.parse(bodies[3]!))).toEqual({ ...result, content: cleaned });
    expect(JSON.parse(bodies[3]!).messages[1]).toEqual(request.messages[1]);
    expect(JSON.stringify(request)).toBe(original);
  });
}

test('recipe accepts only a boolean opt-in and leaves the flag unset by default', () => {
  const recipe = (flags = {}) => ({ name: 'fixture', agent: { systemPrompt: 'Test.', ...flags } });
  expect(validateRecipe(recipe()).agent.filterStoredHistoryExtractThinking).toBeUndefined();
  for (const value of [true, false]) {
    expect(validateRecipe(recipe({ filterStoredHistoryExtractThinking: value })).agent.filterStoredHistoryExtractThinking).toBe(value);
  }
  expect(() => validateRecipe(recipe({ filterStoredHistoryExtractThinking: 'true' }))).toThrow(
    'Recipe agent.filterStoredHistoryExtractThinking must be a boolean',
  );
});
