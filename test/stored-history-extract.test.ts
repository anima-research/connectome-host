import { expect, test } from 'bun:test';
import { AnthropicAdapter, type ProviderRequest } from '@animalabs/membrane';
import { LoggingAnthropicAdapter } from '../src/logging-adapter.js';
import { validateRecipe } from '../src/recipe.js';
import { filterStoredHistoryExtracts } from '../src/stored-history-extract.js';

const extractName = 'history--extract';
const call = { type: 'tool_use', name: extractName, id: 'toolu_extract', input: { format: 'raw' } };
const act = { ...call, name: 'toolsets--act', input: { tool: ` ${extractName} `, args: call.input } };
const remoteAct = { ...act, id: 'toolu_remote', input: { ...act.input, server: ' remote ' } };
const otherAct = { ...act, id: 'toolu_other', input: { ...act.input, tool: 'fixture--read' } };
const withheld = '[history--extract result withheld: malformed JSON contains a private thinking block.]';
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

test('filters wire extracts called through local toolsets--act, not remote or unrelated acts', () => {
  for (const local of [act, { ...act, input: { ...act.input, server: '  ' } }]) {
    const { request, result } = requestWith(exposed, local);
    expect(resultOf(filterStoredHistoryExtracts(request))).toEqual({ ...result, content: cleaned });
  }
  for (const other of [remoteAct, otherAct]) {
    const { request } = requestWith(exposed, other, other.id);
    expect(filterStoredHistoryExtracts(request)).toBe(request);
  }
});

// Archived projection cases ported from AF #1041 (history-module.test.ts).
function archivedResult(toolUseId: string, content: unknown, toolName?: string) {
  return { type: 'tool_result', toolUseId, ...(toolName !== undefined ? { toolName } : {}), content, isError: false };
}

test('filters archived ACT results only when the call wrapped a local extract', () => {
  const direct = { ...call, id: 'toolu_direct' };
  const local = archivedResult(act.id, exposed, act.name);
  const unnamed = archivedResult(act.id, exposed);
  const unaffected = [
    archivedResult(remoteAct.id, exposed, act.name),
    archivedResult(otherAct.id, exposed, act.name),
    archivedResult(direct.id, exposed, act.name),
    archivedResult('off-page', exposed, act.name),
  ];
  const calls = projected(act, call, remoteAct, otherAct, direct);
  const { request } = requestWith(JSON.stringify(extract(calls, projected(local, unnamed, ...unaffected))));
  expect(JSON.parse(resultOf(filterStoredHistoryExtracts(request)).content as string)).toEqual(
    extract(calls, projected({ ...local, content: cleaned }, { ...unnamed, content: cleaned }, ...unaffected)),
  );
});

test('filters named extracts across page boundaries and honors archived provenance with duplicate IDs', () => {
  const offPage = archivedResult('off-page', [{ type: 'text', text: exposed }, publicText], extractName);
  const duplicate = { ...ordinaryCall, id: call.id };
  const named = archivedResult(call.id, exposed, extractName);
  const unnamed = archivedResult(call.id, exposed);
  const unrelated = archivedResult(call.id, exposed, ordinaryCall.name);
  const missing = archivedResult('off-page', exposed);
  const calls = projected(call, duplicate);
  const { request } = requestWith(JSON.stringify(extract(
    projected(offPage), calls, projected(named, unnamed, unrelated, missing),
  )));
  const sent = filterStoredHistoryExtracts(request);
  expect(JSON.parse(resultOf(sent).content as string)).toEqual(extract(
    projected({ ...offPage, content: [{ type: 'text', text: cleaned }, publicText] }),
    calls,
    projected({ ...named, content: cleaned }, { ...unnamed, content: cleaned }, unrelated, missing),
  ));
  expect(filterStoredHistoryExtracts(sent)).toBe(sent);
});

