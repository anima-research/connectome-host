import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextManager, defaultTokenEstimator } from '@animalabs/context-manager';
import { DEFAULT_RECIPE, type Recipe, loadRecipe, loadRecipeDetailed, loadSavedRecipe, saveRecipe, savedRecipePath, validateRecipe } from '../src/recipe.js';
import { effectiveContextBudgetTokens, recipeFit } from '../src/recipe-fit.js';
import { LIMITS_TABLE } from '../src/model-limits.js';
import { buildFrameworkAgentConfig } from '../src/framework-agent-config.js';
import { buildFrameworkStrategy } from '../src/framework-strategy.js';

const HAIKU = 'claude-haiku-4-5';
const AT_AN_END = 'At an end of a named range, the compile can have no room left for older history, or the prompt can fill the window, ' +
  'leaving none for the tool definitions the host sends beside it; a recipe there loads and then fails once its conversation fills the compile.';
const OPUS = 'claude-opus-4-6';

let dir: string;
const originalFetch = globalThis.fetch;
const originalModel = process.env.MODEL;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'recipe-fit-'));
  delete process.env.MODEL;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalModel === undefined) delete process.env.MODEL; else process.env.MODEL = originalModel;
  rmSync(dir, { recursive: true, force: true });
});

function recipeFile(agent: Record<string, unknown>): string {
  const path = join(dir, `recipe-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify({ name: 'fit', agent: { systemPrompt: '', ...agent } }));
  return path;
}

function tailOf(agent: Record<string, unknown>, model: string) {
  const recipe = validateRecipe({ name: 'fit', agent: { systemPrompt: '', ...agent } });
  return (buildFrameworkStrategy(recipe, model, 'UTC') as unknown as { config: { recentWindowTokens: number } }).config.recentWindowTokens;
}

function agentConfig(agent: Record<string, unknown>, model: string) {
  const recipe = validateRecipe({ name: 'fit', agent: { systemPrompt: '', ...agent } });
  return buildFrameworkAgentConfig(recipe, 'agent', model, buildFrameworkStrategy(recipe, model, 'UTC'));
}

const UNIT = 'the river carried stones. ';
const PER_UNIT = defaultTokenEstimator(UNIT.repeat(1_000)) / 1_000;

function promptOfAbout(tokens: number): string {
  const text = (length: number) => UNIT.repeat(Math.ceil(length / UNIT.length)).slice(0, Math.max(0, length));
  let length = Math.max(0, Math.floor(tokens * (UNIT.length / PER_UNIT)));
  while (length > 0 && defaultTokenEstimator(text(length)) > tokens) length--;
  while (defaultTokenEstimator(text(length + 1)) <= tokens) length++;
  return text(length);
}

describe('a recipe load refuses what Anthropic refuses', () => {
  test('maxTokens over the model\'s maximum output is refused, naming both and the most it may be', async () => {
    const error = await loadRecipe(recipeFile({ model: HAIKU, maxTokens: 64_001 })).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('64,001');
    expect((error as Error).message).toContain('64,000');
    expect((await loadRecipe(recipeFile({ model: HAIKU, maxTokens: 64_000 }))).agent.maxTokens).toBe(64_000);
    await expect(loadRecipe(recipeFile({ model: OPUS, maxTokens: 128_001 }))).rejects.toThrow('128,000');
    expect((await loadRecipe(recipeFile({ model: OPUS, maxTokens: 128_000 }))).agent.maxTokens).toBe(128_000);
  });

  test('maxTokens over the maximum output is refused even when the budget can\'t be read', async () => {
    await expect(loadRecipe(recipeFile({ model: HAIKU, maxTokens: 70_000, contextBudgetTokens: 'lots' }))).rejects.toThrow(
      'Set it to 64,000 or less. The rest of the fit isn\'t checked: agent.contextBudgetTokens is "lots", not a number of tokens.');
    await expect(loadRecipe(recipeFile({ model: HAIKU, maxTokens: 70_000, contextBudgetTokens: 'lots', thinking: { enabled: true, budgetTokens: 10_000 } }))).rejects.toThrow(
      'Set it to between 10,001 and 64,000. The rest of the fit');
    await expect(loadRecipe(recipeFile({ model: HAIKU, maxTokens: 70_000, contextBudgetTokens: 'lots', thinking: { enabled: true, budgetTokens: 63_999.9999 } }))).rejects.toThrow(
      'Set it to 64,000. The rest of the fit');
    expect((await loadRecipe(recipeFile({ model: HAIKU, maxTokens: 64_000, contextBudgetTokens: 'lots', thinking: { enabled: true, budgetTokens: 63_999.9999 } }))).agent.maxTokens).toBe(64_000);
  });

  test('a thinking budget at or above the maximum output is named as what keeps maxTokens over it, with the budget readable or not', async () => {
    for (const budgetTokens of [64_000, 65_000]) {
      const thinking = { enabled: true, budgetTokens };
      const fact = `Recipe agent.thinking.budgetTokens (${budgetTokens.toLocaleString('en-US')}) is at or above that maximum, and the loader requires agent.maxTokens above it, ` +
        'so agent.maxTokens can\'t come within the maximum until the thinking budget is below 64,000.';
      const unreadable = await loadRecipe(recipeFile({ model: HAIKU, maxTokens: 70_000, contextBudgetTokens: 'lots', thinking })).then(() => '', (error: Error) => error.message);
      expect(unreadable).toContain(`${fact} The rest of the fit isn't checked`);
      expect(unreadable).not.toContain('Set it to');
      const readable = await loadRecipe(recipeFile({ model: HAIKU, maxTokens: 70_000, contextBudgetTokens: 100_000, thinking })).then(() => '', (error: Error) => error.message);
      expect(readable).toContain(`${fact} No budget, no lower agent.maxTokens, and no shorter system prompt fits it alone.`);
    }
  });

  test('a budget whose prompt passes the window is refused, naming the budget, the window and the most it may be; at the limit it loads', async () => {
    const atLimit = { model: HAIKU, maxTokens: 16_000, contextBudgetTokens: 216_000 };
    const loaded = await loadRecipe(recipeFile(atLimit));
    expect(loaded.agent.contextBudgetTokens).toBe(216_000);
    expect(recipeFit(loaded, HAIKU)).toEqual({ checked: true, fits: true });
    const error = await loadRecipe(recipeFile({ ...atLimit, contextBudgetTokens: 216_001 })).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    for (const figure of ['216,001', '200,000', '216,000']) expect((error as Error).message).toContain(figure);
    expect((error as Error).message).toContain('less the size of the tools');
  });

  test('the system prompt counts: a budget that fits with none is refused beside a long one', async () => {
    const fits = { model: HAIKU, maxTokens: 16_000, contextBudgetTokens: 210_000 };
    await loadRecipe(recipeFile(fits));
    await expect(loadRecipe(recipeFile({ ...fits, systemPrompt: 'the river carried stones. '.repeat(2_000) }))).rejects.toThrow('200,000');
  });

  test('a system prompt that fills the window by itself is named as what to shorten, with no budget to lower', async () => {
    const error = await loadRecipe(recipeFile({
      model: HAIKU, maxTokens: 16_000, contextBudgetTokens: 100_000, systemPrompt: promptOfAbout(210_000),
    })).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('by itself fills');
    expect((error as Error).message).toMatch(/Shorten the system prompt to about [\d,]+ tokens or fewer, less the size of the tools the host sends beside the prompt\./);
    expect((error as Error).message).not.toContain('budget to');
  });

  async function floorNamed(agent: Record<string, unknown>): Promise<number> {
    const error = await loadRecipe(recipeFile(agent)).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    const named = /A budget of ([\d,]+) holds the head and the verbatim tail (?:alone|that budget gets)\. (?:Raise the budget|Set agent\.contextBudgetTokens) above that/.exec((error as Error).message);
    expect(named).not.toBeNull();
    const floor = Number(named![1]!.replaceAll(',', ''));
    expect((await loadRecipe(recipeFile({ ...agent, contextBudgetTokens: floor }))).agent.contextBudgetTokens).toBe(floor);
    await expect(loadRecipe(recipeFile({ ...agent, contextBudgetTokens: floor - 1 }))).rejects.toThrow('holds the head and the verbatim tail');
    return floor;
  }

  test('a budget no larger than maxTokens, 0 and below included, is refused, since the conversation gets no room, naming the budget the head and tail fill', async () => {
    for (const budget of [16_384, 10_000, 0, -1_000]) {
      const error = await loadRecipe(recipeFile({ model: HAIKU, maxTokens: 16_384, contextBudgetTokens: budget })).catch((e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(`(${budget.toLocaleString('en-US')})`);
      expect((error as Error).message).toContain('no room');
    }
    await floorNamed({ model: HAIKU, maxTokens: 16_384, contextBudgetTokens: 10_000 });
  });

  test('a budget that leaves less room than the head and the tail need is refused, naming the budget they fill alone', async () => {
    const error = await loadRecipe(recipeFile({ model: HAIKU, maxTokens: 16_384, contextBudgetTokens: 17_000 })).catch((e: Error) => e);
    expect((error as Error).message).toContain('4,000-token head');
    const floor = await floorNamed({ model: HAIKU, maxTokens: 16_384, contextBudgetTokens: 17_000 });
    const nullTail = { model: HAIKU, maxTokens: 16_384, contextBudgetTokens: 17_000, strategy: { type: 'autobiographical', recentWindowTokens: null } };
    expect(await floorNamed(nullTail)).toBe(floor);
  });

  const ownTail = (strategy: Record<string, unknown>) => ({ model: HAIKU, maxTokens: 16_384, strategy: { type: 'autobiographical', headWindowTokens: 4_000, ...strategy } });
  async function edge(agent: Record<string, unknown>, loads: number) {
    expect((await loadRecipe(recipeFile({ ...agent, contextBudgetTokens: loads }))).agent.contextBudgetTokens).toBe(loads);
    await expect(loadRecipe(recipeFile({ ...agent, contextBudgetTokens: loads - 1 }))).rejects.toThrow('every reply fails');
  }

  test('the head and tail are held to context-manager\'s rule: floor((budget - maxTokens) x (1 + grace)), the grace 0.02 by default', async () => {
    await edge(ownTail({ recentWindowTokens: 6_000 }), 26_188);
    await edge(ownTail({ recentWindowTokens: 6_000, overBudgetGraceRatio: null }), 26_384);
    await edge(ownTail({ recentWindowTokens: 6_000, overBudgetGraceRatio: 0.35 }), 23_792);
    await edge(ownTail({ recentWindowTokens: 6_000, overBudgetGraceRatio: -1 }), 26_384);
  });

  test('a recipe\'s own tail is held to the same room, and the refusal names the tail it may lower to', async () => {
    const agent = { ...ownTail({ recentWindowTokens: 2_000 }), contextBudgetTokens: 21_384 };
    const error = await loadRecipe(recipeFile(agent)).catch((e: Error) => e);
    expect((error as Error).message).toContain('2,000-token verbatim tail');
    expect((error as Error).message).toContain('; lower agent.maxTokens to 15,501 or less; lower strategy.recentWindowTokens to 1,100 or less; ' +
      'or lower strategy.headWindowTokens to 3,100 or less. ' + AT_AN_END);
    await floorNamed(agent);
  });

  test('where a named range has an end that loads with the compile or the window full, the refusal says what a recipe there meets', () => {
    const agent = { ...ownTail({ recentWindowTokens: 2_000 }), contextBudgetTokens: 21_384 };
    const at = (maxTokens: number) => recipeFit(validateRecipe({ name: 'fit', agent: { systemPrompt: '', ...agent, maxTokens } }), HAIKU);
    expect(at(15_501)).toEqual({ checked: true, fits: true });
    const floorFull = recipeFit(validateRecipe({ name: 'fit', agent: { systemPrompt: '', maxTokens: 70_000, contextBudgetTokens: 220_000 } }), HAIKU);
    expect(floorFull.checked && !floorFull.fits && floorFull.refusal).toContain('Lower agent.maxTokens to between 20,000 and 64,000. ' + AT_AN_END);
    expect(recipeFit(validateRecipe({ name: 'fit', agent: { systemPrompt: '', maxTokens: 20_000, contextBudgetTokens: 220_000 } }), HAIKU)).toEqual({ checked: true, fits: true });
    const roomy = recipeFit(validateRecipe({ name: 'fit', agent: { systemPrompt: '', maxTokens: 70_000 } }), HAIKU);
    expect(roomy.checked && !roomy.fits && roomy.refusal).toMatch(/Lower agent\.maxTokens to 64,000 or less\.$/);
  });

  test('with its own budget, a system prompt way whose top fills the window says the tools come off it, as the budget way does', () => {
    const ownBudget = recipeFit(validateRecipe({ name: 'fit', agent: { systemPrompt: promptOfAbout(20_000), maxTokens: 16_000, contextBudgetTokens: 200_000 } }), HAIKU);
    expect(ownBudget.checked && !ownBudget.fits && ownBudget.refusal).toMatch(
      /; or shorten the system prompt to about [\d,]+ tokens or fewer, less the size of the tools the host sends beside the prompt\. At an end of a named range/);
    const noBudget = recipeFit(validateRecipe({ name: 'fit', agent: { systemPrompt: promptOfAbout(150_000), maxTokens: 16_384 } }), HAIKU);
    expect(noBudget.checked && !noBudget.fits && noBudget.refusal).toMatch(/shorten the system prompt to about [\d,]+ tokens or fewer\. At an end/i);
  });

  test('an own tail of zero or less is no tail, and no refusal offers to lower it', async () => {
    await edge(ownTail({ recentWindowTokens: -5_000 }), 20_306);
    await edge(ownTail({ recentWindowTokens: 0 }), 20_306);
    const error = await loadRecipe(recipeFile({ ...ownTail({ recentWindowTokens: -5_000 }), contextBudgetTokens: 20_305 })).catch((e: Error) => e);
    expect((error as Error).message).not.toContain('recentWindowTokens');
  });

  test('a strategy that keeps no raw windows is held only to a budget above maxTokens', () => {
    const passthrough = (budget: number) => recipeFit(validateRecipe({ name: 'fit', agent: { systemPrompt: '', maxTokens: 16_384, contextBudgetTokens: budget, strategy: { type: 'passthrough' } } }), HAIKU);
    expect(passthrough(16_385)).toEqual({ checked: true, fits: true });
    const refused = passthrough(16_384);
    expect(refused.checked && !refused.fits && refused.refusal).toContain('no room');
    expect(refused.checked && !refused.fits && refused.refusal).not.toContain('head');
    expect(refused.checked && !refused.fits && refused.refusal).not.toContain('At an end');
    const extension = (budget: number) => recipeFit({ name: 'fit', agent: { systemPrompt: '', maxTokens: 16_384, contextBudgetTokens: budget, strategy: { type: 'an-extension', headWindowTokens: 'x' as never } } } as never, HAIKU);
    expect(extension(16_385)).toEqual({ checked: true, fits: true });
    expect(extension(16_384)).toMatchObject({ checked: true, fits: false });
  });

  test('a head of zero or less is no head, and a head, tail or grace that isn\'t a number leaves the fit unchecked, with the budget the host runs', async () => {
    const noHead = validateRecipe({ name: 'fit', agent: { systemPrompt: '', maxTokens: 16_384, contextBudgetTokens: 17_000, strategy: { type: 'autobiographical', headWindowTokens: -4_000 } } });
    expect(recipeFit(noHead, HAIKU)).toEqual({ checked: true, fits: true });
    const lines: Array<[Record<string, unknown>, string]> = [
      [{ headWindowTokens: '4000' }, 'strategy.headWindowTokens is "4000", not a number of tokens.'],
      [{ recentWindowTokens: '500' }, 'strategy.recentWindowTokens is "500", not a number of tokens.'],
      [{ overBudgetGraceRatio: '0.35' }, 'strategy.overBudgetGraceRatio is "0.35", not a number.'],
    ];
    for (const [strategy, line] of lines) {
      const fit = recipeFit(validateRecipe({ name: 'fit', agent: { systemPrompt: '', strategy: { type: 'autobiographical', ...strategy } } }), HAIKU);
      expect(fit.checked).toBe(false);
      expect(fit.checked === false && fit.line).toContain(line);
      expect(fit.checked === false && fit.line).toContain('the budget is 168,000');
    }
  });

  test('a tail that passes the budget inside the grace counts in the prompt: beside a system prompt, it passes the window', () => {
    const fit = recipeFit(validateRecipe({ name: 'fit', agent: {
      systemPrompt: promptOfAbout(9_000), maxTokens: 16_384, contextBudgetTokens: 206_384,
      strategy: { type: 'autobiographical', headWindowTokens: 4_000, recentWindowTokens: 189_000 },
    } }), HAIKU);
    expect(fit.checked && !fit.fits && fit.refusal).toContain('where they come to more');
    expect(fit.checked && !fit.fits && fit.refusal).toContain('over claude-haiku-4-5\'s window');
  });

  test('a recipe with no budget is offered a budget only where one keeps the 32k its refusal kept for the tools', () => {
    const refusal = (tokens: number) => {
      const fit = recipeFit(validateRecipe({ name: 'fit', agent: { systemPrompt: promptOfAbout(tokens) } }), HAIKU);
      return fit.checked && !fit.fits ? fit.refusal : '';
    };
    const tight = refusal(165_000);
    expect(tight).toContain('once 32,000 are kept for the tools');
    expect(tight).not.toContain('contextBudgetTokens above');
    expect(tight).toMatch(/Shorten the system prompt to about [\d,]+ tokens or fewer\. At an end of a named range/);
    const roomy = recipeFit(validateRecipe({ name: 'fit', agent: { systemPrompt: promptOfAbout(100_000), maxTokens: 64_000 } }), HAIKU);
    const text = roomy.checked && !roomy.fits ? roomy.refusal : '';
    const most = /to no more than ([\d,]+), which leaves 32,000 of the window for the tools/.exec(text);
    expect(most).not.toBeNull();
    const top = Number(most![1]!.replaceAll(',', ''));
    const own = (budget: number) => recipeFit(validateRecipe({ name: 'fit', agent: { systemPrompt: promptOfAbout(100_000), maxTokens: 64_000, contextBudgetTokens: budget } }), HAIKU);
    expect(own(top)).toEqual({ checked: true, fits: true });
    expect(own(top + 32_000)).toEqual({ checked: true, fits: true });
    expect(own(top + 32_001)).toMatchObject({ checked: true, fits: false });
  });

  test('where no one change fits, the refusal says so and names no way', () => {
    const agent = { systemPrompt: promptOfAbout(197_000), maxTokens: 16_384, contextBudgetTokens: 20_000 };
    const fit = recipeFit(validateRecipe({ name: 'fit', agent }), HAIKU);
    const refusal = fit.checked && !fit.fits ? fit.refusal : '';
    expect(refusal).toContain('No budget, no lower agent.maxTokens, and no shorter system prompt fits it alone.');
    expect(refusal).not.toContain('A budget of');
    expect(namedRanges(refusal, agent)).toEqual([]);
  });

  type Knob = 'budget' | 'maxTokens' | 'recentWindowTokens' | 'headWindowTokens' | 'system';
  const num = (text: string) => Number(text.replaceAll(',', ''));
  function namedRanges(refusal: string, agent: Record<string, unknown>): Array<[Knob, number, number]> {
    const reply = (agent.maxTokens as number | undefined) ?? 16_384;
    const ranges: Array<[Knob, number, number]> = [];
    const floor = /A budget of ([\d,]+) holds the head/.exec(refusal);
    const raise = /(?:raise the budget|set agent\.contextBudgetTokens) above (that|agent\.maxTokens),(?: so older history has room beside them, and)? to no more than ([\d,]+),/i.exec(refusal);
    if (raise) ranges.push(['budget', (raise[1] === 'that' ? num(floor![1]!) : reply) + 1, num(raise[2]!)]);
    const lower = /lower the budget to ([\d,]+) or less, .*?, and above (?:([\d,]+), which|agent\.maxTokens)/i.exec(refusal);
    if (lower) ranges.push(['budget', (lower[2] ? num(lower[2]) : reply) + 1, num(lower[1]!)]);
    const one = /set (?:the budget|agent\.contextBudgetTokens) to ([\d,]+), the one whole budget/i.exec(refusal);
    if (one) ranges.push(['budget', num(one[1]!), num(one[1]!)]);
    for (const knob of ['maxTokens', 'recentWindowTokens', 'headWindowTokens'] as const) {
      const field = knob === 'maxTokens' ? 'agent\\.maxTokens' : `strategy\\.${knob}`;
      const way = new RegExp(`lower ${field} to (?:between ([\\d,]+) and ([\\d,]+)|([\\d,]+)( or less)?)`, 'i').exec(refusal);
      if (way) {
        const low = knob === 'maxTokens' ? 1 : 0;
        ranges.push(way[1] ? [knob, num(way[1]), num(way[2]!)] : [knob, way[4] ? low : num(way[3]!), num(way[3]!)]);
      }
    }
    const shorten = /shorten the system prompt to (?:between about ([\d,]+) and ([\d,]+) tokens|about ([\d,]+) tokens( or fewer)?)|empty the system prompt/i.exec(refusal);
    if (shorten) {
      ranges.push(shorten[1] ? ['system', num(shorten[1]), num(shorten[2]!)]
        : shorten[3] ? ['system', shorten[4] ? 0 : num(shorten[3]), num(shorten[3])] : ['system', 0, 0]);
    }
    return ranges;
  }
  const PROMPTS = new Map<number, string>();
  const promptAt = (tokens: number) => {
    if (!PROMPTS.has(tokens)) PROMPTS.set(tokens, promptOfAbout(tokens));
    return PROMPTS.get(tokens)!;
  };
  function changed(base: Recipe, knob: Knob, value: number): Recipe {
    const agent = { ...base.agent };
    if (knob === 'budget') agent.contextBudgetTokens = value;
    else if (knob === 'maxTokens') agent.maxTokens = value;
    else if (knob === 'system') agent.systemPrompt = promptAt(value);
    else agent.strategy = { ...(agent.strategy ?? { type: 'autobiographical' }), [knob]: value };
    return { ...base, agent };
  }
  function loads(base: Recipe, knob: Knob, value: number, model: string): boolean {
    let recipe = changed(base, knob, value);
    try {
      validateRecipe(recipe as never);
    } catch {
      return false;
    }
    if (knob === 'budget' && (base.agent.contextBudgetTokens ?? undefined) === undefined) {
      const tools = promptAt(defaultTokenEstimator(base.agent.systemPrompt) + 32_000);
      recipe = { ...recipe, agent: { ...recipe.agent, systemPrompt: tools } };
    }
    const after = recipeFit(recipe, model);
    return after.checked && after.fits;
  }
  const spread = (from: number, to: number, count: number) =>
    [...new Set(Array.from({ length: count }, (_, i) => Math.round(from + ((to - from) * i) / Math.max(1, count - 1))))];

  test('every way a refusal names loads at values across the range it names, and a single change it tries that loads is named', () => {
    const prompts = [0, 120_000, 185_000, 205_000];
    const strategies: Array<Record<string, unknown> | undefined> = [
      undefined,
      { type: 'autobiographical', recentWindowTokens: 2_000 },
      { type: 'autobiographical', recentWindowTokens: 150_000, overBudgetGraceRatio: 0.35 },
      { type: 'autobiographical', headWindowTokens: 30_000, overBudgetGraceRatio: null },
      { type: 'autobiographical', headWindowTokens: 52_000 },
      { type: 'frontdesk', headWindowTokens: 250_000, recentWindowTokens: 20_000 },
      { type: 'passthrough' },
    ];
    const counts = { refusals: 0, ways: 0, values: 0, lowered: 0, unset: 0, output: 0 };
    for (const [model, maxima] of [[HAIKU, [undefined, 8_192, 64_000, 70_000]], [OPUS, [16_384, 128_000]]] as const) {
      for (const tokens of prompts) {
        for (const maxTokens of maxima) {
          for (const contextBudgetTokens of [undefined, 0, 20_000, 70_000, 100_000, 180_000, 400_000]) {
            for (const strategy of strategies) {
              const agent: Record<string, unknown> = { systemPrompt: promptAt(tokens), maxTokens, contextBudgetTokens, ...(strategy ? { strategy } : {}) };
              const base = validateRecipe({ name: 'fit', agent });
              const fit = recipeFit(base, model);
              if (!fit.checked || fit.fits) continue;
              counts.refusals++;
              if (fit.refusal.includes('maximum output')) counts.output++;
              if (/lower the budget to/i.test(fit.refusal)) counts.lowered++;
              if (contextBudgetTokens === undefined && /set agent\.contextBudgetTokens/i.test(fit.refusal)) counts.unset++;
              const ranges = namedRanges(fit.refusal, agent);
              const where = { model, tokens, maxTokens, contextBudgetTokens, strategy };
              if (ranges.length === 0) expect({ where, refusal: fit.refusal }).toEqual({ where, refusal: expect.stringContaining('fits it alone.') });
              for (const [knob, from, to] of ranges) {
                counts.ways++;
                for (const value of spread(from, to, knob === 'system' ? 4 : 7)) {
                  counts.values++;
                  expect({ where, knob, value, loads: loads(base, knob, value, model) }).toEqual({ where, knob, value, loads: true });
                }
              }
              const named = new Set(ranges.map(([knob]) => knob));
              const reply = maxTokens ?? 16_384;
              const tried: Array<[Knob, number[]]> = [
                ['maxTokens', spread(1, reply - 1, 12)],
                ['system', spread(0, Math.max(0, base.agent.systemPrompt ? tokens - 1 : -1), 3)],
              ];
              tried.push(['budget', spread(reply + 1, reply + 1_000_000, 24)]);
              const own = strategy && strategy.type !== 'passthrough' ? strategy : undefined;
              if (own?.recentWindowTokens !== undefined) tried.push(['recentWindowTokens', spread(0, (own.recentWindowTokens as number) - 1, 12)]);
              if (own?.headWindowTokens !== undefined) tried.push(['headWindowTokens', spread(0, (own.headWindowTokens as number) - 1, 12)]);
              for (const [knob, values] of tried) {
                if (named.has(knob) || (knob === 'system' && tokens === 0)) continue;
                const loading = values.filter((value) => loads(base, knob, value, model));
                expect({ where, knob, unnamedThatLoad: loading }).toEqual({ where, knob, unnamedThatLoad: [] });
              }
            }
          }
        }
      }
    }
    expect(counts.refusals).toBeGreaterThan(200);
    expect(counts.ways).toBeGreaterThan(300);
    expect(counts.values).toBeGreaterThan(1_500);
    expect(counts.lowered).toBeGreaterThan(5);
    expect(counts.unset).toBeGreaterThan(2);
    expect(counts.output).toBeGreaterThan(5);
  }, 180_000);

  test('where a smaller head would take the larger default tail, the head way names only a range that loads', () => {
    const base = validateRecipe({ name: 'fit', agent: {
      systemPrompt: promptOfAbout(116_000), maxTokens: 16_384, contextBudgetTokens: 100_000,
      strategy: { type: 'autobiographical', headWindowTokens: 52_000 },
    } });
    const fit = recipeFit(base, HAIKU);
    const text = fit.checked && !fit.fits ? fit.refusal : '';
    const way = /lower strategy\.headWindowTokens to between ([\d,]+) and ([\d,]+)/i.exec(text);
    expect(way).not.toBeNull();
    for (const head of spread(num(way![1]!), num(way![2]!), 9)) expect(recipeFit(changed(base, 'headWindowTokens', head), HAIKU)).toEqual({ checked: true, fits: true });
    expect(recipeFit(changed(base, 'headWindowTokens', 44_800), HAIKU)).toMatchObject({ checked: true, fits: false });
    expect(recipeFit(changed(base, 'headWindowTokens', 40_000), HAIKU)).toEqual({ checked: true, fits: true });
  });

  test('fractional token counts end the check, and a number that isn\'t finite is named as it is', () => {
    for (const agent of [{ maxTokens: 16_384.5, contextBudgetTokens: 17_000 }, { maxTokens: 16_384, contextBudgetTokens: 20_000.5, strategy: { type: 'autobiographical', headWindowTokens: 3_999.5 } }]) {
      expect(recipeFit(validateRecipe({ name: 'fit', agent: { systemPrompt: '', ...agent } }), HAIKU)).toMatchObject({ checked: true, fits: false });
    }
    const infinite = recipeFit(validateRecipe({ name: 'fit', agent: { systemPrompt: '', strategy: { type: 'autobiographical', overBudgetGraceRatio: Infinity } } }), HAIKU);
    expect(infinite.checked === false && infinite.line).toContain('strategy.overBudgetGraceRatio is Infinity, not a finite number');
    for (const [agent, line] of [
      [{ maxTokens: Infinity }, 'agent.maxTokens is Infinity, not a finite number of tokens.'],
      [{ contextBudgetTokens: Infinity }, 'agent.contextBudgetTokens is Infinity, not a finite number of tokens.'],
      [{ strategy: { type: 'autobiographical', headWindowTokens: -Infinity } }, 'strategy.headWindowTokens is -Infinity, not a finite number of tokens.'],
    ] as const) {
      const fit = recipeFit({ name: 'fit', agent: { systemPrompt: '', ...agent } } as never, HAIKU);
      expect(fit.checked === false && fit.line).toContain(line);
    }
    const huge = recipeFit(validateRecipe({ name: 'fit', agent: { systemPrompt: '', maxTokens: 6e15, strategy: { type: 'passthrough' } } }), HAIKU);
    expect(huge).toMatchObject({ checked: true, fits: false });
  });

  test('where a shorter system prompt would take the larger default tail, the system prompt way names only a range that loads', () => {
    const base = validateRecipe({ name: 'fit', agent: {
      systemPrompt: promptOfAbout(50_000), maxTokens: 8_192,
      strategy: { type: 'autobiographical', headWindowTokens: 110_000, overBudgetGraceRatio: 0.35 },
    } });
    const fit = recipeFit(base, HAIKU);
    const way = /shorten the system prompt to between about ([\d,]+) and ([\d,]+) tokens/i.exec(fit.checked && !fit.fits ? fit.refusal : '');
    expect(way).not.toBeNull();
    expect(num(way![1]!)).toBeGreaterThan(0);
    for (const tokens of spread(num(way![1]!), num(way![2]!), 5)) expect(loads(base, 'system', tokens, HAIKU)).toBe(true);
    expect(loads(base, 'system', 39_500, HAIKU)).toBe(false);
    expect(loads(base, 'system', 30_000, HAIKU)).toBe(true);
  });

  test('a range of one value is named as that value: the one budget that loads, and a tail of 0', () => {
    const prompt = promptOfAbout(190_000);
    const tail = 200_000 - defaultTokenEstimator(prompt) - 4_000;
    const single = { systemPrompt: prompt, maxTokens: 16_384, contextBudgetTokens: 20_000, strategy: { type: 'autobiographical', headWindowTokens: 4_000, recentWindowTokens: tail, overBudgetGraceRatio: null } };
    const one = recipeFit(validateRecipe({ name: 'fit', agent: single }), HAIKU);
    const named = /set the budget to ([\d,]+), the one whole budget this check accepts, counting no tools/i.exec(one.checked && !one.fits ? one.refusal : '');
    expect(named).not.toBeNull();
    const budget = num(named![1]!);
    expect(budget).toBe(16_384 + 4_000 + tail);
    const own = (value: number) => recipeFit(validateRecipe({ name: 'fit', agent: { ...single, contextBudgetTokens: value } }), HAIKU);
    expect(own(budget)).toEqual({ checked: true, fits: true });
    expect(own(budget - 1)).toMatchObject({ checked: true, fits: false });
    expect(own(budget + 1)).toMatchObject({ checked: true, fits: false });
    const zero = recipeFit(validateRecipe({ name: 'fit', agent: { systemPrompt: '', maxTokens: 16_384, contextBudgetTokens: 20_306, strategy: { type: 'autobiographical', headWindowTokens: 4_000, recentWindowTokens: 500 } } }), HAIKU);
    expect(zero.checked && !zero.fits && zero.refusal).toMatch(/lower strategy\.recentWindowTokens to 0[;.]/i);
  });

  test('the one whole budget that loads is named as that, for a recipe with no budget, with empty windows, and above a fractional maxTokens', () => {
    const prompt = promptOfAbout(150_000);
    const tail = 200_000 - defaultTokenEstimator(prompt) - 32_000 - 4_000;
    const noBudget = recipeFit(validateRecipe({ name: 'fit', agent: { systemPrompt: prompt, maxTokens: 16_384, strategy: { type: 'autobiographical', headWindowTokens: 4_000, recentWindowTokens: tail, overBudgetGraceRatio: null } } }), HAIKU);
    expect(noBudget.checked && !noBudget.fits && noBudget.refusal).toContain(
      `Set agent.contextBudgetTokens to ${(16_384 + 4_000 + tail).toLocaleString('en-US')}, the one whole budget that loads and leaves 32,000 of the window for the tools, where the head and the verbatim tail fill the compile and leave older history no room`);
    const full = promptOfAbout(199_999);
    const empty = recipeFit(validateRecipe({ name: 'fit', agent: { systemPrompt: full, maxTokens: 16_384, contextBudgetTokens: 10_000, strategy: { type: 'autobiographical', headWindowTokens: 0, recentWindowTokens: 0 } } }), HAIKU);
    expect(empty.checked && !empty.fits && empty.refusal).toContain('Set the budget to 16,385, the one whole budget this check accepts, counting no tools;');
    const fractional = recipeFit(validateRecipe({ name: 'fit', agent: { systemPrompt: full, maxTokens: 16_384.5, contextBudgetTokens: 10_000, strategy: { type: 'passthrough' } } }), HAIKU);
    expect(fractional.checked && !fractional.fits && fractional.refusal).toContain('Set the budget to 16,385, the one whole budget this check accepts, counting no tools;');
    expect(recipeFit(validateRecipe({ name: 'fit', agent: { systemPrompt: full, maxTokens: 16_384.5, contextBudgetTokens: 16_385, strategy: { type: 'passthrough' } } }), HAIKU)).toEqual({ checked: true, fits: true });
  });

  test('a recipe with no budget whose own tail passes the window inside a large grace is told the budget is the host\'s', () => {
    const fit = recipeFit(validateRecipe({ name: 'fit', agent: { systemPrompt: '', maxTokens: 16_384, strategy: { type: 'autobiographical', headWindowTokens: 4_000, recentWindowTokens: 197_000, overBudgetGraceRatio: 0.35 } } }), HAIKU);
    expect(fit.checked && !fit.fits && fit.refusal).toContain('The budget the host gives this recipe, 168,000, lets a turn\'s prompt reach 201,000 tokens');
  });

  test('maxTokens is never lowered to or below an enabled thinking budget, and a fractional maxTokens still finds the first budget above it', () => {
    const thinking = recipeFit(validateRecipe({ name: 'fit', agent: { systemPrompt: '', maxTokens: 16_384, contextBudgetTokens: 18_000, thinking: { enabled: true, budgetTokens: 10_000 } } }), HAIKU);
    const way = /lower agent\.maxTokens to between ([\d,]+) and ([\d,]+)/i.exec(thinking.checked && !thinking.fits ? thinking.refusal : '');
    expect(way).not.toBeNull();
    expect(num(way![1]!)).toBeGreaterThan(10_000);
    const fractional = recipeFit(validateRecipe({ name: 'fit', agent: { systemPrompt: '', maxTokens: 16_384.5, contextBudgetTokens: 16_000, strategy: { type: 'passthrough' } } }), HAIKU);
    expect(fractional.checked && !fractional.fits && fractional.refusal).toMatch(/raise the budget above agent\.maxTokens/i);
    expect(recipeFit(validateRecipe({ name: 'fit', agent: { systemPrompt: '', maxTokens: 16_384.5, contextBudgetTokens: 16_385, strategy: { type: 'passthrough' } } }), HAIKU)).toEqual({ checked: true, fits: true });
  });

  test('a maxTokens over the maximum output is refused with only the values that load', () => {
    const fit = recipeFit(validateRecipe({ name: 'fit', agent: { systemPrompt: '', maxTokens: 70_000, contextBudgetTokens: 220_000 } }), HAIKU);
    const text = fit.checked && !fit.fits ? fit.refusal : '';
    expect(text).toContain('over claude-haiku-4-5\'s maximum output of 64,000 tokens');
    expect(text).toMatch(/lower agent\.maxTokens to between ([\d,]+) and 64,000/i);
    expect(text).not.toContain('or less');
  });

  test('the default recipe, which no loader checks, fits every model the table holds', () => {
    for (const { id } of LIMITS_TABLE) expect([id, recipeFit(DEFAULT_RECIPE, id)]).toEqual([id, { checked: true, fits: true }]);
  });

  test('a load checks the model the host will run, MODEL first, and says when MODEL chose it', async () => {
    process.env.MODEL = OPUS;
    expect((await loadRecipe(recipeFile({ model: HAIKU, contextBudgetTokens: 400_000 }))).agent.contextBudgetTokens).toBe(400_000);
    process.env.MODEL = HAIKU;
    const error = await loadRecipe(recipeFile({ model: OPUS, contextBudgetTokens: 400_000 })).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('200,000');
    expect((error as Error).message).toContain(`${HAIKU} is MODEL in the environment, which the host runs in place of agent.model.`);
  });

  test('a refusal names MODEL only where MODEL changes the model the recipe runs', async () => {
    process.env.MODEL = HAIKU;
    const same = await loadRecipe(recipeFile({ model: HAIKU, contextBudgetTokens: 400_000 })).catch((e: Error) => e);
    expect((same as Error).message).toContain('200,000');
    expect((same as Error).message).not.toContain('is MODEL in the environment');
    process.env.MODEL = OPUS;
    const theDefault = await loadRecipe(recipeFile({ maxTokens: 128_001 })).catch((e: Error) => e);
    expect((theDefault as Error).message).toContain('128,000');
    expect((theDefault as Error).message).not.toContain('is MODEL in the environment');
    process.env.MODEL = HAIKU;
    for (const named of [{}, { model: '' }]) {
      const another = await loadRecipe(recipeFile({ ...named, contextBudgetTokens: 400_000 })).catch((e: Error) => e);
      expect((another as Error).message).toContain(`${HAIKU} is MODEL in the environment, which the host runs in place of its default, ${OPUS}.`);
    }
  });

  test('a URL system prompt counts as the text it fetches', async () => {
    globalThis.fetch = (async () => new Response('the river carried stones. '.repeat(2_000))) as unknown as typeof fetch;
    await expect(loadRecipe(recipeFile({
      model: HAIKU, maxTokens: 16_000, contextBudgetTokens: 210_000, systemPrompt: 'https://example.invalid/prompt.txt',
    }))).rejects.toThrow('200,000');
  });

  test('a saved recipe is refused at its load the same way; the store audit\'s load refuses nothing', async () => {
    const raw = { name: 'fit', agent: { systemPrompt: '', model: HAIKU, maxTokens: 64_001 } };
    saveRecipe(dir, structuredClone(raw));
    await expect(loadSavedRecipe(dir)).rejects.toThrow('64,000');
    expect((await loadSavedRecipe(dir, { fetchSystemPrompt: false }))?.agent.maxTokens).toBe(64_001);
    expect((await loadRecipeDetailed(recipeFile(raw.agent), { fetchSystemPrompt: false })).recipe.agent.maxTokens).toBe(64_001);
  });

  test('a saved recipe written by an earlier release, a resolved snapshot, is refused at its load the same way', async () => {
    writeFileSync(savedRecipePath(dir), JSON.stringify({ name: 'fit', agent: { systemPrompt: '', model: HAIKU, maxTokens: 64_001 } }));
    await expect(loadSavedRecipe(dir)).rejects.toThrow('64,000');
    expect((await loadSavedRecipe(dir, { fetchSystemPrompt: false }))?.agent.maxTokens).toBe(64_001);
  });
});

