/**
 * The recipe's token counts, model names and ratios, by the rule their names
 * state: a `*Tokens` field refuses a negative and a fraction, a `model` or
 * `*Model` field refuses a blank string, a `*Ratio` field refuses a negative —
 * except the fields the host gives a meaning past the rule, listed here with
 * the value they take and why. The walk finds the fields by name, so a new one
 * declared with a bare `number()` or `text()` fails here, with its path
 * (#653, #656, #724).
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { recipeShape, validateRecipe } from '../src/recipe-schema.js';

type Found = { path: string; field: z.ZodType };

/** The schema under optional / nullable / default / readonly / pipe wrappers and a lazy thunk. */
function unwrap(field: z.ZodType): z.ZodType {
  let f: z.ZodType = field;
  for (let i = 0; i < 16; i++) {
    if (f instanceof z.ZodOptional || f instanceof z.ZodNullable || f instanceof z.ZodDefault || f instanceof z.ZodReadonly
      || f instanceof z.ZodNonOptional || f instanceof z.ZodCatch) f = f.unwrap() as z.ZodType;
    else if (f instanceof z.ZodPipe) f = f.in as z.ZodType;
    else if (f instanceof z.ZodLazy) f = f.unwrap() as z.ZodType;
    else break;
  }
  return f;
}

/** Every schema an object's field can be: the field itself, or each branch of a union / intersection. */
function branches(field: z.ZodType): z.ZodType[] {
  const f = unwrap(field);
  if (f instanceof z.ZodUnion || f instanceof z.ZodDiscriminatedUnion) return (f.options as z.ZodType[]).flatMap(branches);
  if (f instanceof z.ZodIntersection) return [...branches(f.def.left as z.ZodType), ...branches(f.def.right as z.ZodType)];
  return [f];
}

/** Every field under `shape`, by its dotted path; a schema reached by two paths is walked under each (depth-bounded). */
function walk(shape: Record<string, z.ZodType>, at: string, out: Found[], depth: number): void {
  if (depth > 12) throw new Error(`the recipe schema nests deeper than 12 at ${at}`);
  for (const [key, field] of Object.entries(shape)) {
    const path = at ? `${at}.${key}` : key;
    out.push({ path, field });
    for (const b of branches(field)) {
      if (b instanceof z.ZodObject) walk(b.shape as Record<string, z.ZodType>, path, out, depth + 1);
      else if (b instanceof z.ZodArray) for (const e of branches(b.element as z.ZodType)) { if (e instanceof z.ZodObject) walk(e.shape as Record<string, z.ZodType>, `${path}[]`, out, depth + 1); }
      else if (b instanceof z.ZodTuple) (b.def.items as z.ZodType[]).forEach((item, i) => { for (const e of branches(item)) if (e instanceof z.ZodObject) walk(e.shape as Record<string, z.ZodType>, `${path}[${i}]`, out, depth + 1); });
      else if (b instanceof z.ZodRecord || b instanceof z.ZodMap) for (const v of branches(b.valueType as z.ZodType)) { if (v instanceof z.ZodObject) walk(v.shape as Record<string, z.ZodType>, `${path}.*`, out, depth + 1); }
    }
  }
}

