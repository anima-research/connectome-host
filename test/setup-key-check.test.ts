import { afterAll, describe, expect, test } from 'bun:test';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicAdapter } from '@animalabs/membrane';
import { checkKey, type KeyCheck } from '../src/setup/key-check.js';

const seen: Array<{ key: string | null; body: { model?: unknown; max_tokens?: unknown; messages?: unknown; stream?: unknown } }> = [];
const started = (message: Record<string, unknown>) => ({ type: 'message_start', message });
const USAGE = { input_tokens: 5, output_tokens: 1 };
const ended = (usage: Record<string, unknown> | null = { output_tokens: 1 }) =>
  ({ type: 'message_delta', delta: { stop_reason: 'max_tokens', stop_sequence: null }, ...(usage ? { usage } : {}) });
const sse = (body: string | ReadableStream<Uint8Array>) => new Response(body, { headers: { 'content-type': 'text/event-stream' } });
const named = (list: Array<Record<string, unknown>>, end = '\n') =>
  list.map((event) => `event: ${String(event.type)}${end}data: ${JSON.stringify(event)}${end}${end}`).join('');
const MESSAGE = { type: 'message', role: 'assistant', content: [], usage: USAGE };
const BLOCK = [
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'O' } },
  { type: 'content_block_stop', index: 0 },
];
const whole = (message: Record<string, unknown> = MESSAGE) => [started(message), ...BLOCK, ended(), { type: 'message_stop' }];
const held = (text: string) => sse(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); } }));
const pieces = (text: string, size: number) => sse(new ReadableStream({
  start(controller) {
    const bytes = new TextEncoder().encode(text);
    for (let at = 0; at < bytes.length; at += size) controller.enqueue(bytes.slice(at, at + size));
    controller.close();
  },
}));
const READ: Record<string, () => Response> = {
  ok: () => sse(named(whole())),
  roleless: () => sse(named(whole({ content: [], usage: USAGE }))),
  cr: () => sse(named(whole(), '\r')),
  crlf: () => sse(named(whole(), '\r\n')),
  chunked: () => pieces(named(whole(), '\r\n'), 7),
  open: () => held(named([started(MESSAGE), ...BLOCK, ended()])),
  lateerror: () => sse(named([started(MESSAGE), ended(), { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }])),
  pinged: () => sse(named([started(MESSAGE), { type: 'ping' }, { type: 'unknown_event' }, ...BLOCK, ended(), { type: 'message_stop' }])),
};
const UNREAD: Record<string, () => Response> = {
  nameless: () => sse(whole().map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')),
  nousage: () => sse(named(whole({ type: 'message', role: 'assistant', content: [] }))),
  truncated: () => sse(named([started(MESSAGE), ...BLOCK])),
  nodeltausage: () => sse(named([started(MESSAGE), ...BLOCK, ended(null), { type: 'message_stop' }])),
  badblock: () => sse(`${named([started(MESSAGE), BLOCK[0]!])}event: content_block_delta\ndata: {not json\n\n${named([ended()])}`),
  colonless: () => sse(`event: message_start\nevent\ndata: ${JSON.stringify(started(MESSAGE))}\n\n${named([ended(), { type: 'message_stop' }])}`),
  typeless: () => sse(named(whole()).replace('data: {"type":"message_start",', 'data: {')),
  twostarts: () => sse(named([started(MESSAGE), started(MESSAGE), ended(), { type: 'message_stop' }])),
  nodelta: () => sse(named([started(MESSAGE), BLOCK[0]!, { type: 'content_block_delta', index: 0 }, ended()])),
};
/** Read or not as the agent's client decides, which the agreement test asks of it: a lone CR ends the last line of
 *  an answer held open. */
const EDGE: Record<string, () => Response> = {
  crheld: () => held(named([started(MESSAGE), ended()], '\r')),
};
const ERRORED: Record<string, () => Response> = {
  streamerror: () => sse(named([started(MESSAGE), { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }])),
  streamfailed: () => sse(named([started(MESSAGE), { type: 'error', error: { type: 'api_error', message: 'Internal server error' } }])),
};
const STREAMS: Record<string, () => Response> = { ...READ, ...UNREAD, ...EDGE, ...ERRORED };
const ORCA = 'OrcaRouter doesn\'t stream responses to callers, so nothing ran: send the request again without `stream: true`';
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const [, choice, ...rest] = url.pathname.split('/');
    if (request.method !== 'POST' || rest.join('/') !== 'v1/messages' || !request.headers.get('x-api-key')
      || request.headers.get('anthropic-version') !== '2023-06-01') {
      return new Response('not the Messages API', { status: 400 });
    }
    const key = request.headers.get('x-api-key');
    const body = await request.json() as { model?: unknown; max_tokens?: unknown; messages?: unknown };
    const turns = Array.isArray(body.messages) ? body.messages as Array<{ role?: unknown; content?: unknown }> : [];
    const shaped = typeof body.model === 'string' && body.model !== ''
      && typeof body.max_tokens === 'number' && Number.isInteger(body.max_tokens) && body.max_tokens > 0
      && turns.length > 0 && turns[0]!.role === 'user'
      && turns.every((turn) => (turn.role === 'user' || turn.role === 'assistant')
        && (typeof turn.content === 'string' || (Array.isArray(turn.content) && turn.content.every((block: unknown) =>
          typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text'
          && typeof (block as { text?: unknown }).text === 'string'))));
    if (!shaped) return new Response('not a request the Messages API takes', { status: 400 });
    seen.push({ key, body });
    const stream = STREAMS[choice!];
    if (stream) return stream();
    if (choice === 'whole') return Response.json({ id: 'msg_1', type: 'message', role: 'assistant', content: [] });
    if (choice === 'nostream') return Response.json({ type: 'error', error: { type: 'invalid_request_error', message: ORCA } }, { status: 400 });
    if (choice === 'html') return new Response('<html>a sign-in page</html>', { headers: { 'content-type': 'text/html' } });
    if (choice === 'bare') return Response.json({ type: 'message' });
    if (choice === 'norole') return Response.json({ type: 'message', content: [] });
    if (choice === 'nocontent') return Response.json({ type: 'message', role: 'assistant', content: 'ok' });
    if (choice === 'notype') return Response.json({ role: 'assistant', content: [] });
    if (choice === 'errortype') return Response.json({ type: 'error', role: 'assistant', content: [] });
    if (choice === 'typekey') return new Response('<html></html>', { headers: { 'content-type': `text/html; key=${key}` } });
    if (choice === 'waitkey') return new Response('', { status: 429, headers: { 'retry-after': `${key}` } });
    if (choice === 'stall' || choice === 'stall401' || choice === 'stall429') {
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"type":')); } }), {
        status: choice === 'stall' ? 200 : Number(choice.slice(5)),
        headers: { 'content-type': 'application/json', 'retry-after': '37' },
      });
    }
    if (choice === 'waitempty') return new Response('', { status: 429, headers: { 'retry-after': '' } });
    if (choice === 'waitdate') return new Response('', { status: 429, headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' } });
    if (choice === 'echo') return Response.json({ type: 'error', error: { type: 'x', message: `no such key: ${key}` } }, { status: 401 });
    if (choice === 'wait') {
      return Response.json({ type: 'error', error: { type: 'x', message: 'slow down' } }, { status: 429, headers: { 'retry-after': '37' } });
    }
    if (choice === 'silent') return new Promise<Response>(() => {});
    const status = Number(choice);
    return Response.json({ type: 'error', error: { type: 'x', message: `the server's own words for ${status}` } }, { status });
  },
});
// Speaks plain HTTP, so an https:// call to it fails its TLS handshake.
const plain = Bun.serve({ port: 0, fetch: () => new Response('plain') });
afterAll(() => {
  server.stop(true);
  plain.stop(true);
});
const at = (choice: string | number) => `http://127.0.0.1:${server.port}/${choice}`;
const cause = (result: KeyCheck) => (result as { cause: string }).cause;

