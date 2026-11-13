import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Membrane, NormalizedRequest } from '@animalabs/membrane';
import {
  ANTHROPIC_AUXILIARY_MODEL, AUXILIARY_REASONING_ROOM, auxiliaryModel, auxiliaryModelOverride, auxiliaryRequest, auxiliarySteering,
} from '../src/auxiliary-model.js';
import { generateSessionName, resetSessionNamingWarning } from '../src/synesthete.js';
import { activitySummaryRequest } from '../src/activity-summary.js';
import { retrievalModuleConfig } from '../src/retrieval-config.js';
import { retrievalRequestFields } from '../src/modules/retrieval-module.js';
import { gateOptionsFor } from '../src/gate-options.js';
import { validateRecipe } from '../src/recipe.js';

const recipe = (agent: Record<string, unknown>, top: Record<string, unknown> = {}) =>
  validateRecipe({ name: 'aux', agent: { systemPrompt: 'sys', ...agent }, ...top });

const codex = () => recipe({ provider: 'openai-codex', model: 'gpt-6.1-sol' });
const anthropic = () => recipe({ provider: 'anthropic', model: 'claude-opus-5-5' });

/** A membrane that records each request and answers from `answers`, or throws when an answer is an Error. */
function stubMembrane(answers: Array<string | Error>, stopReason = 'end_turn') {
  const requests: NormalizedRequest[] = [];
  const membrane = {
    complete: async (request: NormalizedRequest) => {
      requests.push(request);
      const answer = answers.shift();
      if (answer instanceof Error) throw answer;
      return { content: [{ type: 'text', text: answer ?? '' }], stopReason };
    },
  } as unknown as Membrane;
  return { membrane, requests };
}

let savedModel: string | undefined;
beforeEach(() => {
  savedModel = process.env.MODEL;
  delete process.env.MODEL;
});
afterEach(() => {
  if (savedModel === undefined) delete process.env.MODEL;
  else process.env.MODEL = savedModel;
});

describe('auxiliaryModel: the host steers its small calls only where the provider cannot serve the Haiku defaults', () => {
  test('the anthropic route and Bedrock keep Claude Haiku: Bedrock maps the id to an inference profile (R1-1)', () => {
    for (const r of [anthropic(), recipe({ model: 'claude-opus-5-5' }), recipe({ provider: 'bedrock', model: 'anthropic.claude-sonnet-4-5' })]) {
      expect(auxiliaryModelOverride(r)).toBeUndefined();
      expect(auxiliaryModel(r)).toBe(ANTHROPIC_AUXILIARY_MODEL);
    }
  });

  test('every other provider gets the resident\'s own model, MODEL in the environment first', () => {
    expect(auxiliaryModel(codex())).toBe('gpt-6.1-sol');
    expect(auxiliaryModel(recipe({ provider: 'openrouter', model: 'openai/gpt-5.6-sol' }))).toBe('openai/gpt-5.6-sol');
    expect(auxiliaryModel(recipe({ provider: 'openai-responses', model: 'gpt-5.6' }))).toBe('gpt-5.6');
    expect(auxiliaryModel(recipe({ provider: 'openai-compatible', model: 'local-llm', baseUrl: 'http://localhost:11434/v1' }))).toBe('local-llm');
    process.env.MODEL = 'gpt-5.6-sol';
    expect(auxiliaryModel(codex())).toBe('gpt-5.6-sol');
    expect(auxiliaryModelOverride(codex())).toBe('gpt-5.6-sol');
  });

  test('a recipe\'s auxiliaryModel wins on every route, and is validated as a model id', () => {
    expect(auxiliaryModel(recipe({ provider: 'openai-codex', model: 'gpt-6.1-sol' }, { auxiliaryModel: 'gpt-5.6-sol' }))).toBe('gpt-5.6-sol');
    expect(auxiliaryModelOverride(recipe({ provider: 'anthropic' }, { auxiliaryModel: 'claude-haiku-5-5' }))).toBe('claude-haiku-5-5');
    for (const bad of ['', '  ', ' gpt-5.4 ', 5, null]) {
      expect(() => recipe({}, { auxiliaryModel: bad })).toThrow(/auxiliaryModel must be a model id with no space around it/);
    }
  });

  test('sessionNaming takes examples only, and refuses what it did not read before (R1-6)', () => {
    expect(() => recipe({}, { sessionNaming: { modle: 'x' } })).toThrow(/sessionNaming has unknown key "modle"; it takes examples/);
    expect(() => recipe({}, { sessionNaming: { model: 'x' } })).toThrow(/sessionNaming has unknown key "model"/);
    expect(() => recipe({}, { sessionNaming: { examples: ['a', 1] } })).toThrow(/sessionNaming\.examples must be an array of strings/);
    expect(() => recipe({}, { sessionNaming: { examples: 'x' } })).toThrow(/sessionNaming\.examples must be an array of strings/);
    expect(() => recipe({}, { sessionNaming: null })).toThrow(/sessionNaming must be an object/);
    expect(() => recipe({}, { sessionNaming: 'x' })).toThrow(/sessionNaming must be an object/);
    expect(recipe({}, { sessionNaming: { examples: ['Thread Archaeology'] } }).sessionNaming).toEqual({ examples: ['Thread Archaeology'] });
  });
});

