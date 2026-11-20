import { afterEach, describe, test, expect, spyOn } from 'bun:test';
import type { ProviderRequest } from '@animalabs/membrane';
import Anthropic from '@anthropic-ai/sdk';
import { LoggingAnthropicAdapter, clearEffortRefusals, isEffortRefusal, modelAcceptsEffort, withoutEffort } from '../src/logging-adapter.js';

// A model the host doesn't know to refuse an effort gets it; a 400 whose own
// message names the effort, before anything streamed, teaches the process: the
// request goes again without it, and the level is dropped for that model for
// the life of the process, with one line said per model and level. No row per
// model release.
describe('an effort refusal teaches the adapter', () => {
  type Reasoning = () => { enabled: boolean; budgetTokens: number; effort?: 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' };
  let warn: ReturnType<typeof spyOn> | undefined;
  afterEach(() => { warn?.mockRestore(); warn = undefined; clearEffortRefusals(); });

  const bad = (status: number, message: string) => Anthropic.APIError.generate(status, {
    type: 'error',
    error: { type: status === 400 ? 'invalid_request_error' : 'api_error', message },
  }, undefined, new Headers());
  const refusal = () => bad(400, 'output_config.effort: effort is not supported for this model');

  const okStream = (body: Record<string, unknown>) => ({
    controller: { abort() {} },
    async *[Symbol.asyncIterator]() {
      yield { type: 'message_start', message: { model: body.model, usage: { input_tokens: 1 } } };
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } };
    },
  });

  const wire = (reasoning: Reasoning, answer: (body: Record<string, unknown>, n: number) => Error | undefined) => {
    const bodies: Array<Record<string, unknown>> = [];
    const live = new LoggingAnthropicAdapter({ apiKey: 'test', cacheKeepalive: { enabled: false } }, '/dev/null', reasoning);
    (live as unknown as { client: unknown }).client = {
      withOptions() { return this; },
      messages: {
        stream: async (body: Record<string, unknown>) => {
          bodies.push(body);
          const err = answer(body, bodies.length);
          if (err) throw err;
          return okStream(body);
        },
      },
    };
    const req = (model: string, extra?: Record<string, unknown>) =>
      ({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], model, maxTokens: 1024, ...(extra ? { extra } : {}) }) as ProviderRequest;
    return { bodies, stream: (model: string, extra?: Record<string, unknown>) => live.stream(req(model, extra), { onChunk: () => {} }) };
  };
  const refusesEffort = (body: Record<string, unknown>) => (effortOf(body) !== undefined ? refusal() : undefined);
  const effortOf = (body: Record<string, unknown>) => (body.output_config as { effort?: string } | undefined)?.effort;

  test('a model not known to refuse gets the effort; its 400 is answered by the same request without it, once, and the level stays off for it', async () => {
    warn = spyOn(console, 'error').mockImplementation(() => {});
    // A future model the rule says takes effort, and this account's doesn't.
    const model = 'claude-haiku-6';
    expect(modelAcceptsEffort(model, 'low')).toBe(true);
    const w = wire(() => ({ enabled: false, budgetTokens: 0, effort: 'low' }), refusesEffort);
    expect((await w.stream(model)).content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(w.bodies.map(effortOf)).toEqual(['low', undefined]);
    expect(modelAcceptsEffort(model, 'low')).toBe(false);
    expect(modelAcceptsEffort(model, 'high')).toBe(true);
    // From now on the level isn't sent to that model, and nothing more is said.
    await w.stream(model);
    expect(w.bodies.map(effortOf)).toEqual(['low', undefined, undefined]);
    const said = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[reasoning-effort]'));
    expect(said).toHaveLength(2); // the refusal line, then withEffort's one "not sent" line for the now-known refusal
    expect(said[0]).toContain(`${model} refused effort=low`);
    expect(said[0]).toContain('sent again without it');
    // The retry is the same request, effort aside.
    const [first, second] = w.bodies;
    expect(second!.model).toBe(first!.model);
    expect(second!.messages).toEqual(first!.messages);
    expect(second!.max_tokens).toBe(first!.max_tokens);
    expect(second!.output_config).toBeUndefined();
  });

  test('a new family name, mixed case and a dotted version are sent the effort and learn under one normalized key', async () => {
    warn = spyOn(console, 'error').mockImplementation(() => {});
    const w = wire(() => ({ enabled: false, budgetTokens: 0, effort: 'max' }), refusesEffort);
    await w.stream('Claude-NewFamily-6');
    expect(w.bodies.map(effortOf)).toEqual(['max', undefined]);
    // The same model in other spellings is now known to refuse max without another 400.
    await w.stream('claude-newfamily-6-20270101');
    await w.stream('anthropic/claude-newfamily-6[1m]');
    expect(w.bodies.map(effortOf)).toEqual(['max', undefined, undefined, undefined]);
    expect(modelAcceptsEffort('claude-newfamily-6', 'max')).toBe(false);
    expect(modelAcceptsEffort('claude-newfamily-6', 'low')).toBe(true);
  });

  test('a 400 about something else, and a 500, are thrown from stream() with one request sent and nothing learned', async () => {
    warn = spyOn(console, 'error').mockImplementation(() => {});
    const other = wire(() => ({ enabled: false, budgetTokens: 0, effort: 'low' }), () => bad(400, 'max_tokens: too large'));
    await expect(other.stream('claude-haiku-5-5')).rejects.toThrow('max_tokens: too large');
    expect(other.bodies).toHaveLength(1);
    expect(modelAcceptsEffort('claude-haiku-5-5', 'low')).toBe(true);
    const server = wire(() => ({ enabled: false, budgetTokens: 0, effort: 'low' }), () => bad(500, 'output_config.effort: overloaded, try again'));
    await expect(server.stream('claude-haiku-5-5')).rejects.toThrow('overloaded');
    expect(server.bodies).toHaveLength(1);
    expect(modelAcceptsEffort('claude-haiku-5-5', 'low')).toBe(true);
    expect(warn.mock.calls.filter((c) => String(c[0]).startsWith('[reasoning-effort]'))).toHaveLength(0);
  });

  test("a 400 about output_config.format on a request that also carried an effort is not an effort refusal; a caller's own effort is removed on a real retry", async () => {
    warn = spyOn(console, 'error').mockImplementation(() => {});
    // The format complaint names output_config but not the effort, and the effort wasn't the only key under it (R1-2).
    const format = wire(() => ({ enabled: false, budgetTokens: 0, effort: 'high' }), () => bad(400, "output_config.format.schema: 'additionalProperties' must be explicitly set to false"));
    await expect(format.stream('claude-opus-5-5', { output_config: { format: { type: 'json_schema', schema: {} } } })).rejects.toThrow('additionalProperties');
    expect(format.bodies).toHaveLength(1);
    expect(effortOf(format.bodies[0]!)).toBe('high');
    expect(modelAcceptsEffort('claude-opus-5-5', 'high')).toBe(true);
    // A caller's own effort, refused: the retry carries none, and output_config goes with it when empty.
    const caller = wire(() => ({ enabled: false, budgetTokens: 0 }), refusesEffort);
    expect((await caller.stream('claude-newfamily-7', { output_config: { effort: 'low' } })).content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(caller.bodies.map(effortOf)).toEqual(['low', undefined]);
    expect(caller.bodies[1]!.output_config).toBeUndefined();
    expect(withoutEffort({ extra: { output_config: { effort: 'low', format: { type: 'text' } }, other: 1 } }).extra).toEqual({ output_config: { format: { type: 'text' } }, other: 1 });
    expect(withoutEffort({ extra: { output_config: { effort: 'low' } } }).extra).toBeUndefined();
    expect(withoutEffort({ messages: [] }).extra).toBeUndefined();
  });

  test('two requests in flight when the refusal is learned say one line between them', async () => {
    warn = spyOn(console, 'error').mockImplementation(() => {});
    const w = wire(() => ({ enabled: false, budgetTokens: 0, effort: 'low' }), refusesEffort);
    await Promise.all([w.stream('claude-newfamily-8'), w.stream('claude-newfamily-8')]);
    const said = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('refused effort=low'));
    expect(said).toHaveLength(1);
    expect(w.bodies.map(effortOf)).toEqual(['low', 'low', undefined, undefined]);
  });

  test('a 400 about something else, or one after part of the reply was delivered, is not an effort refusal and is thrown', async () => {
    warn = spyOn(console, 'error').mockImplementation(() => {});
    expect(isEffortRefusal(bad(400, 'max_tokens: too large'))).toBe(false);
    expect(isEffortRefusal(refusal())).toBe(true);
    expect(isEffortRefusal(bad(400, 'output_config: unexpected field'), true)).toBe(true);
    expect(isEffortRefusal(bad(400, 'output_config: unexpected field'), false)).toBe(false);
    expect(isEffortRefusal(Object.assign(new Error('output_config.effort: bad'), { httpStatus: 500 }))).toBe(false);

    const live = new LoggingAnthropicAdapter({ apiKey: 'test', cacheKeepalive: { enabled: false } }, '/dev/null', () => ({ enabled: false, budgetTokens: 0, effort: 'low' }));
    const bodies: Array<Record<string, unknown>> = [];
    (live as unknown as { client: unknown }).client = {
      withOptions() { return this; },
      messages: {
        stream: async (body: Record<string, unknown>) => {
          bodies.push(body);
          return {
            controller: { abort() {} },
            async *[Symbol.asyncIterator]() {
              yield { type: 'message_start', message: { model: body.model, usage: { input_tokens: 1 } } };
              yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
              yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } };
              throw refusal();
            },
          };
        },
      },
    };
    const req = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], model: 'claude-haiku-5-5', maxTokens: 1024 } as ProviderRequest;
    await expect(live.stream(req, { onChunk: () => {} })).rejects.toThrow('effort is not supported');
    expect(bodies).toHaveLength(1);
    expect(modelAcceptsEffort('claude-haiku-5-5', 'low')).toBe(true);
  });
});
