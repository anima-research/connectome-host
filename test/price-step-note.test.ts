import { describe, expect, test } from 'bun:test';
import { defaultTokenEstimator } from '@animalabs/context-manager';
import { validateRecipe } from '../src/recipe.js';
import { priceStepNote } from '../src/recipe-fit.js';

const recipe = (agent: Record<string, unknown>) => validateRecipe({ name: 'step', agent: { systemPrompt: '', ...agent } });
const onApi = (agent: Record<string, unknown> = {}) => recipe({ provider: 'openai-responses', model: 'gpt-6.1-sol', ...agent });
const n = (value: number) => value.toLocaleString('en-US');
// The host's default agent.maxTokens, and context-manager's default overBudgetGraceRatio: a compile sends at most
// floor((budget - maxTokens) x (1 + grace)) of conversation, then the system prompt and the 32,000 the fit keeps for tools.
const REPLY = 16_384;
const reach = (budget: number, system: number, reply = REPLY, grace = 0.02) => Math.max(0, Math.floor((budget - reply) * (1 + grace))) + system + 32_000;
function largest(system: number, reply = REPLY, grace = 0.02): number {
  let lo = 0, hi = 1_000_000;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (reach(mid, system, reply, grace) <= 272_000) lo = mid; else hi = mid - 1; }
  return lo;
}

