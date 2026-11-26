/**
 * The recipe's token counts, model names and ratios, by the rule their names
 * state: a `*Tokens` field refuses a negative and a fraction, a `model` or
 * `*Model` field refuses a blank string, a `*Ratio` field refuses a negative.
 * The walk finds the fields by name, so a new one declared with a bare
 * `number()` or `text()` fails here, with its path (#653, #656, #724).
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { recipeShape, validateRecipe } from '../src/recipe-schema.js';

type Found = { path: string; field: z.ZodType };

function unwrap(field: z.ZodType): z.ZodType {
  let f: z.ZodType = field;
  for (let i = 0; i < 8; i++) {
    if (f instanceof z.ZodOptional || f instanceof z.ZodNullable || f instanceof z.ZodDefault || f instanceof z.ZodReadonly) f = f.unwrap() as z.ZodType;
    else if (f instanceof z.ZodPipe) f = f.in as z.ZodType;
    else break;
  }
  return f;
}

function walk(shape: Record<string, z.ZodType>, at: string, out: Found[], seen: Set<unknown>): void {
  for (const [key, field] of Object.entries(shape)) {
    const path = at ? `${at}.${key}` : key;
    out.push({ path, field });
    const inner = unwrap(field);
    const nested: z.ZodType[] = inner instanceof z.ZodUnion ? (inner.options as z.ZodType[]) : [inner];
    for (const n of nested) {
      const u = unwrap(n);
      if (seen.has(u)) continue;
      seen.add(u);
      if (u instanceof z.ZodObject) walk(u.shape as Record<string, z.ZodType>, path, out, seen);
      else if (u instanceof z.ZodArray) { const e = unwrap(u.element as z.ZodType); if (e instanceof z.ZodObject) walk(e.shape as Record<string, z.ZodType>, `${path}[]`, out, seen); }
      else if (u instanceof z.ZodRecord) { const v = unwrap(u.valueType as z.ZodType); if (v instanceof z.ZodObject) walk(v.shape as Record<string, z.ZodType>, `${path}.*`, out, seen); }
    }
  }
}

const fields: Found[] = [];
walk(recipeShape as unknown as Record<string, z.ZodType>, '', fields, new Set());
const refuses = (field: z.ZodType, value: unknown) => !field.safeParse(value).success;
const tokens = fields.filter((f) => /Tokens$/.test(f.path.split('.').pop()!));
const models = fields.filter((f) => /(^|\.|\])model$|Model$/.test(f.path));
const ratios = fields.filter((f) => /Ratio$/.test(f.path));

describe('recipe values by the rule their names state', () => {
  test('the walk reaches the fields it is for', () => {
    expect(tokens.map((f) => f.path)).toContain('agent.maxTokens');
    expect(tokens.map((f) => f.path)).toContain('agent.strategy.headWindowTokens');
    expect(models.map((f) => f.path)).toContain('agent.strategy.compressionModel');
    expect(ratios.map((f) => f.path)).toContain('agent.strategy.overBudgetGraceRatio');
    expect(tokens.length + models.length + ratios.length).toBeGreaterThan(20);
  });

  /** Fields whose names say "count" or "ratio" but whose values the host gives a meaning past the rule, each
   *  with the test that states it (test/recipe-fit*.test.ts). Every other field of the name follows the rule. */
  const BY_DESIGN: Record<string, string> = {
    'agent.maxTokens': '"agent.maxTokens as 0: loads and runs as before"; "a fractional maxTokens still finds the first budget above it"',
    'agent.contextBudgetTokens': '"a budget no larger than maxTokens, 0 and below included, is refused" by the fit, naming the head and tail',
    'agent.strategy.headWindowTokens': '"a head of zero or less is no head"',
    'agent.strategy.recentWindowTokens': '"an own tail of zero or less is no tail"',
    'agent.strategy.overBudgetGraceRatio': '"with a negative grace, history past the windows leaves the head and tail at their sizes"',
    'agent.thinking.budgetTokens': 'aboveZero: "fractional token counts end the check"',
    'agent.maxStreamTokens': "aboveZero is the field's own rule; compared with counts, a fraction is harmless",
    'agent.model': '"" means the host\'s default model, or MODEL from the environment (recipe-fit: "a refusal names MODEL only where MODEL changes the model the recipe runs")',
    'agent.strategy.kvUnified.thinkingHalfLifeTokens': 'a decay scale (half-life), not a count',
    'agent.strategy.kvUnified.policy.continuityRecencyHalfLifeTokens': 'a decay scale (half-life), not a count',
  };
  const ruled = (f: Found) => !(f.path in BY_DESIGN);

  test('every *Tokens field refuses a negative and a fraction, but those the host gives a meaning', () => {
    const loose = tokens.filter(ruled).filter((f) => !refuses(f.field, -1) || !refuses(f.field, 1.5)).map((f) => f.path);
    expect(loose).toEqual([]);
  });

  test('the design list names fields that exist, and each still takes what it is listed for', () => {
    const all = [...tokens, ...models, ...ratios];
    const stale = Object.keys(BY_DESIGN).filter((path) => !all.some((f) => f.path === path));
    expect(stale).toEqual([]);
    const tightened = Object.keys(BY_DESIGN).filter((path) => { const f = all.find((x) => x.path === path)!; return /model$/i.test(path) ? refuses(f.field, '') : refuses(f.field, -1) && refuses(f.field, 1.5); });
    expect(tightened).toEqual([]);
  });

  test('every model / *Model field refuses a blank string', () => {
    const loose = models.filter(ruled).filter((f) => !refuses(f.field, '   ')).map((f) => f.path);
    expect(loose).toEqual([]);
  });

  test('every *Ratio field refuses a negative, but those the host gives a meaning', () => {
    const loose = ratios.filter(ruled).filter((f) => !refuses(f.field, -1)).map((f) => f.path);
    expect(loose).toEqual([]);
  });

  test('the values the issues named are refused at load, with the field named', () => {
    const base = () => ({ name: 'probe', agent: { name: 'Mira', systemPrompt: 'sys', strategy: { type: 'autobiographical' } } });
    const cases: Array<[string, string, unknown, RegExp]> = [
      ['strategy', 'compressionModel', '   ', /compressionModel/], ['strategy', 'compressionModel', '', /compressionModel/],
      ['strategy', 'compressionFallbackModel', '   ', /compressionFallbackModel/],
      ['strategy', 'compressionMaxTokens', -1, /compressionMaxTokens/], ['strategy', 'l1BudgetTokens', 1.5, /l1BudgetTokens/],
      ['strategy', 'summaryTargetTokens', 0, /summaryTargetTokens/], ['strategy', 'kvStableReachTokens', -1, /kvStableReachTokens/],
      ['strategy', 'compressionSlackRatio', -1, /compressionSlackRatio/],
      ['strategy', 'compressionModel', '', /compressionModel/],
    ];
    for (const [where, key, value, named] of cases) {
      const r: any = base(); (where === 'agent' ? r.agent : r.agent.strategy)[key] = value;
      expect(() => validateRecipe(r)).toThrow(named);
    }
    const ok: any = base(); ok.agent.strategy.kvStableReachTokens = 0; ok.agent.contextBudgetTokens = null;
    expect(() => validateRecipe(ok)).not.toThrow();
  });
});