test('drops shared XML replay copies without breaking the archived tool exchange', () => {
  const rawItem = { type: 'function_call_output', output: exposed };
  const rawXml = `<function_results><result>${exposed}</result><result>saved</result></function_results>`;
  const differentXml = '<function_results><result>independent</result></function_results>';
  const extractResult = archivedResult(call.id, [{ type: 'text', text: exposed, rawItem }], extractName);
  const ordinaryResult = { ...archivedResult(ordinaryCall.id, 'saved'), rawItem: { output: 'saved' } };
  const unaffected = { ...archivedResult('independent', 'independent'), rawXml: differentXml, rawXmlImagesAt: 15 };
  const calls = projected(call, ordinaryCall);
  // Put the sibling before the rewritten result (and on a different row).
  const text = JSON.stringify(extract(calls,
    projected({ ...ordinaryResult, rawXml, rawXmlImagesAt: 15 }, unaffected),
    projected({ ...extractResult, rawItem, rawXml, rawXmlImagesAt: 15 }),
  ));
  const { request, result } = requestWith(text);
  const sent = filterStoredHistoryExtracts(request);
  expect(JSON.parse(resultOf(sent).content as string)).toEqual(extract(calls,
    projected(ordinaryResult, unaffected),
    projected({ ...extractResult, content: [{ type: 'text', text: cleaned }] }),
  ));
  expect(resultOf(sent).content).not.toContain('fixture-data');
  expect(result.content).toBe(text);
  expect(filterStoredHistoryExtracts(sent)).toBe(sent);
});

test('checks unfinished nested result strings using archived provenance, not lookalike contents', () => {
  for (const wrap of [(text: string) => text, (text: string) => [{ type: 'text', text }]]) {
    for (const [calls, nested, recognized] of [
      [[], archivedResult('off-page', wrap(exposed), extractName), true],
      [[act], archivedResult(act.id, wrap(exposed), act.name), true],
      [[call], archivedResult(call.id, wrap(exposed)), true],
      [[call], archivedResult(call.id, wrap(exposed), ordinaryCall.name), false],
      [[remoteAct], archivedResult(remoteAct.id, wrap(exposed), act.name), false],
    ] as const) {
      const serialized = JSON.stringify(extract(
        projected(...calls),
        projected(nested),
      ));
      // Cut inside the private string, before either JSON layer is complete.
      for (const suffix of ['\n\n[truncated — fixture]', '\\']) {
        const text = serialized.slice(0, serialized.indexOf('placeholder') + 3) + suffix;
        const { request, result } = requestWith(text);
        const sent = filterStoredHistoryExtracts(request);
        if (recognized) expect(resultOf(sent)).toEqual({ ...result, content: withheld });
        else expect(sent).toBe(request);
        expect(result.content).toBe(text);
      }
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

test('recovers at the first truncation marker regardless of notice wording or trailing content', () => {
  for (const suffix of [
    `\n\n[truncated — ${showing}; full content: workspace file ${spillPath}]`,
    `\n\n[truncated — ${failure.replace('; content over the cap was not retained', '')}]`,
    `\n\n[truncated — ${noMount}]`,
    `\n\n[truncated — ${success}]\n`,
    `\n\n[truncated — ${success}]\nmore text`,
    '\n\n[truncated — original was 101 tokens]',
    '\r\n\r\n[truncated — original was 101 tokens]',
    '\n\n[truncated — showing 100\n\n[truncated — original was 101 tokens]',
  ]) {
    const { request } = requestWith(spillHead + suffix);
    expect(resultOf(filterStoredHistoryExtracts(request)).content).toBe(withheld);
  }
  const clean = JSON.stringify(extract(projected(publicText)));
  for (const text of [
    clean.slice(0, -3) + '\n\n[truncated — original was 101 tokens]',
    JSON.stringify(extract(projected({ type: 'text', text: '\n\n[truncated — literal text]' }))),
  ]) {
    const { request } = requestWith(text);
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
    const { request, result } = requestWith(exposed, lane === 'stream' ? act : call);
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