describe("the start note on OpenAI's 272,000-token price step", () => {
  test('a budget whose requests can pass the step on the API gets a note naming the step, the input it can reach, the budget under it and both sides\' rates', () => {
    const note = priceStepNote(onApi(), 'gpt-6.1-sol')!;
    expect(note).toContain('gpt-6.1-sol');
    expect(note).toContain('272,000');
    expect(note).toContain('300,000');
    expect(note).toContain(n(reach(300_000, 0)));
    expect(note).toContain(`${n(largest(0))} or less`);
    expect(note).toContain('standard');
    expect(note).toContain('$4.00 input, $0.20 cached input and $15.00 output');
    expect(note).toContain('$2.00, $0.10 and $10.00');
  });

  test('the line is input alone, as the compile sends it: the budget less agent.maxTokens, 2% over, the system prompt and 32,000 for tools', () => {
    expect(priceStepNote(onApi({ contextBudgetTokens: largest(0) }), 'gpt-6.1-sol')).toBeUndefined();
    expect(priceStepNote(onApi({ contextBudgetTokens: largest(0) + 1 }), 'gpt-6.1-sol')).toContain(`${n(largest(0))} or less`);
    const systemPrompt = 'a fixture sentence of the resident\'s own. '.repeat(400);
    const system = defaultTokenEstimator(systemPrompt);
    expect(system).toBeGreaterThan(1_000);
    expect(priceStepNote(onApi({ systemPrompt, contextBudgetTokens: largest(system) }), 'gpt-6.1-sol')).toBeUndefined();
    expect(priceStepNote(onApi({ systemPrompt, contextBudgetTokens: largest(system) + 1 }), 'gpt-6.1-sol')).toContain(`${n(largest(system))} or less`);
    expect(priceStepNote(onApi({ systemPrompt: 'You are a resident.', contextBudgetTokens: 250_000 }), 'gpt-6.1-sol')).toBeUndefined();
    const reply = 32_000;
    expect(priceStepNote(onApi({ maxTokens: reply, contextBudgetTokens: largest(0, reply) }), 'gpt-6.1-sol')).toBeUndefined();
    expect(priceStepNote(onApi({ maxTokens: reply, contextBudgetTokens: largest(0, reply) + 1 }), 'gpt-6.1-sol')).toContain(`${n(largest(0, reply))} or less`);
    const exact = { strategy: { overBudgetGraceRatio: 0 } };
    expect(priceStepNote(onApi({ ...exact, contextBudgetTokens: largest(0, REPLY, 0) }), 'gpt-6.1-sol')).toBeUndefined();
    expect(priceStepNote(onApi({ ...exact, contextBudgetTokens: largest(0, REPLY, 0) + 1 }), 'gpt-6.1-sol')).toContain(`${n(largest(0, REPLY, 0))} or less`);
  });

  test('at an empty system prompt and the default reply and grace, a budget of 251,679 gets no note and 251,680 gets one', () => {
    expect(priceStepNote(onApi({ contextBudgetTokens: 251_679 }), 'gpt-6.1-sol')).toBeUndefined();
    expect(priceStepNote(onApi({ contextBudgetTokens: 251_680 }), 'gpt-6.1-sol')).toContain('251,679 or less');
  });

  test('on the passthrough strategy, which compiles to the budget less agent.maxTokens with no grace, the line counts none: 256,384 gets no note and 256,385 gets one', () => {
    const passthrough = { strategy: { type: 'passthrough' } };
    expect(priceStepNote(onApi({ ...passthrough, contextBudgetTokens: 256_384 }), 'gpt-6.1-sol')).toBeUndefined();
    const note = priceStepNote(onApi({ ...passthrough, contextBudgetTokens: 256_385 }), 'gpt-6.1-sol')!;
    expect(note).toContain('256,384 or less');
    expect(note).not.toContain('% over that');
  });

  test('on frontdesk the count says it leaves out the provenance headers frontdesk adds after selecting, and names no budget under the step', () => {
    const note = priceStepNote(onApi({ strategy: { type: 'frontdesk' } }), 'gpt-6.1-sol')!;
    expect(note).toContain('kept for tools, leaving out the provenance headers frontdesk adds to messages from a server.');
    expect(note).not.toContain('or less');
    expect(priceStepNote(onApi(), 'gpt-6.1-sol')).not.toContain('provenance');
  });

  test('the system prompt is counted as the agent is given it, without the legacy fold paragraph the host takes off', () => {
    const legacy = 'When your context folds, the reasoning behind your earlier replies leaves it, though their words stay, ' +
      'so a reply of yours that shows no reasoning may still have had some.';
    const prompt = 'You are a resident of the house, with long instructions of your own. '.repeat(200);
    expect(priceStepNote(onApi({ systemPrompt: `${prompt}\n\n${legacy}` }), 'gpt-6.1-sol')).toBe(priceStepNote(onApi({ systemPrompt: prompt }), 'gpt-6.1-sol'));
  });

  test('the grace is shown to four significant figures, so a small one is still shown', () => {
    expect(priceStepNote(onApi({ strategy: { overBudgetGraceRatio: 0.000049 } }), 'gpt-6.1-sol')).toContain('and up to 0.0049% over that');
    expect(priceStepNote(onApi(), 'gpt-6.1-sol')).toContain('and up to 2% over that');
  });

  test('no note on a strategy an extension builds, whose compile the host can\'t count', () => {
    const built = onApi();
    const extension = { ...built, agent: { ...built.agent, strategy: { type: 'my-extension-strategy' } } } as typeof built;
    expect(priceStepNote(built, 'gpt-6.1-sol')).toBeDefined();
    expect(priceStepNote(extension, 'gpt-6.1-sol')).toBeUndefined();
  });

  test('the budget search ends whatever the figures: no budget where the fixed input alone passes the step, and none named where the figures pass what a double counts by one', () => {
    const systemPrompt = 'a resident\'s long fixed instructions. '.repeat(30_000);
    expect(defaultTokenEstimator(systemPrompt)).toBeGreaterThan(240_000);
    const huge = priceStepNote(onApi({ systemPrompt, maxTokens: 1e20 }), 'gpt-6.1-sol')!;
    expect(huge).toContain('No budget keeps a request\'s input to 272,000 tokens or fewer by that count');
    const unsafe = priceStepNote(onApi({ maxTokens: 1e20, contextBudgetTokens: 2e20 }), 'gpt-6.1-sol')!;
    expect(unsafe).toContain('kept for tools.');
    expect(unsafe).not.toContain('or less');
    expect(unsafe).not.toContain('No budget');
  });

  test("the rates are the recipe's tier's: flex's for flex, Fast mode's for priority", () => {
    expect(priceStepNote(onApi({ responses: { serviceTier: 'flex' } }), 'gpt-6.1-sol')).toContain('$2.00 input, $0.10 cached input and $7.50 output');
    expect(priceStepNote(onApi({ responses: { serviceTier: 'priority' } }), 'gpt-6.1-sol')).toContain('$8.00 input, $0.40 cached input and $30.00 output');
    const auto = priceStepNote(onApi({ responses: { serviceTier: 'auto' } }), 'gpt-6.1-sol')!;
    expect(auto).toContain('standard');
    expect(auto).toContain('$4.00 input, $0.20 cached input and $15.00 output');
  });

  test('where the tier\'s row gives no long-context rates, the note says the page gives rates up to the step and none past it', () => {
    expect(priceStepNote(onApi({ model: 'gpt-6-cyber', responses: { serviceTier: 'flex' } }), 'gpt-6-cyber')).toBeUndefined();
    const note = priceStepNote(onApi({ model: 'gpt-6-cyber' }), 'gpt-6-cyber')!;
    expect(note).toContain('rates for a request of up to 272,000 input tokens and none for a longer one');
    expect(note).not.toContain('bills');
  });

  test("no note on Codex, a third party's API, Anthropic or Bedrock, for a model priced in one column, or for a name the page doesn't list", () => {
    expect(priceStepNote(recipe({ provider: 'openai-codex', model: 'gpt-6.1-sol' }), 'gpt-6.1-sol')).toBeUndefined();
    expect(priceStepNote(recipe({ provider: 'openrouter', model: 'openai/gpt-6.1-sol' }), 'openai/gpt-6.1-sol')).toBeUndefined();
    expect(priceStepNote(recipe({ provider: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', model: 'gpt-6.1-sol' }), 'gpt-6.1-sol')).toBeUndefined();
    expect(priceStepNote(recipe({ model: 'claude-opus-5-5' }), 'claude-opus-5-5')).toBeUndefined();
    expect(priceStepNote(recipe({ provider: 'bedrock', model: 'us.anthropic.claude-opus-4-6-v1' }), 'us.anthropic.claude-opus-4-6-v1')).toBeUndefined();
    for (const provider of ['anthropic', 'bedrock']) {
      expect(priceStepNote(recipe({ provider, model: 'gpt-6.1-sol' }), 'gpt-6.1-sol')).toBeUndefined();
    }
    expect(priceStepNote(onApi({ model: 'gpt-5.4-mini' }), 'gpt-5.4-mini')).toBeUndefined();
    expect(priceStepNote(onApi({ model: 'gpt-9' }), 'gpt-9')).toBeUndefined();
  });
});
