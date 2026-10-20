/**
 * A subagent whose run the framework ended rather than sleep a provider's
 * stated wait (an ephemeral run sleeps a stated wait of up to ten minutes,
 * and ends at once on a longer one or on one it can't read as a number)
 * fails without a restart, since a restart would call the provider again
 * too soon. Other rate-limit errors stay transient. agent-framework 0.22.3
 * rejects such a run with its ProviderWaitNotSleptError, which the module
 * reads by name.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework, ProviderWaitNotSleptError } from '@animalabs/agent-framework';
import type { Module, ToolCall } from '@animalabs/agent-framework';
import { Membrane, MockAdapter, NativeFormatter } from '@animalabs/membrane';
import { SubagentModule } from '../src/modules/subagent-module.js';

// The framework's message for each kind of wait it won't sleep
// (statedWaitNotSlept), after the provider's own. The last test builds them
// as the framework does.
const UNSLEPT = "429 rate_limit_error: try again later (the provider asked to wait 7200 s; an ephemeral run doesn't sleep a stated wait longer than 600 s, so it ends now)";
const UNSLEPT_NAN = "429 rate_limit_error (the provider's stated wait is not a number, and an ephemeral run sleeps only a stated wait of 600 s or less, so it ends now)";

type Classifier = { isTransientError(err: Error): boolean };

async function harness(fail: () => Error) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sub-wait-'));
  const membrane = new Membrane(new MockAdapter({ defaultResponse: 'ok' }), { formatter: new NativeFormatter() });
  // One retry, so a restart shows as a second run after a 5 s delay, well
  // inside the test's bound.
  const subagent = new SubagentModule({ parentAgentName: 'parent', defaultModel: 'mock', defaultMaxTokens: 256, maxRetries: 1 });
  // The rate-limit cooldown is 30 s. A run ended over a wait the framework
  // won't sleep never reaches it; at 0, a run that did would show as a halved
  // concurrency (throttle()) rather than as a test out of time.
  (subagent as unknown as { rateLimitCooldownMs: number }).rateLimitCooldownMs = 0;
  const framework = await AgentFramework.create({
    storePath: join(tmpDir, 'store'),
    membrane,
    agents: [{ name: 'parent', model: 'mock', systemPrompt: 'parent', maxTokens: 256 }],
    modules: [subagent as unknown as Module],
  });
  let runs = 0;
  const fw = framework as unknown as {
    runEphemeralToCompletion: (agent: unknown) => Promise<{ speech: string; toolCallsCount: number }>;
  };
  fw.runEphemeralToCompletion = async () => {
    runs++;
    throw fail();
  };
  subagent.setFramework(framework);
  framework.start();
  const limits = subagent as unknown as { effectiveConcurrent: number; throttled: boolean };
  const concurrency = limits.effectiveConcurrent;
  return {
    framework,
    subagent,
    runs: () => runs,
    /** Whether the module throttled its subagents, as a rate limit does. */
    throttle: () => ({ halved: limits.effectiveConcurrent < concurrency, throttled: limits.throttled }),
    cleanup: async () => {
      try { await framework.stop(); } catch { /* noop */ }
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

function call(tool: 'spawn' | 'fork', name: string): ToolCall {
  const input = tool === 'spawn'
    ? { name, systemPrompt: 'you are a test subagent', task: 'reply', sync: true }
    : { name, task: 'reply', sync: true };
  return { id: `test-${tool}-${name}`, name: tool, input, callerAgentName: 'parent' };
}

describe("a provider's stated wait that the framework won't sleep", () => {
  for (const tool of ['spawn', 'fork'] as const) {
    for (const [form, message, phrase] of [
      ['a long wait', UNSLEPT, 'the provider asked to wait 7200 s'],
      ['a wait that is not a number', UNSLEPT_NAN, "the provider's stated wait is not a number"],
    ] as const) {
      test(`fails a ${tool} with the framework's reason, without a restart or a throttle (${form})`, async () => {
        const wait = message === UNSLEPT_NAN ? Number.NaN : 7_200_000;
        const h = await harness(() => new ProviderWaitNotSleptError(message, wait));
        try {
          const res = await h.subagent.handleToolCall(call(tool, `waiter-${tool}`));
          expect(res.success).toBe(false);
          expect(h.runs()).toBe(1);
          expect(JSON.stringify(res)).toContain(phrase);
          expect(h.throttle()).toEqual({ halved: false, throttled: false });
        } finally {
          await h.cleanup();
        }
      }, 15_000);
    }
  }

  for (const tool of ['spawn', 'fork'] as const) {
    test(`fails a ${tool} without a restart when the framework's error is named ProviderWaitNotSleptError, whatever its words`, async () => {
      // Its name is the mark, so an error from a second copy of the package,
      // with a class of its own, reads the same. These words would otherwise
      // be transient.
      const words = '503 overloaded: socket hang up';
      const marked = () => Object.assign(new Error(words), {
        name: 'ProviderWaitNotSleptError', retryAfterMs: 7_200_000,
      });
      const h = await harness(marked);
      try {
        const res = await h.subagent.handleToolCall(call(tool, `marked-waiter-${tool}`));
        expect(res.success).toBe(false);
        expect(h.runs()).toBe(1);
        expect(JSON.stringify(res)).toContain(words);
      } finally {
        await h.cleanup();
      }
    }, 15_000);
  }

  test("reads agent-framework's own ProviderWaitNotSleptError as not worth a restart", () => {
    const mod = new SubagentModule({ parentAgentName: 'parent', defaultModel: 'mock' }) as unknown as Classifier;
    expect(mod.isTransientError(new ProviderWaitNotSleptError('503 overloaded', 7_200_000))).toBe(false);
  });

  test('a rate-limit error without that class throttles the subagents and is tried again, as before', async () => {
    // The control for the throttle() checks above: a plain rate-limit error
    // halves the concurrency, throttles, and restarts the run.
    const h = await harness(() => new Error('429 rate_limit_error: try again later'));
    try {
      const res = await h.subagent.handleToolCall(call('spawn', 'plain-limited'));
      expect(res.success).toBe(false);
      expect(h.runs()).toBe(2);
      expect(h.throttle()).toEqual({ halved: true, throttled: true });
    } finally {
      await h.cleanup();
    }
  }, 15_000);

  test('rate-limit errors without that class stay transient, whatever their words', () => {
    const mod = new SubagentModule({ parentAgentName: 'parent', defaultModel: 'mock' }) as unknown as Classifier;
    expect(mod.isTransientError(new Error(UNSLEPT))).toBe(true);
    expect(mod.isTransientError(new Error('429 Too Many Requests'))).toBe(true);
    expect(mod.isTransientError(new Error('rate_limit_error: try again later'))).toBe(true);
  });

  test("fails a subagent without a restart on the framework's own error, built as the framework builds it, for a long wait, one that can't be represented and one that isn't a number", async () => {
    let next: Error = new Error('unset');
    const h = await harness(() => next);
    try {
      // The framework's own words and wait, from the installed package, as
      // its settle passes them to ProviderWaitNotSleptError
      // (runEphemeralToCompletion's reject).
      const fw = h.framework as unknown as { statedWaitNotSlept(error: Error): { error: string; statedWaitMs: number } };
      const stated = (retryAfterMs: number) => Object.assign(new Error('429 rate_limit_error: try again later'), {
        name: 'MembraneError', type: 'rate_limit', retryable: true, retryAfterMs,
      });
      // Each case's own words, so a framework that stopped reading the stand-in
      // as a MembraneError, and gave every case one ending, fails here.
      const cases = [
        [7_200_000, 'the provider asked to wait 7200 s'],
        [Number.POSITIVE_INFINITY, 'the provider asked to wait longer than can be represented'],
        [Number.NaN, "the provider's stated wait is not a number"],
      ] as const;
      for (const [i, [wait, words]] of cases.entries()) {
        const out = fw.statedWaitNotSlept(stated(wait));
        expect(out.error.startsWith('429 rate_limit_error: try again later (')).toBe(true);
        expect(out.error).toContain(words);
        next = new ProviderWaitNotSleptError(out.error, out.statedWaitMs);
        const before = h.runs();
        const res = await h.subagent.handleToolCall(call('spawn', `framework-waiter-${i}`));
        expect(res.success).toBe(false);
        expect(h.runs() - before).toBe(1);
        expect(JSON.stringify(res)).toContain(words);
        expect(h.throttle()).toEqual({ halved: false, throttled: false });
      }
    } finally {
      await h.cleanup();
    }
  }, 30_000);
});
