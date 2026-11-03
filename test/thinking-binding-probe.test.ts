import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedRequest } from '@animalabs/membrane';
import { probeAccountBinding, probeThinkingBinding, isBindingRefusal } from '../src/thinking-binding-probe.js';
import { accountBinding, clearAccountBindings, leavesOutChangedThinking, recordAccountBinding } from '../src/logging-adapter.js';
import { thinkingBindingSettings } from '../src/framework-agent-config.js';

const REFUSAL = Object.assign(new Error('messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.'), { httpStatus: 400 });

/** A provider whose replies count 100 input tokens, plus `blockTokens` for a
 *  replayed thinking block under the system text it was minted under, and
 *  `changedBlockTokens` (or the refusal) under any other. */
function provider(opts: { blockTokens?: number; changedBlockTokens?: number | 'refuse'; signed?: boolean; fail?: Error }) {
  const requests: NormalizedRequest[] = [];
  let mintedUnder: string | undefined;
  const membrane = {
    async complete(request: NormalizedRequest) {
      requests.push(request);
      if (opts.fail) throw opts.fail;
      const reply = request.messages.find((m) => m.participant === 'resident');
      if (!reply) {
        mintedUnder = request.system;
        return {
          content: [
            ...(opts.signed === false ? [] : [{ type: 'thinking', thinking: '', signature: 'sig' }]),
            { type: 'text', text: '391' },
          ],
          usage: { inputTokens: 40, outputTokens: 30 },
          details: { usage: { inputTokens: 40, outputTokens: 30 } },
        };
      }
      const replayed = reply.content.some((b) => b.type === 'thinking');
      let extra = 0;
      if (replayed && request.system === mintedUnder) extra = opts.blockTokens ?? 60;
      else if (replayed) {
        if (opts.changedBlockTokens === 'refuse') throw REFUSAL;
        extra = opts.changedBlockTokens ?? 0;
      }
      const usage = { inputTokens: 70 + extra, outputTokens: 2, cacheReadTokens: 30 };
      return { content: [{ type: 'text', text: 'You are welcome.' }], usage, details: { usage } };
    },
  };
  return { membrane: membrane as never, requests };
}

afterEach(() => clearAccountBindings());

describe('thinking binding probe', () => {
  test('a replay under a changed system text that is refused means the account refuses', async () => {
    const { membrane, requests } = provider({ changedBlockTokens: 'refuse' });
    const result = await probeThinkingBinding(membrane, 'claude-opus-5-5', 'resident');
    expect(result.binding).toBe('refuses');
    expect(requests).toHaveLength(5);
    expect(new Set(requests.map((r) => r.system)).size).toBe(2);
  });

  test("a block that counts for nothing under a changed system text means the account drops it", async () => {
    const { membrane } = provider({ changedBlockTokens: 0 });
    expect((await probeThinkingBinding(membrane, 'claude-opus-5-5', 'resident')).binding).toBe('drops');
  });

  test('a block that counts as it does under its own system text means the account shows it', async () => {
    const { membrane } = provider({ changedBlockTokens: 60 });
    const result = await probeThinkingBinding(membrane, 'claude-opus-5-5', 'resident');
    expect(result.binding).toBe('shows');
    expect(result.detail).toContain('60 input tokens under a changed system text and 60 under its own');
  });

  test('the probe decides nothing when it has nothing to measure or the counts are neither all nor none', async () => {
    for (const opts of [{ signed: false }, { blockTokens: 0 }, { changedBlockTokens: 20 }, { fail: new Error('overloaded') }]) {
      expect((await probeThinkingBinding(provider(opts).membrane, 'claude-opus-5-5', 'resident')).binding).toBeUndefined();
    }
  });

  test('a reply without signed thinking is asked for again, up to three times', async () => {
    const { membrane, requests } = provider({ signed: false });
    expect((await probeThinkingBinding(membrane, 'claude-opus-5-5', 'resident')).detail).toBe('no signed thinking came back to replay in 3 requests');
    expect(requests).toHaveLength(3);
  });

  test('only a 400 naming the binding counts as the refusal', () => {
    expect(isBindingRefusal(REFUSAL)).toBe(true);
    expect(isBindingRefusal(Object.assign(new Error('bound to a different conversation'), { httpStatus: 500 }))).toBe(false);
    expect(isBindingRefusal(Object.assign(new Error('max_tokens: too large'), { httpStatus: 400 }))).toBe(false);
  });
});

