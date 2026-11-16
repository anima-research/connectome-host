import { afterEach, describe, test, expect, spyOn } from 'bun:test';
import type { ProviderRequest } from '@animalabs/membrane';
import Anthropic from '@anthropic-ai/sdk';
import { LoggingAnthropicAdapter, clearEffortRefusals, isEffortRefusal, modelAcceptsEffort } from '../src/logging-adapter.js';

// A model the host doesn't know to refuse an effort gets it; a 400 that names
// output_config.effort before anything streamed teaches the process: the
// request goes again without it, and the level is dropped for that model from
// then on, with one line said. No row per model release.
describe('an effort refusal teaches the adapter', () => {
  type Reasoning = () => { enabled: boolean; budgetTokens: number; effort?: 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' };
  let warn: ReturnType<typeof spyOn> | undefined;
  afterEach(() => { warn?.mockRestore(); warn = undefined; clearEffortRefusals(); });

  const refusal = () => Anthropic.APIError.generate(400, {
    type: 'error',
    error: { type: 'invalid_request_error', message: 'output_config.effort: effort is not supported for this model' },
  }, undefined, new Headers());

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

  const wire = (reasoning: Reasoning, refuseEffort: (body: Record<string, unknown>) => boolean) => {
    const bodies: Array<Record<string, unknown>> = [];
    const live = new LoggingAnthropicAdapter({ apiKey: 'test', cacheKeepalive: { enabled: false } }, '/dev/null', reasoning);
    (live as unknown as { client: unknown }).client = {
      withOptions() { return this; },
      messages: {
        stream: async (body: Record<string, unknown>) => {
          bodies.push(body);
          if (refuseEffort(body)) throw refusal();
          return okStream(body);
        },
      },
    };
    const req = (model: string) =>
      ({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], model, maxTokens: 1024 }) as ProviderRequest;
    return { bodies, stream: (model: string) => live.stream(req(model), { onChunk: () => {} }) };
  };
  const effortOf = (body: Record<string, unknown>) => (body.output_config as { effort?: string } | undefined)?.effort;

  test('a model not known to refuse gets the effort; its 400 is answered by the same request without it, once, and the level stays off for it', async () => {
    warn = spyOn(console, 'error').mockImplementation(() => {});
    // A future model the rule says takes effort, and this account's doesn't.
    const model = 'claude-haiku-6';
    expect(modelAcceptsEffort(model, 'low')).toBe(true);
    const w = wire(() => ({ enabled: false, budgetTokens: 0, effort: 'low' }), (body) => effortOf(body) !== undefined);
    expect((await w.stream(model)).content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(w.bodies.map(effortOf)).toEqual(['low', undefined]);
    expect(modelAcceptsEffort(model, 'low')).toBe(false);
    expect(modelAcceptsEffort(model, 'high')).toBe(true);
    // From now on the level isn't sent to that model, and nothing more is said.
    await w.stream(model);
    expect(w.bodies.map(effortOf)).toEqual(['low', undefined, undefined]);
    const said = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[reasoning-effort]'));
    expect(said).toHaveLength(2); // the refusal line, then withEffort's one "not sent" line for the known refusal
    expect(said[0]).toContain(`${model} refused effort=low`);
    expect(said[0]).toContain('sent again without it');
  });

  test('a 400 about something else, or one after part of the reply was delivered, is not an effort refusal and is thrown', async () => {
    warn = spyOn(console, 'error').mockImplementation(() => {});
    const other = Anthropic.APIError.generate(400, { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: too large' } }, undefined, new Headers());
    expect(isEffortRefusal(other)).toBe(false);
    expect(isEffortRefusal(refusal())).toBe(true);
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
