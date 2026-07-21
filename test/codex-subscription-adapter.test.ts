import { afterEach, describe, expect, test } from 'bun:test';
import type { ProviderRequest } from '@animalabs/membrane';
import {
  CodexSubscriptionAdapter,
  type CodexAuthProvider,
} from '../src/codex-subscription-adapter.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function request(extra: Record<string, unknown> = {}): ProviderRequest {
  return {
    model: 'gpt-5.4',
    messages: [{ type: 'message', role: 'user', content: 'Hello' }],
    maxTokens: 8192,
    temperature: 0.2,
    topP: 0.9,
    topK: 20,
    extra,
  };
}

function completedResponse(): Response {
  const item = {
      type: 'message',
      id: 'msg_test',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Hello back' }],
  };
  const events = [
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: {
        id: 'resp_test',
        model: 'gpt-5.4',
        status: 'completed',
        output: [],
        usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
      },
    },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('CodexSubscriptionAdapter', () => {
  test('uses the subscription endpoint and enables Fast mode per request', async () => {
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      });
      return completedResponse();
    };
    const auth: CodexAuthProvider = {
      getAccessToken: async () => 'subscription-token',
      getAccountId: () => 'account-test',
    };
    const adapter = new CodexSubscriptionAdapter({
      authProvider: auth,
      baseURL: 'https://example.test/backend-api/codex/',
      fastMode: true,
    });

    const response = await adapter.complete(request({ max_output_tokens: 999 }));

    expect(response.stopReason).toBe('end_turn');
    expect((response.content as Array<{ text?: string }>)[0]?.text).toBe('Hello back');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://example.test/backend-api/codex/responses');
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer subscription-token');
    expect(requests[0]?.headers.get('chatgpt-account-id')).toBe('account-test');
    expect(requests[0]?.body.service_tier).toBe('priority');
    expect(requests[0]?.body.max_output_tokens).toBeUndefined();
    expect(requests[0]?.body.temperature).toBeUndefined();
    expect(requests[0]?.body.top_p).toBeUndefined();
    expect(requests[0]?.body.input).toEqual([{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Hello' }],
    }]);
  });

  test('normalizes maintenance text, images, and tool blocks at the transport boundary', async () => {
    let body: Record<string, any> = {};
    globalThis.fetch = async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return completedResponse();
    };
    const adapter = new CodexSubscriptionAdapter({
      authProvider: { getAccessToken: async () => 'subscription-token' },
      baseURL: 'https://example.test/codex',
    });

    await adapter.complete({
      model: 'gpt-5.4',
      messages: [
        {
          type: 'message', role: 'user', content: [
            { type: 'text', text: 'inspect' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
          ],
        },
        {
          type: 'message', role: 'assistant', content: [
            { type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 'x' } },
          ],
        },
        {
          type: 'message', role: 'user', content: [
            { type: 'tool_result', tool_use_id: 'call_1', content: 'found' },
          ],
        },
      ] as any,
      maxTokens: 1024,
    });

    expect(body.input).toEqual([
      {
        type: 'message', role: 'user', content: [
          { type: 'input_text', text: 'inspect' },
          { type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' },
        ],
      },
      { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'found' },
    ]);
  });

  test('turns Fast mode off without reconstructing the adapter', async () => {
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return completedResponse();
    };
    const adapter = new CodexSubscriptionAdapter({
      authProvider: { getAccessToken: async () => 'subscription-token' },
      baseURL: 'https://example.test/codex',
      fastMode: true,
    });

    await adapter.complete(request());
    adapter.setFastMode(false);
    await adapter.complete(request({ service_tier: 'priority' }));

    expect(bodies[0]?.service_tier).toBe('priority');
    expect(bodies[1]?.service_tier).toBeUndefined();
  });

  test('refreshes the ChatGPT token once after a 401', async () => {
    const refreshFlags: boolean[] = [];
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) return new Response('expired', { status: 401 });
      return completedResponse();
    };
    const adapter = new CodexSubscriptionAdapter({
      authProvider: {
        getAccessToken: async (forceRefresh = false) => {
          refreshFlags.push(forceRefresh);
          return forceRefresh ? 'fresh-token' : 'expired-token';
        },
      },
      baseURL: 'https://example.test/codex',
    });

    await adapter.complete(request());

    expect(calls).toBe(2);
    expect(refreshFlags).toEqual([false, true]);
  });

  test('reconstructs tool calls when the terminal event has an empty output', async () => {
    const item = {
      type: 'function_call',
      id: 'fc_test',
      call_id: 'call_test',
      name: 'lookup',
      arguments: '{"query":"connectome"}',
    };
    globalThis.fetch = async () => new Response([
      `data: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item })}\n\n`,
      `data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          model: 'gpt-5.4', status: 'completed', output: [],
          usage: { input_tokens: 2, output_tokens: 3 },
        },
      })}\n\n`,
    ].join(''), { headers: { 'Content-Type': 'text/event-stream' } });
    const adapter = new CodexSubscriptionAdapter({
      authProvider: { getAccessToken: async () => 'subscription-token' },
      baseURL: 'https://example.test/codex',
    });

    const response = await adapter.complete(request());

    expect(response.stopReason).toBe('tool_use');
    expect(response.content).toEqual([expect.objectContaining({
      type: 'tool_use', id: 'call_test', name: 'lookup', input: { query: 'connectome' },
    })]);
  });

  test('surfaces nested SSE error details', async () => {
    globalThis.fetch = async () => new Response(
      'data: {"type":"error","error":{"type":"invalid_request_error","code":"context_length_exceeded","message":"input is too large"}}\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
    const adapter = new CodexSubscriptionAdapter({
      authProvider: { getAccessToken: async () => 'subscription-token' },
      baseURL: 'https://example.test/codex',
    });

    await expect(adapter.complete(request())).rejects.toThrow(
      /context_length_exceeded.*input is too large/,
    );
  });
});