describe('auxiliaryRequest: what the request carries per route (R1-2)', () => {
  test('anthropic and Bedrock: Haiku, the caller\'s cap, no temperature, no provider params', () => {
    for (const r of [anthropic(), recipe({ provider: 'bedrock', model: 'anthropic.claude-opus-4-7' })]) {
      expect(auxiliaryRequest(r, 30)).toEqual({ config: { model: ANTHROPIC_AUXILIARY_MODEL, maxTokens: 30 } });
    }
  });

  test('the Responses family: the resident\'s model, room to reason, effort low', () => {
    expect(auxiliaryRequest(codex(), 30)).toEqual({
      config: { model: 'gpt-6.1-sol', maxTokens: AUXILIARY_REASONING_ROOM },
      providerParams: { reasoning: { effort: 'low' } },
    });
    expect(auxiliaryRequest(recipe({ provider: 'openai-responses', model: 'gpt-5.6' }), 40).providerParams).toEqual({ reasoning: { effort: 'low' } });
  });

  test('a model the recipe names is sent as it is: no reasoning object for it, and an always-thinking Claude id gets the room (R2-5)', () => {
    const named = auxiliaryRequest(recipe({ provider: 'openai-responses', model: 'gpt-5.6' }, { auxiliaryModel: 'gpt-4.1-mini' }), 30);
    expect(named).toEqual({ config: { model: 'gpt-4.1-mini', maxTokens: AUXILIARY_REASONING_ROOM } });
    expect(auxiliaryRequest(recipe({ provider: 'anthropic' }, { auxiliaryModel: 'claude-fable-5-1' }), 30))
      .toEqual({ config: { model: 'claude-fable-5-1', maxTokens: AUXILIARY_REASONING_ROOM } });
    expect(auxiliaryRequest(recipe({ provider: 'anthropic' }, { auxiliaryModel: 'claude-haiku-5-5' }), 30))
      .toEqual({ config: { model: 'claude-haiku-5-5', maxTokens: 30 } });
  });

  test('OpenRouter and openai-compatible: the resident\'s model and room to reason, nothing the adapter would not forward', () => {
    expect(auxiliaryRequest(recipe({ provider: 'openrouter', model: 'openai/gpt-5.6-sol' }), 40))
      .toEqual({ config: { model: 'openai/gpt-5.6-sol', maxTokens: AUXILIARY_REASONING_ROOM } });
  });
});