describe("the key's one real call", () => {
  test('a key that works passes, after one streamed call of one token to the setup model, as the agent streams its own', async () => {
    seen.length = 0;
    expect(await checkKey({ key: 'sk-ant-good', model: 'claude-x', baseUrl: at('ok') })).toEqual({ ok: true });
    expect(seen).toEqual([{ key: 'sk-ant-good', body: expect.objectContaining({ model: 'claude-x', max_tokens: 1, stream: true }) }]);
  });

  test('a stream the agent\'s client reads as one message passes, well before its limit: no role or type needed, any line endings, read over several reads, pings and unknown events ignored, and nothing after its message_delta judged, though the server holds it open', async () => {
    for (const choice of Object.keys(READ)) {
      expect(await checkKey({ key: 'k', model: 'm', baseUrl: at(choice), timeoutMs: 60_000 }), choice).toEqual({ ok: true });
    }
  });

  test('a stream the agent\'s client can\'t read as one message doesn\'t pass, quoting why: no event names, a start with no usage, an end with no usage, no end at all, data that isn\'t JSON, an event line reset, an event of no type, two starts, a block delta with no delta', async () => {
    for (const choice of Object.keys(UNREAD)) {
      const result = await checkKey({ key: 'k', model: 'm', baseUrl: at(choice) });
      expect(result, choice).toEqual({
        ok: false, anotherKeyMayHelp: false,
        cause: expect.stringContaining('(text/event-stream), but not with a message from Anthropic\'s Messages API as the agent\'s client reads one: '),
      });
      expect(cause(result), choice).toMatch(/reads one: \S.*\. So the key isn't known to work\./);
    }
    expect(cause(await checkKey({ key: 'k', model: 'm', baseUrl: at('truncated') }))).toContain('the stream ended before its message did.');
  });

  test('a server that answers the streamed call with JSON doesn\'t pass: the agent reads its answers as a stream', async () => {
    const result = await checkKey({ key: 'k', model: 'm', baseUrl: at('whole') });
    expect(result).toEqual({ ok: false, cause: expect.stringContaining('answered 200 with application/json'), anotherKeyMayHelp: false });
    expect(cause(result)).toContain(' where the check asked for an event stream, so the key isn\'t known to work.');
    const own = await checkKey({ key: 'k', model: 'm', fetch: (async () => Response.json({ type: 'message', role: 'assistant', content: [] })) as unknown as typeof fetch });
    const named = await checkKey({ key: 'json', model: 'm', baseUrl: at('whole') });
    expect(cause(named)).toContain('with application/<ANTHROPIC_API_KEY>;charset=utf-8 where the check asked for an event stream');
    expect(cause(own)).toContain('Setup\'s agent streams every turn, so a server that answers only unstreamed calls can\'t serve it. Something on the way to Anthropic\'s API, such as a proxy, may have answered in its place.');
    expect(cause(result)).toContain('Setup\'s agent streams every turn, so a gateway that answers only unstreamed calls can\'t serve it. Point ANTHROPIC_BASE_URL in .env at one that streams (a URL put right there is read at the next try), or take it out for Anthropic\'s own API.');
  });

  test('a refusal through ANTHROPIC_BASE_URL says the agent streams every turn, as the check did, beside the server\'s own words', async () => {
    const result = await checkKey({ key: 'k', model: 'm', baseUrl: at('nostream') });
    expect(result).toMatchObject({ ok: false, anotherKeyMayHelp: true });
    expect(cause(result)).toContain(`answered 400. It said: "${ORCA}".`);
    expect(cause(result)).toContain('Setup\'s agent streams every turn, as this check did, so a gateway that answers only unstreamed calls can\'t serve it.');
    const own = await checkKey({
      key: 'k', model: 'm',
      fetch: (async () => Response.json({ type: 'error', error: { type: 'x', message: 'Your credit balance is too low' } }, { status: 400 })) as unknown as typeof fetch,
    });
    expect(cause(own)).not.toContain('streams every turn');
  });

  test('an error in the stream fails the check with its words, and an overloaded one says to try again, not another key', async () => {
    const result = await checkKey({ key: 'k', model: 'm', baseUrl: at('streamerror') });
    expect(result).toEqual({ ok: false, cause: expect.stringContaining('It said: "Overloaded".'), anotherKeyMayHelp: false });
    expect(cause(result)).toContain('Try again in a few minutes.');
    const other = await checkKey({ key: 'k', model: 'm', baseUrl: at('streamfailed') });
    expect(other).toEqual({ ok: false, cause: expect.stringContaining('It said: "Internal server error".'), anotherKeyMayHelp: false });
    expect(cause(other)).toContain('Try again shortly.');
  });

  test('a body that breaks off partway is the call failing, named by its code, not an answer from something else', async () => {
    const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const result = await checkKey({
      key: 'sk-ant-test', model: 'm', baseUrl: 'https://gw.example',
      fetch: (async () => sse(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(named([started(MESSAGE)])));
          controller.error(reset);
        },
      }))) as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: false, cause: expect.stringContaining('The call to gw.example failed (ECONNRESET: socket hang up).'), anotherKeyMayHelp: false });
    expect(cause(result)).not.toContain('Messages API');
  });

  test('calls the URL the agent\'s Anthropic SDK calls for the same ANTHROPIC_BASE_URL', async () => {
    for (const baseUrl of ['https://gw.example', 'https://gw.example/', 'https://gw.example/anthropic', 'https://gw.example/anthropic//']) {
      const called: string[] = [];
      const capture = (async (url: string | URL | Request) => {
        called.push(String(url));
        throw Object.assign(new TypeError('stop here'), { code: 'ECONNREFUSED' });
      }) as unknown as typeof fetch;
      await new Anthropic({ apiKey: 'k', baseURL: baseUrl, fetch: capture, maxRetries: 0 }).messages
        .create({ model: 'm', max_tokens: 1, messages: [{ role: 'user', content: 'ok' }] }).catch(() => undefined);
      await checkKey({ key: 'k', model: 'm', baseUrl, fetch: capture });
      expect(called, baseUrl).toHaveLength(2);
      expect(called[1], baseUrl).toBe(called[0]);
    }
  });

  test("each refusal names its cause and the server's own words, never the key, and says whether another key may help", async () => {
    for (const [status, words, anotherKeyMayHelp] of [
      [401, 'refused the key (401)', true],
      [403, 'refused this call (403)', true],
      [404, 'found nothing for claude-x (404)', true],
      [529, 'overloaded (529)', false],
      [500, 'answered 500', false],
    ] as const) {
      const result = await checkKey({ key: 'sk-ant-bad', model: 'claude-x', baseUrl: at(status) });
      expect(result, String(status)).toEqual({ ok: false, cause: expect.stringContaining(words), anotherKeyMayHelp });
      expect(cause(result), String(status)).toContain(`"the server's own words for ${status}".`);
      expect(cause(result), String(status)).not.toContain('sk-ant-bad');
    }
  });

  test('a key a request header can\'t carry is named as the key\'s cause, another key may help, and nothing is called; one it can carry is sent', async () => {
    for (const key of ['sk-ant-line\u2028separated', 'sk-ant-zero\u200bwidth', 'sk-ant-\u0100']) {
      let called = 0;
      const result = await checkKey({ key, model: 'm', fetch: (async () => { called += 1; return Response.json({}); }) as unknown as typeof fetch });
      expect(result, JSON.stringify(key)).toEqual({ ok: false, cause: "The key holds a character a request header can't carry, so it can't be sent, and no call was made. Check what was copied.", anotherKeyMayHelp: true });
      expect(called, JSON.stringify(key)).toBe(0);
    }
    for (const key of ['sk-ant-\u0093', 'sk-ant-\u00a0', 'sk-ant-\u00e9']) {
      let sent: string | null = null;
      await checkKey({ key, model: 'm', fetch: (async (_url: string, init: RequestInit) => { sent = new Headers(init.headers).get('x-api-key'); return Response.json({ type: 'message', role: 'assistant', content: [] }); }) as unknown as typeof fetch });
      expect(sent, JSON.stringify(key)).toBe(key);
    }
  });

  test('a 404 through ANTHROPIC_BASE_URL names both causes it can have, and says that a URL put right in .env is read at the next try', async () => {
    const result = await checkKey({ key: 'k', model: 'claude-x', baseUrl: at(404) });
    expect(cause(result)).toContain("Either this key can't use claude-x, or ANTHROPIC_BASE_URL doesn't lead to Anthropic's Messages API");
    expect(cause(result)).toContain("If it's the URL, put it right in .env and type the key again: each try reads it there.");
  });

  test('a refused key through ANTHROPIC_BASE_URL is to be checked against what that origin accepts, not Anthropic\'s console', async () => {
    const through = await checkKey({ key: 'k', model: 'm', baseUrl: at(401) });
    expect(cause(through)).toContain(`Check that it was copied whole, and that it's a key http://127.0.0.1:${server.port} accepts.`);
    expect(cause(through)).not.toContain('console.anthropic.com');
    const own = await checkKey({
      key: 'k', model: 'm',
      fetch: (async () => Response.json({ type: 'error', error: { type: 'x', message: 'invalid x-api-key' } }, { status: 401 })) as unknown as typeof fetch,
    });
    expect(cause(own)).toContain('Check that it was copied whole, from console.anthropic.com\'s API keys.');
  });

  test('any other status says the key isn\'t known to work, and what to try: again later for a server error, the URL otherwise', async () => {
    const failing = await checkKey({ key: 'k', model: 'm', baseUrl: at(503) });
    expect(failing).toEqual({ ok: false, cause: expect.stringContaining('answered 503.'), anotherKeyMayHelp: false });
    expect(cause(failing)).toContain("So the key isn't known to work. Its side had a problem: try again shortly.");
    const odd = await checkKey({ key: 'k', model: 'm', baseUrl: at(418) });
    expect(cause(odd)).toContain("So the key isn't known to work. It may be about this key or its account there, or ANTHROPIC_BASE_URL may not lead to Anthropic's Messages API: a URL put right in .env is read at the next try.");
    expect(odd).toMatchObject({ anotherKeyMayHelp: true });
  });

  test('another status of Anthropic\'s own API below 500 says it may be the key\'s account, and that another key can help; a 408, a server that stopped waiting, says to try again; and a 3xx is followed nowhere, with neither its words nor its Location quoted, since they\'re the server\'s own text, which can carry a credential', async () => {
    const own = await checkKey({
      key: 'k', model: 'm',
      fetch: (async () => Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low' } }, { status: 400 })) as unknown as typeof fetch,
    });
    expect(own).toEqual({ ok: false, cause: expect.stringContaining('answered 400. It said: "Your credit balance is too low".'), anotherKeyMayHelp: true });
    expect(cause(own)).toContain("So the key isn't known to work. It may be about this key or its account: another key, or the account put right at console.anthropic.com, can help.");
    const timedOut = await checkKey({ key: 'k', model: 'm', fetch: (async () => new Response('', { status: 408 })) as unknown as typeof fetch });
    expect(timedOut).toEqual({ ok: false, cause: expect.stringContaining('answered 408.'), anotherKeyMayHelp: false });
    expect(cause(timedOut)).toContain("So the key isn't known to work. It stopped waiting for the call: try again shortly.");
    const seen: string[] = [];
    const elsewhere = Bun.serve({ port: 0, fetch: (request) => { seen.push(request.headers.get('x-api-key') ?? ''); return new Response('{}'); } });
    const sending = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 307, headers: { Location: `http://localhost:${elsewhere.port}/v1/messages` } }) });
    try {
      const through = await checkKey({ key: 'sk-redirected-key', model: 'm', baseUrl: `http://127.0.0.1:${sending.port}` });
      expect(through).toEqual({ ok: false, cause: expect.stringContaining('answered 307.'), anotherKeyMayHelp: false });
      expect(cause(through)).toContain(`answered 307. So the key isn't known to work. Anthropic's Messages API answers with no 3xx, and setup follows no redirect, so the key went no further. ANTHROPIC_BASE_URL in .env may not lead to that API (a URL put right there is read at the next try), or something on the way to it, such as a proxy or a captive portal, may have answered in its place. Check this machine's network and any proxy it goes through (HTTPS_PROXY), and ANTHROPIC_BASE_URL, which leads to http://127.0.0.1:${sending.port} now.`);
      expect(cause(through)).not.toContain('localhost');
      expect(seen).toEqual([]);
    } finally {
      sending.stop(true);
      elsewhere.stop(true);
    }
    const redirected = await checkKey({
      key: 'Sk-Mixed-Case-Key', model: 'm',
      fetch: (async () => Response.json({ error: { message: 'moved to https://sk-mixed-case-key.portal.example/login' } }, { status: 302, headers: { Location: 'https://Sk-Mixed-Case-Key.portal.example/login' } })) as unknown as typeof fetch,
    });
    expect(redirected).toEqual({ ok: false, cause: expect.stringContaining('answered 302.'), anotherKeyMayHelp: false });
    expect(cause(redirected)).toContain('answered 302. So the key isn\'t known to work. Anthropic\'s Messages API answers with no 3xx, and setup follows no redirect, so the key went no further. Something on the way to it, such as a proxy or a captive portal, may have answered in its place. Check this machine\'s network and any proxy it goes through (HTTPS_PROXY).');
    expect(cause(redirected).toLowerCase()).not.toContain('sk-mixed-case-key');
    expect(cause(redirected)).not.toContain('Location');
    expect(cause(redirected)).not.toContain('moved to');
    const encoded = await checkKey({
      key: 'sk-ant-key', model: 'm',
      fetch: (async () => new Response(null, { status: 302, headers: { Location: 'https://portal.example/?k=sk%2Dant%2Dkey&u=https://user:gateway-secret@other.example/' } })) as unknown as typeof fetch,
    });
    expect(cause(encoded)).not.toContain('portal.example');
    expect(cause(encoded)).not.toContain('gateway-secret');
    const unmoved = await checkKey({ key: 'k', model: 'm', fetch: (async () => new Response(null, { status: 304 })) as unknown as typeof fetch });
    expect(cause(unmoved)).toContain("answered 304. So the key isn't known to work. Anthropic's Messages API answers with no 3xx, and setup follows no redirect");
    expect(cause(unmoved)).not.toContain('Location');
    const through = await checkKey({ key: 'k', model: 'm', baseUrl: at(400) });
    expect(through).toMatchObject({ anotherKeyMayHelp: true });
  });

  test('a server that quotes the key as fetch sent it, trimmed, gets the key replaced there too', async () => {
    const result = await checkKey({ key: '  sk-ant-padded-secret ', model: 'm', baseUrl: at('echo') });
    expect(cause(result)).not.toContain('sk-ant-padded-secret');
    expect(cause(result)).toContain('no such key: <ANTHROPIC_API_KEY>');
  });

  test('a key of spaces alone leaves the server\'s words as they are', async () => {
    const result = await checkKey({
      key: ' ', model: 'm',
      fetch: (async () => Response.json({ type: 'error', error: { type: 'x', message: 'invalid x-api-key header given' } }, { status: 401 })) as unknown as typeof fetch,
    });
    expect(cause(result)).toContain('It said: "invalid x-api-key header given".');
  });

  test('a server that echoes the key gets its words quoted with the key replaced, in its body and its headers', async () => {
    for (const key of ['sk-ant-echoed-secret', 'sk-ant-ends-with-a-period.']) {
      const result = await checkKey({ key, model: 'm', baseUrl: at('echo') });
      expect(cause(result), key).not.toContain('sk-ant-e');
      expect(cause(result), key).toContain('no such key: <ANTHROPIC_API_KEY>');
    }
    for (const choice of ['typekey', 'waitkey']) {
      const result = await checkKey({ key: 'sk-ant-in-a-header', model: 'm', baseUrl: at(choice) });
      expect(cause(result), choice).not.toContain('sk-ant-in-a-header');
      expect(cause(result), choice).toContain('<ANTHROPIC_API_KEY>');
    }
  });

  test('words quoting ANTHROPIC_BASE_URL show only where it leads', async () => {
    const baseUrl = 'https://someone:pass-in-url@gw.example/private-path?token=in-query';
    const result = await checkKey({
      key: 'sk-ant-test-key', model: 'm', baseUrl,
      fetch: (async (url: string) => { throw new Error(`the proxy couldn't reach ${url} (${baseUrl})`); }) as unknown as typeof fetch,
    });
    for (const hidden of ['pass-in-url', 'someone', 'private-path', 'in-query']) expect(cause(result)).not.toContain(hidden);
    expect(cause(result)).toContain("the proxy couldn't reach https://gw.example");

    for (const baseUrl of ['https://someone:pass-in-url@GW.Example/private-path?token=in-query', 'https://someone:pass-in-url@gw.example']) {
      const normalized = await checkKey({
        key: 'sk-ant-test-key', model: 'm', baseUrl,
        fetch: (async (url: string) => { throw new Error(`no route to ${new URL(url).href} (${new URL(baseUrl).href})`); }) as unknown as typeof fetch,
      });
      for (const hidden of ['pass-in-url', 'someone', 'private-path', 'in-query']) expect(cause(normalized), baseUrl).not.toContain(hidden);
      expect(cause(normalized), baseUrl).toContain('no route to https://gw.example');
    }
  });

  test("a 2xx that isn't a message, from Anthropic's own API, names something on the way that may have answered in its place", async () => {
    const page = (async () => new Response('<html>a sign-in page</html>', { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
    const own = await checkKey({ key: 'k', model: 'm', fetch: page });
    expect(own).toEqual({ ok: false, cause: expect.stringContaining('not with a message'), anotherKeyMayHelp: false });
    expect(cause(own)).toContain('Something on the way to it, such as a proxy or a captive portal, may have answered in its place. Check this machine\'s network and any proxy it goes through (HTTPS_PROXY).');
    expect(cause(await checkKey({ key: 'k', model: 'm', baseUrl: at('html') }))).not.toContain('captive portal');
  });

  test("a 2xx that isn't a message from the Messages API doesn't pass", async () => {
    const result = await checkKey({ key: 'k', model: 'm', baseUrl: at('html') });
    expect(result).toEqual({ ok: false, cause: expect.stringContaining('not with a message'), anotherKeyMayHelp: false });
    expect(cause(result)).toContain('text/html');
    for (const choice of ['bare', 'norole', 'nocontent', 'notype', 'errortype']) {
      expect(await checkKey({ key: 'k', model: 'm', baseUrl: at(choice) }), choice).toEqual({
        ok: false, cause: expect.stringContaining('where the check asked for an event stream'), anotherKeyMayHelp: false,
      });
    }
  });

  test('a 2xx whose body never comes is named as a server that didn\'t answer, not as a wrong answer', async () => {
    let answered = false;
    const result = await checkKey({
      key: 'k', model: 'm', baseUrl: at('stall'), timeoutMs: 300,
      fetch: (async (url: string, init: RequestInit) => {
        const response = await fetch(url, init);
        answered = true;
        return response;
      }) as unknown as typeof fetch,
    });
    expect(answered).toBe(true);
    expect(result).toEqual({ ok: false, cause: expect.stringContaining("didn't answer within 0.3 s"), anotherKeyMayHelp: false });
  });

  test('a refusal whose body never comes keeps its status\'s cause, and its Retry-After', async () => {
    const refused = await checkKey({ key: 'k', model: 'm', baseUrl: at('stall401'), timeoutMs: 300 });
    expect(refused).toEqual({ ok: false, cause: expect.stringContaining('refused the key (401)'), anotherKeyMayHelp: true });
    const limited = await checkKey({ key: 'k', model: 'm', baseUrl: at('stall429'), timeoutMs: 300 });
    expect(limited).toEqual({ ok: false, cause: expect.stringContaining('(429)'), anotherKeyMayHelp: false });
    expect(cause(limited)).toContain('a wait of 37 s');
  });

  test("a rate limit quotes the server's Retry-After, and another key isn't what helps", async () => {
    const result = await checkKey({ key: 'k', model: 'm', baseUrl: at('wait') });
    expect(result).toEqual({ ok: false, cause: expect.stringContaining('(429)'), anotherKeyMayHelp: false });
    expect(cause(result)).toContain('a wait of 37 s');
    expect(cause(result)).toContain('It said: "slow down".');
    const empty = await checkKey({ key: 'k', model: 'm', baseUrl: at('waitempty') });
    expect(cause(empty)).toContain('Try again shortly.');
    const dated = await checkKey({ key: 'k', model: 'm', baseUrl: at('waitdate') });
    expect(cause(dated)).toContain('It asks for no call before Wed, 21 Oct 2026 07:28:00 GMT.');
  });

  test('a refused connection says it was refused, where, and what to check, showing only where ANTHROPIC_BASE_URL leads', async () => {
    const result = await checkKey({ key: 'k', model: 'm', baseUrl: 'http://someone:pass-in-url@127.0.0.1:1/gateway-path?token=in-query' });
    expect(result).toEqual({ ok: false, cause: expect.stringContaining('The connection to 127.0.0.1:1 was refused'), anotherKeyMayHelp: false });
    expect(cause(result)).toContain('ANTHROPIC_BASE_URL, which leads to http://127.0.0.1:1 now');
    for (const hidden of ['pass-in-url', 'someone', 'gateway-path', 'in-query']) expect(cause(result)).not.toContain(hidden);
  });

  test("with no ANTHROPIC_BASE_URL, it calls Anthropic's own API and says so when that fails", async () => {
    const calls: string[] = [];
    const result = await checkKey({
      key: 'k', model: 'm', fetch: (async (url: string) => {
        calls.push(url);
        throw Object.assign(new TypeError('Unable to connect.'), { code: 'ECONNREFUSED' });
      }) as unknown as typeof fetch,
    });
    expect(calls).toEqual(['https://api.anthropic.com/v1/messages']);
    expect(cause(result)).toContain("ANTHROPIC_BASE_URL is empty or absent in .env, so the call went to Anthropic's own https://api.anthropic.com");
  });

  test("an ANTHROPIC_BASE_URL that isn't an http or https URL is named as such, and nothing is called", async () => {
    for (const baseUrl of ['localhost:8080', 'not a url', 'ftp://127.0.0.1/']) {
      let called = false;
      const result = await checkKey({ key: 'k', model: 'm', baseUrl, fetch: (async () => { called = true; return new Response(); }) as unknown as typeof fetch });
      expect(result, baseUrl).toEqual({ ok: false, cause: expect.stringContaining("ANTHROPIC_BASE_URL isn't an http:// or https:// URL"), anotherKeyMayHelp: false });
      expect(called, baseUrl).toBe(false);
    }
  });

  test("a failed TLS handshake says so, in the runtime's own code and words", async () => {
    const baseUrl = `https://127.0.0.1:${plain.port}`;
    const runtime = await fetch(`${baseUrl}/v1/messages`, { method: 'POST' }).then(() => null, (error) => error as { code: string; message: string });
    expect(runtime).not.toBeNull();
    const words = runtime!.message.startsWith(`${runtime!.code}:`) ? runtime!.message : `${runtime!.code}: ${runtime!.message}`;
    const result = await checkKey({ key: 'sk-ant-test-key', model: 'm', baseUrl });
    expect(result).toEqual({ ok: false, cause: expect.stringContaining(`The TLS connection to 127.0.0.1:${plain.port} failed (${words.replace(/[\s.]+$/, '')}).`), anotherKeyMayHelp: false });
    expect(cause(result)).toContain(`If the server at https://127.0.0.1:${plain.port} speaks plain HTTP, change ANTHROPIC_BASE_URL in .env to begin http:// in place of https://, adding :443 after its host if it names no port, though the key and everything the agent sends and receives then cross the network unencrypted.`);
  });

  test('the plain-HTTP remedy says the same words whether the https URL names its port 443, no port, or a user and password', async () => {
    for (const baseUrl of ['https://gw.example/anthropic', 'https://gw.example:443/anthropic', 'https://someone:pass@gw.example/anthropic?x=1']) {
      const result = await checkKey({
        key: 'k', model: 'm', baseUrl,
        fetch: (async () => { throw Object.assign(new Error('EPROTO: The TLS handshake failed.'), { code: 'EPROTO' }); }) as unknown as typeof fetch,
      });
      expect(cause(result), baseUrl).toContain('If the server at https://gw.example speaks plain HTTP, change ANTHROPIC_BASE_URL in .env to begin http:// in place of https://, adding :443 after its host if it names no port, though');
    }
  });

  test('a runtime error with no words of its own gives its code alone', async () => {
    const result = await checkKey({
      key: 'k', model: 'm', baseUrl: 'https://gw.example',
      fetch: (async () => { throw Object.assign(new Error(''), { code: 'ECONNRESET' }); }) as unknown as typeof fetch,
    });
    expect(cause(result)).toContain('The call to gw.example failed (ECONNRESET).');
  });

  test('a name that resolves to nothing, and a server that never answers, each say so', async () => {
    const unnamed = await checkKey({
      key: 'k', model: 'm', baseUrl: 'https://no-such-host.invalid',
      // As Bun 1.4.4's fetch fails for a name that resolves to nothing, without a lookup leaving this machine.
      fetch: (async () => { throw Object.assign(new TypeError('getaddrinfo ENOTFOUND no-such-host.invalid'), { code: 'ENOTFOUND', errno: 4 }); }) as unknown as typeof fetch,
    });
    expect(cause(unnamed)).toContain("no-such-host.invalid couldn't be found by name (ENOTFOUND)");
    seen.length = 0;
    const silent = await checkKey({ key: 'k-silent', model: 'm', baseUrl: at('silent'), timeoutMs: 300 });
    expect(seen.map((each) => each.key)).toEqual(['k-silent']);
    expect((silent as { cause: string }).cause).toContain("didn't answer within 0.3 s");
  });
});

describe('the check and the agent\'s client', () => {
  test('the check reads with the same @anthropic-ai/sdk the agent\'s membrane does, one copy of it', () => {
    const from = (dir: string) => realpathSync(Bun.resolveSync('@anthropic-ai/sdk/streaming', dir));
    const membrane = dirname(Bun.resolveSync('@animalabs/membrane', join(import.meta.dir, '..', 'src')));
    expect(from(join(import.meta.dir, '..', 'src', 'setup'))).toBe(from(membrane));
  });

  test('setup asks for @anthropic-ai/sdk in the range membrane asks for it, so an upgrade of membrane that moves it fails here first', async () => {
    const membrane = join(dirname(Bun.resolveSync('@animalabs/membrane', join(import.meta.dir, '..', 'src'))), '..', 'package.json');
    const theirs = (await Bun.file(membrane).json() as { dependencies: Record<string, string> }).dependencies['@anthropic-ai/sdk'];
    const ours = (await Bun.file(join(import.meta.dir, '..', 'package.json')).json() as { dependencies: Record<string, string> }).dependencies['@anthropic-ai/sdk'];
    expect(theirs).toBeString();
    expect(ours).toBe(theirs);
  });

  test('on each stream, the check passes exactly when membrane\'s own Anthropic stream() reads it as one message', async () => {
    const stubs = Bun.serve({ port: 0, fetch: (request) => STREAMS[new URL(request.url).pathname.split('/')[1]!]!() });
    try {
      const outcomes = await Promise.all(Object.keys(STREAMS).map(async (choice) => {
        const baseURL = `http://127.0.0.1:${stubs.port}/${choice}`;
        const check = await checkKey({ key: 'k', model: 'm', baseUrl: baseURL, timeoutMs: 3_000 });
        const adapter = new AnthropicAdapter({ apiKey: 'k', baseURL, cacheKeepalive: { enabled: false } });
        const reads = await Promise.race([
          adapter.stream({ model: 'm', maxTokens: 1, messages: [{ role: 'user', content: 'ok' }] } as never,
            { onChunk: () => {}, onContentBlock: () => {} } as never, {} as never).then(() => true, () => false),
          Bun.sleep(4_000).then(() => false),
        ]);
        return { choice, check: check.ok, reads };
      }));
      expect(outcomes.filter((each) => each.check !== each.reads), JSON.stringify(outcomes)).toEqual([]);
      expect(outcomes.filter((each) => !(each.choice in EDGE) && each.reads !== each.choice in READ), JSON.stringify(outcomes)).toEqual([]);
    } finally {
      stubs.stop(true);
    }
  }, 20_000);
});