describe('what the probe found decides the binding', () => {
  test('an account that shows such a block gets neither the binding nor the drop control; the window stays', async () => {
    const { membrane } = provider({ changedBlockTokens: 60 });
    const lines: string[] = [];
    await probeAccountBinding(membrane, { provider: 'anthropic', assistant: 'resident', models: ['claude-opus-5-5', 'claude-opus-5-5', undefined], env: {}, log: (l) => lines.push(l) });
    expect(accountBinding('claude-opus-5-5')).toBe('shows');
    expect(accountBinding('claude-opus-5.5[1m]')).toBe('shows');
    expect(leavesOutChangedThinking('claude-opus-5-5')).toBe(false);
    expect(thinkingBindingSettings('claude-opus-5-5', 'anthropic')).toEqual({ physicalWindowTokens: 1_000_000 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[thinking-binding] claude-opus-5-5: this account still shows the model');
  });

  test('an account that refuses or drops such a block, or one the probe could not read, keeps the binding and the control', async () => {
    const cases = [[{ changedBlockTokens: 'refuse' as const }, 'refuses'], [{ changedBlockTokens: 0 }, 'drops'], [{ signed: false }, undefined]] as const;
    for (const [opts, found] of cases) {
      clearAccountBindings();
      await probeAccountBinding(provider(opts).membrane, { provider: 'anthropic', assistant: 'resident', models: ['claude-opus-5-5'], env: {}, log: () => {} });
      expect(accountBinding('claude-opus-5-5')).toBe(found);
      expect(thinkingBindingSettings('claude-opus-5-5', 'anthropic')).toEqual({ thinkingBinding: { binds: true, dropBlock: true }, physicalWindowTokens: 1_000_000 });
    }
  });

  test('an account that shows such a block is taken at its word only where the drop control can stand in if the account changes', async () => {
    for (const [providerName, model] of [['bedrock', 'claude-opus-5-5'], ['anthropic', 'claude-mythos-5-1']] as const) {
      clearAccountBindings();
      const lines: string[] = [];
      await probeAccountBinding(provider({ changedBlockTokens: 60 }).membrane, { provider: providerName, assistant: 'resident', models: [model], env: {}, log: (l) => lines.push(l) });
      expect(accountBinding(model)).toBeUndefined();
      expect(lines[0]).toContain('this route has no drop control to fall back on, so such thinking is left out');
    }
  });

  test('what the probe last decided stands at a start where it cannot tell', async () => {
    const stateFile = join(mkdtempSync(join(tmpdir(), 'binding-probe-')), 'thinking-binding.json');
    const base = { provider: 'anthropic', route: 'anthropic https://gate.example', assistant: 'resident', models: ['claude-opus-5-5'], env: {}, stateFile };
    await probeAccountBinding(provider({ changedBlockTokens: 60 }).membrane, { ...base, log: () => {} });
    expect(Object.values(JSON.parse(readFileSync(stateFile, 'utf8'))).map((v) => (v as { binding: string }).binding)).toEqual(['shows']);
    clearAccountBindings();
    const lines: string[] = [];
    await probeAccountBinding(provider({ fail: new Error('overloaded') }).membrane, { ...base, log: (l) => lines.push(l) });
    expect(accountBinding('claude-opus-5-5')).toBe('shows');
    expect(lines[0]).toContain('stands: it still shows the model');
    clearAccountBindings();
    await probeAccountBinding(provider({ fail: new Error('overloaded') }).membrane, { ...base, route: 'anthropic https://other.example', log: () => {} });
    expect(accountBinding('claude-opus-5-5')).toBeUndefined();
    // A kept 'shows' is held to the same rule as a fresh one.
    const shared = { ...base, models: ['claude-mythos-5-1'] };
    writeFileSync(stateFile, JSON.stringify({ [`anthropic https://gate.example|row:mythos-5-1`]: { binding: 'shows', at: '2026-10-30T00:00:00Z' } }));
    clearAccountBindings();
    const kept: string[] = [];
    await probeAccountBinding(provider({ fail: new Error('overloaded') }).membrane, { ...shared, log: (l) => kept.push(l) });
    expect(accountBinding('claude-mythos-5-1')).toBeUndefined();
    expect(kept[0]).toContain('no drop control to fall back on');
  });

  test('two spellings of one model are probed once', async () => {
    const { membrane, requests } = provider({ changedBlockTokens: 0 });
    await probeAccountBinding(membrane, { provider: 'anthropic', assistant: 'resident', models: ['claude-opus-5-5[1m]', 'claude-opus-5-5'], env: {}, log: () => {} });
    expect(requests).toHaveLength(5);
  });

  test('on a model without adaptive thinking every request leaves room for an explicit budget', async () => {
    const { membrane, requests } = provider({ changedBlockTokens: 0 });
    await probeThinkingBinding(membrane, 'claude-haiku-6', 'resident');
    expect(requests).toHaveLength(5);
    for (const r of requests) expect(r.config.maxTokens).toBeGreaterThanOrEqual((r.config.thinking?.budgetTokens ?? 0) + 1024);
  });

  test('no probe for a model whose thinking does not bind, the mock provider, the anthropic-xml formatter, the switch, or a model already probed', async () => {
    const cases: Array<[Parameters<typeof probeAccountBinding>[1]]> = [
      [{ provider: 'anthropic', assistant: 'resident', models: ['claude-opus-4-7', 'gpt-5.6'], env: {} }],
      [{ provider: 'mock', assistant: 'resident', models: ['claude-opus-5-5'], env: {} }],
      [{ provider: 'anthropic', formatter: 'anthropic-xml', assistant: 'resident', models: ['claude-opus-5-5'], env: {} }],
      [{ provider: 'anthropic', assistant: 'resident', models: ['claude-opus-5-5'], env: { THINKING_BINDING_PROBE: 'off' } }],
    ];
    for (const [options] of cases) {
      const { membrane, requests } = provider({});
      expect(await probeAccountBinding(membrane, { ...options, log: () => {} })).toEqual([]);
      expect(requests).toHaveLength(0);
    }
    recordAccountBinding('claude-sonnet-5-5', 'drops');
    const { membrane, requests } = provider({});
    await probeAccountBinding(membrane, { provider: 'anthropic', assistant: 'resident', models: ['claude-sonnet-5-5'], env: {}, log: () => {} });
    expect(requests).toHaveLength(0);
  });
});
