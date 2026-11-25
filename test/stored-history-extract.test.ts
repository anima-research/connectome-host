import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const opus55 = 'claude-opus-5-5';

function fixtureStream(model: string, blocks: Array<Record<string, unknown>> = [], stopReason = 'end_turn'): Response {
  const events = [
    { type: 'message_start', message: {
      id: 'msg_fixture', type: 'message', role: 'assistant', model, content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
    } },
    ...blocks,
    { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ];
  return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}

function signedEvents() {
  return [
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: thinking.thinking } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: thinking.signature } },
    { type: 'content_block_stop', index: 0 },
  ];
}

for (const lane of ['complete', 'stream'] as const) {
  test.each([
    ['unbound thinking', 'claude-opus-4-6', thinking, false, undefined],
    ['strict binding', 'claude-mythos-5-1', thinking, true, 'thinking binds'],
    ['drop-capable with native thinking', opus55, redacted, lane === 'complete', lane === 'complete' ? 'complete request carries native thinking' : undefined],
    ['drop-capable without native thinking', opus55, undefined, false, undefined],
    ['unknown gateway alias', 'resident-model', thinking, true, 'model not recognized'],
  ] as const)(`${lane} applies the extract guard according to binding support (%s)`, async (_label, model, laterThinking, skipped, reason) => {
    const { request: base, result } = requestWith(exposed, lane === 'stream' ? act : call);
    const suffixCall = { ...call, id: 'toolu_suffix' };
    const suffixResult = { ...result, tool_use_id: suffixCall.id };
    const request = {
      ...base,
      model,
      messages: [
        base.messages[0],
        laterThinking ? base.messages[1] : { role: 'assistant', content: [lane === 'stream' ? act : call] },
        base.messages[2],
        { role: 'assistant', content: laterThinking ? [laterThinking, suffixCall] : [suffixCall] },
        { role: 'user', content: [suffixResult] },
      ],
    };
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
        return lane === 'complete' ? Response.json(reply) : fixtureStream(model);
      },
    });
    const config = { apiKey: 'test', baseURL: server.url.href, cacheKeepalive: { enabled: false } };
    const send = (adapter: AnthropicAdapter, input = request) => lane === 'complete'
      ? adapter.complete(input, { timeoutMs: 2000 })
      : adapter.stream(input, { onChunk() {} }, { timeoutMs: 2000 });
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await send(new AnthropicAdapter(config));
      await send(new LoggingAnthropicAdapter(config, '/dev/null'));
      await send(new LoggingAnthropicAdapter({ ...config, filterStoredHistoryExtractThinking: false }, '/dev/null'));
      expect(warn).not.toHaveBeenCalled();
      const enabled = new LoggingAnthropicAdapter({ ...config, filterStoredHistoryExtractThinking: true }, '/dev/null');
      await send(enabled);
      await send(enabled);
      expect(warn.mock.calls).toEqual(reason ? [[`[history--extract] guard not applied to ${model}: ${reason}.`]] : []);
      if (reason === 'model not recognized') {
        const alias = { ...request, model: 'another-resident-model' };
        await send(enabled, alias);
        await send(enabled, alias);
        expect(warn.mock.calls.slice(1)).toEqual([
          ['[history--extract] guard not applied to another-resident-model: model not recognized.'],
        ]);
      }
    } finally {
      warn.mockRestore();
      server.stop(true);
    }
    expect(bodies).toHaveLength(reason === 'model not recognized' ? 7 : 5);
    if (lane === 'complete' || model === 'claude-opus-4-6' || model === 'resident-model') expect(bodies[1]).toBe(bodies[0]);
    expect(bodies[2]).toBe(bodies[1]);
    expect(resultOf(JSON.parse(bodies[1]!))).toEqual(result);
    expect(bodies[4]).toBe(bodies[3]);
    if (skipped) {
      // Even the result after the last signed or redacted block is unchanged.
      expect(bodies[3]).toBe(bodies[2]);
    } else {
      const sent = JSON.parse(bodies[3]!);
      expect(sent.messages).toEqual([
        ...request.messages.slice(0, 2),
        { role: 'user', content: [{ ...result, content: cleaned }] },
        request.messages[3],
        { role: 'user', content: [{ ...suffixResult, content: cleaned }] },
      ]);
    }
    expect(JSON.stringify(request)).toBe(original);
  });
}