describe('context-manager\'s own strategy at the edges the fit computes', () => {
  // The fit copies context-manager's head-and-tail rule; these drive the strategy the host builds, at the version
  // installed, so a change there to the reservation over plain messages, or to where a window of them ends, fails
  // here. A 4,000-token head and a 6,000-token own tail, each filled exactly, put context-manager's edge where the
  // fit's is.
  const cases: Array<[string, Record<string, unknown>]> = [
    ['the default grace', {}],
    ['a null grace', { overBudgetGraceRatio: null }],
    ['a grace of 0.35', { overBudgetGraceRatio: 0.35 }],
    ['a negative grace', { overBudgetGraceRatio: -1 }],
  ];
  const agentWith = (strategy: Record<string, unknown>, budget: number) => ({
    systemPrompt: '', model: HAIKU, maxTokens: 16_384, contextBudgetTokens: budget,
    strategy: { type: 'autobiographical', headWindowTokens: 4_000, recentWindowTokens: 6_000, ...strategy },
  });
  function edgeOf(strategy: Record<string, unknown>): number {
    const fits = (budget: number) => {
      const fit = recipeFit(validateRecipe({ name: 'fit', agent: agentWith(strategy, budget) }), HAIKU);
      return fit.checked && fit.fits;
    };
    let lo = 16_385, hi = 100_000;
    while (lo < hi) { const mid = lo + Math.floor((hi - lo) / 2); if (fits(mid)) hi = mid; else lo = mid + 1; }
    return lo;
  }
  async function compiled(strategy: Record<string, unknown>, budget: number, messages = 10): Promise<true | string> {
    const recipe = validateRecipe({ name: 'fit', agent: agentWith(strategy, budget) });
    const root = mkdtempSync(join(tmpdir(), 'fit-edge-'));
    try {
      const cm = await ContextManager.open({ path: join(root, 'store'), strategy: buildFrameworkStrategy(recipe, HAIKU, 'UTC') as never });
      try {
        const thousand = promptOfAbout(1_000);
        for (let i = 0; i < messages; i++) cm.addMessage(i % 2 ? 'res' : 'Antra', [{ type: 'text', text: thousand }]);
        await cm.compile({ maxTokens: budget, reserveForResponse: 16_384 });
        return true;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      } finally {
        cm.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  for (const [name, strategy] of cases) {
    test(`with ${name}, the fit's least budget compiles a full head and tail, and one less is refused at the reservation`, async () => {
      const edge = edgeOf(strategy);
      expect(await compiled(strategy, edge)).toBe(true);
      expect(await compiled(strategy, edge - 1)).toContain('Head/tail reservation exceeded budget');
    });

    test(`with ${name}, history past the windows leaves the head and tail at their sizes when one less is refused`, async () => {
      const refusal = await compiled(strategy, edgeOf(strategy) - 1, 12);
      expect(refusal).toContain('Head/tail reservation exceeded budget');
      expect(refusal).toContain('head=4000, tail=6000');
    });
  }
});

describe('a recipe that sets no budget', () => {
  test('on a 200k model, the budget is the window less the system prompt and 32k, and the stream ceiling 20k above it', async () => {
    const config = agentConfig({ maxTokens: 16_000 }, HAIKU);
    expect(config.contextBudgetTokens).toBe(200_000 - 32_000);
    expect(config.maxStreamTokens).toBe(200_000 - 32_000 + 20_000);
    const prompt = 'the river carried stones. '.repeat(400);
    const withPrompt = agentConfig({ maxTokens: 16_000, systemPrompt: prompt }, HAIKU);
    expect(withPrompt.contextBudgetTokens).toBe(200_000 - 32_000 - defaultTokenEstimator(prompt));
    expect((await loadRecipe(recipeFile({ model: HAIKU }))).agent.contextBudgetTokens).toBeUndefined();
  });

  test('on a 1M model, it stays at 300k with a 320k stream ceiling', () => {
    expect(agentConfig({}, OPUS)).toMatchObject({ contextBudgetTokens: 300_000, maxStreamTokens: 320_000 });
  });

  test('with a large maxTokens beside a large system prompt, the tail is 40% of the budget less maxTokens, so the head and tail fit', () => {
    const recipe = validateRecipe({ name: 'fit', agent: { systemPrompt: 'the river carried stones. '.repeat(10_000), maxTokens: 64_000 } });
    const budget = effectiveContextBudgetTokens(recipe, HAIKU);
    expect(4_000 + Math.round(budget * 0.4)).toBeGreaterThan(budget - 64_000);
    const tail = tailOf({ systemPrompt: 'the river carried stones. '.repeat(10_000), maxTokens: 64_000 }, HAIKU);
    expect(tail).toBe(Math.round((budget - 64_000) * 0.4));
    expect(4_000 + tail).toBeLessThanOrEqual(budget - 64_000);
    expect(tailOf({ contextBudgetTokens: 100_000, maxTokens: 64_000 }, HAIKU)).toBe(14_400);
    expect(tailOf({ contextBudgetTokens: 112_000, maxTokens: 64_000 }, HAIKU)).toBe(44_800);
    expect(tailOf({ maxTokens: 16_000 }, HAIKU)).toBe(Math.round(effectiveContextBudgetTokens(validateRecipe({ name: 'fit', agent: { systemPrompt: '', maxTokens: 16_000 } }), HAIKU) * 0.4));
    expect(tailOf({ systemPrompt: 'the river carried stones. '.repeat(10_000), maxTokens: 64_000, strategy: { type: 'autobiographical', recentWindowTokens: 40_000 } }, HAIKU)).toBe(40_000);
  });

  test('a system prompt that leaves the conversation less room than the head and tail need is refused, naming its size', () => {
    const unit = 'the river carried stones. ';
    const perUnit = defaultTokenEstimator(unit.repeat(1_000)) / 1_000;
    const prompt = unit.repeat(Math.round((200_000 - 32_000 - 64_000 - 3_000) / perUnit));
    const recipe = validateRecipe({ name: 'fit', agent: { systemPrompt: prompt, maxTokens: 64_000 } });
    const room = effectiveContextBudgetTokens(recipe, HAIKU) - 64_000;
    expect(room).toBeGreaterThan(0);
    expect(room).toBeLessThan(6_666);
    const fit = recipeFit(recipe, HAIKU);
    expect(fit.checked && !fit.fits && fit.refusal).toContain('4,000-token head');
    expect(fit.checked && !fit.fits && fit.refusal).toContain('agent.systemPrompt');
  });

  test('a system prompt that leaves the conversation no room is refused, naming its size', async () => {
    const error = await loadRecipe(recipeFile({ model: HAIKU, systemPrompt: 'the river carried stones. '.repeat(20_000) })).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('agent.systemPrompt');
    expect((error as Error).message).toMatch(/about [\d,]+ tokens/);
  });
});

describe('the stream ceiling', () => {
  test('a recipe with its own budget keeps the 150k stream ceiling', () => {
    expect(agentConfig({ contextBudgetTokens: 150_000 }, HAIKU).maxStreamTokens).toBe(150_000);
  });
});

describe('the start checks the model it runs', () => {
  const INDEX_PATH = join(import.meta.dir, '..', 'src', 'index.ts');
  const START_MS = 60_000;
  function start(agent: Record<string, unknown>, env: Record<string, string>) {
    const dataDir = join(dir, 'data');
    const noCredentials = { ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_OAUTH_CREDENTIALS_FILE: '', OPENROUTER_API_KEY: '', MODEL: '' };
    return spawnSync(process.execPath, [INDEX_PATH, '--headless', recipeFile(agent)], {
      cwd: dir, env: { ...process.env, DATA_DIR: dataDir, ...noCredentials, ...env }, encoding: 'utf-8', timeout: START_MS - 5_000,
    });
  }

  test('a recipe file that doesn\'t fit MODEL from the environment stops the start at its load, saying MODEL chose it', () => {
    const r = start({ model: OPUS, contextBudgetTokens: 400_000 }, { MODEL: HAIKU });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('200,000');
    expect(r.stderr).toContain('MODEL');
    expect(r.stderr).not.toContain('Missing ANTHROPIC_API_KEY');
  }, START_MS);

  test('a model with no known window gets one line saying the fit wasn\'t checked, and the start goes on to its credentials', () => {
    const r = start({ provider: 'openrouter', model: 'anthropic/claude-haiku-4-5' }, {});
    expect(r.stdout.split('\n').filter((line) => line.startsWith('[fit]'))).toHaveLength(1);
    expect(r.stdout).toContain('anthropic/claude-haiku-4-5');
    expect(r.stderr).toContain('Missing OPENROUTER_API_KEY');
  }, START_MS);

  test('the default recipe, which no loader reads, gets the same line for an unlisted MODEL', () => {
    const dataDir = join(dir, 'data');
    const noCredentials = { ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_OAUTH_CREDENTIALS_FILE: '', OPENROUTER_API_KEY: '' };
    const r = spawnSync(process.execPath, [INDEX_PATH, '--headless', '--no-recipe'], {
      cwd: dir, env: { ...process.env, DATA_DIR: dataDir, ...noCredentials, MODEL: 'claude-opus-4-1' }, encoding: 'utf-8', timeout: START_MS - 5_000,
    });
    expect(r.stdout.split('\n').filter((line) => line.startsWith('[fit]'))).toHaveLength(1);
    expect(r.stdout).toContain('claude-opus-4-1');
  }, START_MS);
});

describe('a token count that isn\'t a positive number', () => {
  const cases: Array<[string, Record<string, unknown>, string, string]> = [
    ['agent.maxTokens', { maxTokens: '16k' }, '"16k"', 'not a number of tokens.'],
    ['agent.contextBudgetTokens', { contextBudgetTokens: '200000' }, '"200000"', 'not a number of tokens.'],
    ['agent.maxTokens', { maxTokens: 0 }, '0', 'not a positive number of tokens.'],
  ];
  for (const [field, agent, shown, why] of cases) {
    test(`${field} as ${shown}: loads and runs as before (a budget it leaves unset is 300k), and the fit says it wasn't checked, naming the field and what it holds`, async () => {
      const loaded = await loadRecipe(recipeFile({ model: HAIKU, ...agent }));
      const fit = recipeFit(loaded, HAIKU);
      expect(fit.checked).toBe(false);
      expect(fit.checked === false && fit.line).toContain(`${field} is ${shown}, ${why}`);
      const config = agentConfig({ ...agent }, HAIKU);
      if ('maxTokens' in agent) expect(config.maxTokens).toBe(agent.maxTokens as never);
      if ('contextBudgetTokens' in agent) expect(config.contextBudgetTokens).toBe(agent.contextBudgetTokens as never);
      if (!('contextBudgetTokens' in agent)) {
        expect(config).toMatchObject({ contextBudgetTokens: 300_000, maxStreamTokens: 320_000 });
        expect(fit.checked === false && fit.line).toContain('the budget is 300,000');
      }
    });
  }

  test('null counts as unset for the budget and maxTokens, as before; a null budget keeps the 150k stream ceiling it had', () => {
    expect(agentConfig({ contextBudgetTokens: null }, OPUS)).toMatchObject({ contextBudgetTokens: 300_000, maxStreamTokens: 150_000 });
    expect(agentConfig({ maxTokens: null }, HAIKU)).toMatchObject({ maxTokens: 16_384, contextBudgetTokens: 200_000 - 32_000 });
    expect(recipeFit(validateRecipe({ name: 'fit', agent: { systemPrompt: '', maxTokens: null } }), HAIKU)).toEqual({ checked: true, fits: true });
  });

  test('an agent.model that isn\'t a string loads, and the fit says it wasn\'t checked', async () => {
    const loaded = await loadRecipe(recipeFile({ model: 42 }));
    expect(recipeFit(loaded, loaded.agent.model as never).checked).toBe(false);
  });
});

describe('where the host knows no window', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['another provider', { provider: 'openrouter' }, 'anthropic/claude-haiku-4-5'],
    ['Bedrock, whose limits differ', { provider: 'bedrock' }, HAIKU],
    ['a model with no row', {}, 'claude-opus-4-1'],
    ['an unlisted version under a listed model\'s id', {}, 'claude-opus-5-1'],
  ];
  for (const [name, agent, model] of cases) {
    test(`${name}: loads and runs as before, and the fit says it wasn't checked`, async () => {
      const loaded = await loadRecipe(recipeFile({ ...agent, model, maxTokens: 200_000, contextBudgetTokens: 900_000 }));
      expect(loaded.agent.contextBudgetTokens).toBe(900_000);
      const fit = recipeFit(loaded, model);
      expect(fit.checked).toBe(false);
      expect(fit.checked === false && fit.line).toContain(model);
      expect(agentConfig({ ...agent }, model)).toMatchObject({ contextBudgetTokens: 300_000, maxStreamTokens: 320_000 });
      const own = agentConfig({ ...agent, maxTokens: 200_000, contextBudgetTokens: 900_000 }, model);
      expect(own).toMatchObject({ maxTokens: 200_000, contextBudgetTokens: 900_000, maxStreamTokens: 150_000 });
    });
  }
});