describe('generateSessionName sends that request and says once when no name came back (R1-4, R1-8)', () => {
  const stderrLines: string[] = [];
  let write: typeof process.stderr.write;
  beforeEach(() => {
    resetSessionNamingWarning();
    stderrLines.length = 0;
    write = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => { stderrLines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  });
  afterEach(() => { process.stderr.write = write; });

  test('on Codex the request names the resident\'s model, no temperature, effort low; the answer is the name', async () => {
    const { membrane, requests } = stubMembrane(['Pipeline Debug']);
    expect(await generateSessionName(membrane, 'summary', ['Thread Archaeology'], codex())).toBe('Pipeline Debug');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.config).toEqual({ model: 'gpt-6.1-sol', maxTokens: AUXILIARY_REASONING_ROOM });
    expect(requests[0]!.providerParams).toEqual({ reasoning: { effort: 'low' } });
    expect(requests[0]!.system).toContain('Thread Archaeology');
    expect(stderrLines).toEqual([]);
  });

  test('on anthropic the request is Haiku at 30 tokens, and MODEL in the environment steers Codex', async () => {
    const one = stubMembrane(['Schema Migration']);
    await generateSessionName(one.membrane, 'summary', undefined, anthropic());
    expect(one.requests[0]!.config).toEqual({ model: ANTHROPIC_AUXILIARY_MODEL, maxTokens: 30 });
    expect(one.requests[0]!.providerParams).toBeUndefined();

    process.env.MODEL = 'gpt-5.6-sol';
    const two = stubMembrane(['Schema Migration']);
    await generateSessionName(two.membrane, 'summary', undefined, codex());
    expect(two.requests[0]!.config.model).toBe('gpt-5.6-sol');
  });

  test('two failed calls give one warning, on stderr, naming the model and the error', async () => {
    const { membrane } = stubMembrane([new Error('model is not supported'), new Error('model is not supported')]);
    expect(await generateSessionName(membrane, 'summary', undefined, codex())).toBeNull();
    expect(await generateSessionName(membrane, 'summary', undefined, codex())).toBeNull();
    expect(stderrLines).toHaveLength(1);
    expect(stderrLines[0]).toContain('[session-naming] the naming call to gpt-6.1-sol gave no name');
    expect(stderrLines[0]).toContain('recipe auxiliaryModel picks the model');
    expect(stderrLines[0]).toContain('the call failed: model is not supported');
  });

  test('an answer that is not a name is warned the same way, with its stop reason and length', async () => {
    const { membrane } = stubMembrane(['', ''], 'max_tokens');
    expect(await generateSessionName(membrane, 'summary', undefined, codex())).toBeNull();
    expect(await generateSessionName(membrane, 'summary', undefined, codex())).toBeNull();
    expect(stderrLines).toHaveLength(1);
    expect(stderrLines[0]).toContain("its answer wasn't a name (stop reason max_tokens, 0 characters)");

    resetSessionNamingWarning();
    stderrLines.length = 0;
    const long = stubMembrane(['A name that runs on and on, far past the sixty characters a session name may have']);
    expect(await generateSessionName(long.membrane, 'summary', undefined, anthropic())).toBeNull();
    expect(stderrLines[0]).toMatch(/stop reason end_turn, \d+ characters\)/);
  });
});