test('Opus 5.5 accepts a second stream with the same signed prefix and both extracts filtered', async () => {
  const { request, result } = requestWith(exposed);
  const first = { ...request, model: opus55 };
  const suffix = { ...call, id: 'toolu_new_extract' };
  let prefix: string | undefined;
  let acceptedSecond = false;
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(req) {
      const wire = await req.text();
      const body = JSON.parse(wire);
      if (prefix === undefined) {
        const last = JSON.stringify(body.messages[2]);
        const start = wire.indexOf(last);
        if (start < 0) return new Response('Fixture could not locate the old extract message', { status: 400 });
        prefix = wire.slice(0, start + last.length);
        return fixtureStream(opus55, signedEvents());
      }
      acceptedSecond = wire.startsWith(prefix)
        && body.thinking?.block_binding?.prefix_mismatch_behavior === 'drop_block'
        && req.headers.get('anthropic-beta')?.includes('thinking-binding-controls-2026-08-01') === true
        && body.messages[3]?.content[0]?.signature === thinking.signature
        && body.messages[2]?.content[0]?.content === cleaned
        && body.messages[4]?.content[0]?.content === cleaned;
      return acceptedSecond ? fixtureStream(opus55)
        : Response.json({ type: 'error', error: {
          type: 'invalid_request_error', message: 'fixture rejected a changed prefix or unfiltered extract',
        } }, { status: 400 });
    },
  });
  try {
    const adapter = new LoggingAnthropicAdapter({
      apiKey: 'test', baseURL: server.url.href, cacheKeepalive: { enabled: false }, filterStoredHistoryExtractThinking: true,
    }, '/dev/null');
    const send = (input: ProviderRequest) => adapter.stream(input, { onChunk() {} }, { timeoutMs: 2000 });
    const minted = await send(first);
    expect(minted.content).toEqual([thinking]);
    const second = await send({ ...first, messages: [
      ...first.messages,
      { role: 'assistant', content: [...minted.content, suffix] },
      { role: 'user', content: [{ ...result, tool_use_id: suffix.id }] },
    ] });
    expect(acceptedSecond).toBe(true);
    expect(second.stopReason).toBe('end_turn');
  } finally {
    server.stop(true);
  }
});

test('the recipe opt-in reaches the Anthropic adapter on a real host turn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'extract-recipe-'));
  const model = 'claude-opus-4-6';
  let requests = 0;
  let captured: string | undefined;
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== '/v1/messages') return new Response(null, { status: 404 });
      const body = await req.json();
      if (!body.stream) return new Response(null, { status: 400 });
      if (++requests === 1) return fixtureStream(model, [
        ...signedEvents(),
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Fixture reply.' } },
        { type: 'content_block_stop', index: 1 },
      ]);
      const result = body.messages.flatMap((message: { content: unknown[] }) => message.content)
        .find((block: { type: string; tool_use_id?: string }) => block.type === 'tool_result' && block.tool_use_id === call.id);
      if (result) {
        captured = typeof result.content === 'string' ? result.content
          : result.content.map((part: { text?: string }) => part.text ?? '').join('');
        return fixtureStream(model);
      }
      return fixtureStream(model, [
        { type: 'content_block_start', index: 0, content_block: { ...call, input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } },
        { type: 'content_block_stop', index: 0 },
      ], 'tool_use');
    },
  });
  try {
    for (const enabled of [false, true]) {
      captured = undefined;
      requests = 0;
      const recipe = join(dir, 'recipe.json');
      writeFileSync(recipe, JSON.stringify({
        name: 'Extract guard wiring', agent: {
          provider: 'anthropic', model, systemPrompt: 'Fixture.', filterStoredHistoryExtractThinking: enabled,
          thinking: { enabled: true, budgetTokens: 2048 },
        },
        modules: { history: true, subagents: false, lessons: false, retrieval: false, wake: false, workspace: false },
      }));
      const child = Bun.spawn([process.execPath, fileURLToPath(new URL('../src/index.ts', import.meta.url)), recipe, '--no-tui'], {
        cwd: dir, stdin: new Blob(['Seed the history.\nRead our raw history.\n']), stdout: 'pipe', stderr: 'pipe', timeout: 12_000,
        env: {
          ...process.env, DATA_DIR: join(dir, String(enabled)), MODEL: '',
          ANTHROPIC_API_KEY: 'fixture', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_OAUTH_CREDENTIALS_FILE: '',
          ANTHROPIC_BASE_URL: server.url.href, THINKING_BINDING_PROBE: 'off',
        },
      });
      const [status, stdout, stderr] = await Promise.all([child.exited, child.stdout.text(), child.stderr.text()]);
      if (status !== 0 || captured === undefined) {
        throw new Error(`No extract result from host (${status}, ${requests} requests):\n${stdout}\n${stderr}`);
      }
      const page = JSON.stringify(JSON.parse(captured).messages);
      expect(page).toContain('Fixture reply.');
      if (enabled) expect(page).not.toContain(thinking.signature);
      else expect(page).toContain(thinking.signature);
    }
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

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