const fields: Found[] = [];
walk(recipeShape as unknown as Record<string, z.ZodType>, '', fields, 0);
const refuses = (field: z.ZodType, value: unknown) => !field.safeParse(value).success;
const last = (path: string) => path.split('.').pop()!.replace(/\[.*$/, '');
const tokens = fields.filter((f) => /Tokens$/.test(last(f.path)));
const models = fields.filter((f) => /^model$|Model$/.test(last(f.path)));
const ratios = fields.filter((f) => /Ratio$/.test(last(f.path)));

/** The fields the host gives a meaning past the rule their name states: the value each takes, and the
 *  test or doc that states it. A listed field must exist and must still take its value, so tightening
 *  one later means removing its entry here. */
const BY_DESIGN: Record<string, { takes: unknown; because: string }> = {
  'agent.maxTokens': { takes: 0, because: 'recipe-fit: "agent.maxTokens as 0: loads and runs as before"; a fractional one "still finds the first budget above it"' },
  'agent.contextBudgetTokens': { takes: -1, because: 'recipe-fit: "a budget no larger than maxTokens, 0 and below included, is refused", by the fit, naming the head and tail' },
  'agent.strategy.headWindowTokens': { takes: -1, because: 'recipe-fit: "a head of zero or less is no head"' },
  'agent.strategy.recentWindowTokens': { takes: -1, because: 'recipe-fit: "an own tail of zero or less is no tail"' },
  'agent.strategy.overBudgetGraceRatio': { takes: -1, because: 'recipe-fit: "with a negative grace, history past the windows leaves the head and tail at their sizes"' },
  'agent.thinking.budgetTokens': { takes: 1.5, because: "aboveZero is the field's own rule ('a positive number (finite)'); no test states a fraction's meaning" },
  'agent.maxStreamTokens': { takes: 1.5, because: "aboveZero is the field's own rule; compared with counts, a fraction is harmless" },
  'agent.strategy.kvUnified.thinkingHalfLifeTokens': { takes: 1.5, because: 'a decay scale (half-life), not a count' },
  'agent.strategy.kvUnified.policy.continuityRecencyHalfLifeTokens': { takes: 1.5, because: 'a decay scale (half-life), not a count' },
  'agent.model': { takes: '', because: '"" means the host\'s default model, or MODEL from the environment (recipe-fit: "a refusal names MODEL only where MODEL changes the model the recipe runs")' },
  'modules.subagents.defaultModel': { takes: '', because: '"" means the agent\'s resolved model (src/index.ts, the subagent module\'s config)' },
};
const ruled = (f: Found) => !(f.path in BY_DESIGN);

describe('recipe values by the rule their names state', () => {
  test('the walk reaches the fields it is for, and more than the issues named', () => {
    const paths = fields.map((f) => f.path);
    for (const p of ['agent.maxTokens', 'agent.strategy.headWindowTokens', 'agent.strategy.compressionModel', 'agent.strategy.overBudgetGraceRatio',
      'agent.strategy.kvUnified.policy.budgetLowRatio', 'modules.subagents.defaultMaxTokens', 'modules.retrieval.model']) expect(paths).toContain(p);
    expect(tokens.length + models.length + ratios.length).toBeGreaterThan(30);
  });

  test('every *Tokens field refuses a negative and a fraction, but those the host gives a meaning', () => {
    const loose = tokens.filter(ruled).filter((f) => !refuses(f.field, -1) || !refuses(f.field, 1.5)).map((f) => f.path);
    expect(loose).toEqual([]);
  });

  test('every model / *Model field refuses a blank string, but those the host gives a meaning', () => {
    const loose = models.filter(ruled).filter((f) => !refuses(f.field, '   ')).map((f) => f.path);
    expect(loose).toEqual([]);
  });

  test('every *Ratio field refuses a negative, but those the host gives a meaning', () => {
    const loose = ratios.filter(ruled).filter((f) => !refuses(f.field, -1)).map((f) => f.path);
    expect(loose).toEqual([]);
  });

  test('each field listed by design exists and still takes the value it is listed for', () => {
    const all = new Map(fields.map((f) => [f.path, f.field]));
    const stale = Object.keys(BY_DESIGN).filter((path) => !all.has(path));
    expect(stale).toEqual([]);
    const tightened = Object.entries(BY_DESIGN).filter(([path, { takes }]) => refuses(all.get(path)!, takes)).map(([path]) => path);
    expect(tightened).toEqual([]);
  });

  test('the counts keep 0: a strategy count of zero loads, as it did', () => {
    const r: any = base();
    for (const k of ['compressionMaxTokens', 'l1BudgetTokens', 'summaryTargetTokens', 'maxMessageTokens', 'kvStableReachTokens']) r.agent.strategy[k] = 0;
    r.agent.contextBudgetTokens = null;
    expect(() => validateRecipe(r)).not.toThrow();
  });

  test('the values the issues named are refused at load, each naming its own path', () => {
    const cases: Array<[string[], unknown, string]> = [
      [['agent', 'strategy', 'compressionModel'], '   ', 'Recipe agent.strategy.compressionModel must be a non-empty string with a character that isn\'t a space'],
      [['agent', 'strategy', 'compressionModel'], '', 'Recipe agent.strategy.compressionModel must be a non-empty string'],
      [['agent', 'strategy', 'compressionFallbackModel'], '   ', 'Recipe agent.strategy.compressionFallbackModel must be a non-empty string'],
      [['agent', 'strategy', 'compressionMaxTokens'], -1, 'Recipe agent.strategy.compressionMaxTokens must be a non-negative safe integer'],
      [['agent', 'strategy', 'l1BudgetTokens'], 1.5, 'Recipe agent.strategy.l1BudgetTokens must be a non-negative safe integer'],
      [['agent', 'strategy', 'kvStableReachTokens'], -1, 'Recipe agent.strategy.kvStableReachTokens must be a non-negative safe integer'],
      [['agent', 'strategy', 'compressionSlackRatio'], -1, 'Recipe agent.strategy.compressionSlackRatio must be a non-negative finite number'],
      [['modules', 'subagents', 'defaultMaxTokens'], -1, 'Recipe modules.subagents.defaultMaxTokens must be a non-negative safe integer'],
    ];
    for (const [path, value, said] of cases) {
      const r: any = base();
      let at = r; for (const k of path.slice(0, -1)) at = at[k] ??= {};
      at[path[path.length - 1]] = value;
      expect(() => validateRecipe(r)).toThrow(said);
    }
  });
});

function base() {
  return { name: 'probe', agent: { name: 'Mira', systemPrompt: 'sys', strategy: { type: 'autobiographical' } } };
}