describe('the fleet view\'s summaries, retrieval, the judge and the suppression review follow the same model (R1-3, R1-5)', () => {
  test('activitySummaryRequest carries the auxiliary request for the route', () => {
    const onCodex = activitySummaryRequest(codex(), 'did things');
    expect(onCodex.config).toEqual({ model: 'gpt-6.1-sol', maxTokens: AUXILIARY_REASONING_ROOM });
    expect(onCodex.providerParams).toEqual({ reasoning: { effort: 'low' } });
    expect(onCodex.messages[0]!.content[0]).toEqual({ type: 'text', text: expect.stringContaining('did things') });
    const onAnthropic = activitySummaryRequest(anthropic(), 'did things');
    expect(onAnthropic.config).toEqual({ model: ANTHROPIC_AUXILIARY_MODEL, maxTokens: 40 });
    expect(onAnthropic.providerParams).toBeUndefined();
    expect(activitySummaryRequest(recipe({ provider: 'openrouter', model: 'x/y' }, { auxiliaryModel: 'x/small' }), 'w').config.model).toBe('x/small');
  });

  test('retrieval defaults its model from the helper where the recipe names none, and its request takes what the route accepts (R2-2)', () => {
    const membrane = {} as Membrane;
    const onCodex = retrievalModuleConfig(membrane, recipe({ provider: 'openai-codex', model: 'gpt-6.1-sol' }, { modules: { retrieval: true } }));
    expect(retrievalRequestFields(onCodex)).toEqual({
      config: { model: 'gpt-6.1-sol', maxTokens: 500 },
      providerParams: { reasoning: { effort: 'low' } },
    });
    const onResponses = retrievalModuleConfig(membrane, recipe({ provider: 'openai-responses', model: 'gpt-5.6' }, { modules: { retrieval: true } }));
    expect(retrievalRequestFields(onResponses)).toEqual({
      config: { model: 'gpt-5.6', maxTokens: 500 },
      providerParams: { reasoning: { effort: 'low' } },
    });
    const onOpenRouter = retrievalModuleConfig(membrane, recipe({ provider: 'openrouter', model: 'openai/gpt-5.6-sol' }, { modules: { retrieval: true } }));
    expect(retrievalRequestFields(onOpenRouter)).toEqual({ config: { model: 'openai/gpt-5.6-sol', maxTokens: 500 } });
    // The anthropic route keeps the module's own Haiku default, deterministic, as it always was.
    const onAnthropic = retrievalModuleConfig(membrane, recipe({ provider: 'anthropic' }, { modules: { retrieval: true } }));
    expect(onAnthropic.retrievalModel).toBeUndefined();
    expect(retrievalRequestFields(onAnthropic)).toEqual({ config: { model: 'claude-haiku-4-5-20251001', maxTokens: 500, temperature: 0 } });
    // A model the recipe names is kept, with the effort the recipe set and none otherwise.
    const named = retrievalModuleConfig(membrane, recipe({ provider: 'openai-codex', model: 'gpt-6.1-sol' }, { modules: { retrieval: { model: 'gpt-5.6-sol', reasoningEffort: 'medium' } } }));
    expect(retrievalRequestFields(named)).toEqual({ config: { model: 'gpt-5.6-sol', maxTokens: 500 }, providerParams: { reasoning: { effort: 'medium' } } });
    const namedPlain = retrievalModuleConfig(membrane, recipe({ provider: 'openai-codex', model: 'gpt-6.1-sol' }, { modules: { retrieval: { model: 'gpt-5.6-sol' } } }));
    expect(retrievalRequestFields(namedPlain)).toEqual({ config: { model: 'gpt-5.6-sol', maxTokens: 500 } });
  });

  test('gateOptionsFor steers the judge and the suppression review: the model where one is needed, effort none off the routes that take output_config, and a named or disabled judge left alone (R2-1)', () => {
    const offRoute = { model: 'gpt-6.1-sol', anthropicEffort: false };
    const plain = gateOptionsFor(true, '/store', {}, offRoute)!;
    expect(plain.judge).toEqual({ model: 'gpt-6.1-sol', effort: 'none' });
    expect(plain.suppressionReview).toEqual({ model: 'gpt-6.1-sol', effort: 'none' });

    const named = gateOptionsFor({ judge: { model: 'gpt-5.6-sol', timeoutMs: 5000, effort: 'low' } }, '/store', {}, offRoute)!;
    expect(named.judge).toEqual({ model: 'gpt-5.6-sol', timeoutMs: 5000, effort: 'low' });
    const namedNoEffort = gateOptionsFor({ judge: { model: 'gpt-5.6-sol' } }, '/store', {}, offRoute)!;
    expect(namedNoEffort.judge).toEqual({ model: 'gpt-5.6-sol', effort: 'none' });

    const off = gateOptionsFor({ judge: { enabled: false } }, '/store', {}, offRoute)!;
    expect(off.judge).toEqual({ enabled: false });
    expect(off.suppressionReview).toEqual({ model: 'gpt-6.1-sol', effort: 'none' });

    // A Claude id named on the anthropic route keeps the framework's effort.
    const onRoute = gateOptionsFor(true, '/store', {}, { model: 'claude-haiku-5-5', anthropicEffort: true })!;
    expect(onRoute.judge).toEqual({ model: 'claude-haiku-5-5' });
    expect(onRoute.suppressionReview).toEqual({ model: 'claude-haiku-5-5' });

    const anthropicRoute = gateOptionsFor(true, '/store', {})!;
    expect(anthropicRoute.judge).toBeUndefined();
    expect(anthropicRoute.suppressionReview).toBeUndefined();

    expect(auxiliarySteering(codex())).toEqual(offRoute);
    expect(auxiliarySteering(anthropic())).toBeUndefined();
    expect(auxiliarySteering(recipe({ provider: 'anthropic' }, { auxiliaryModel: 'claude-haiku-5-5' }))).toEqual({ model: 'claude-haiku-5-5', anthropicEffort: true });
  });
});
