import { isAbsolute } from 'node:path';
import * as z from 'zod';
import { resolveClockConfig, WorkspaceModule } from '@animalabs/agent-framework';
import { ENV_REFERENCE } from './recipe-document.js';
import { shown } from './modules/shown.js';
import { noteRecipeWarning } from './recipe-warnings.js';
import { REASONING_EFFORTS } from './modules/settings-module.js';
import { DEFAULT_INSTRUCTIONS_PATH } from './modules/instructions-module.js';
import { isLoopbackOrTailnetHost } from './history-semantic.js';
import { isBuiltinStrategyType } from './extensions.js';
import { TOOL_CLASSES } from './tool-lifecycle-config.js';
import { SERVER_PRESENTATIONS } from './server-presentation.js';
import { buildWorkspaceMounts, workspaceConfig } from './workspace-mounts.js';

const takes = (phrase: string) => ({
  error: (issue: { readonly code?: string }) => (issue.code === 'unrecognized_keys' ? undefined : phrase),
});

function listed(values: readonly unknown[]): string {
  const quoted = values.map((v) => JSON.stringify(v));
  return quoted.length > 1 ? `${quoted.slice(0, -1).join(', ')} or ${quoted[quoted.length - 1]}` : quoted.join('');
}

function inProse(words: readonly string[]): string {
  return words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}` : words.join('');
}

const TIMER_MS_MAX = 2147483647;

const text = (phrase = 'a string') => z.string(takes(phrase));
const nonEmptyText = (phrase = 'a non-empty string') => z.string(takes(phrase)).min(1, takes(phrase));
const nonBlankText = (phrase = 'a non-empty string') =>
  z.string(takes(phrase)).refine((s) => s.trim() !== '', takes(phrase));
const textWhere = (phrase: string, holds: (s: string) => boolean) => z.string(takes(phrase)).refine(holds, takes(phrase));
const trueOrFalse = (phrase = 'true or false') => z.boolean(takes(phrase));
const oneOf = <const T extends readonly [string, ...string[]]>(values: T, phrase = listed(values)) =>
  z.enum(values, takes(phrase));
// JSON's 1e400 parses as Infinity, which zod's number refuses: "a number" alone would not say why.
const number = (phrase?: string) => z.number({
  error: (issue) => phrase ?? (typeof issue.input === 'number' ? 'a finite number' : 'a number'),
});
const numberWhere = (phrase: string, holds: (n: number) => boolean) =>
  z.number(takes(phrase)).refine(holds, takes(phrase));
const timerMs = (min: number) =>
  numberWhere(`a whole number of milliseconds from ${min} to ${TIMER_MS_MAX}`,
    (v) => Number.isInteger(v) && v >= min && v <= TIMER_MS_MAX);
const positiveSafeInteger = (phrase = 'a positive safe integer') =>
  numberWhere(phrase, (v) => Number.isSafeInteger(v) && v > 0);
const nonNegativeSafeInteger = (phrase = 'a non-negative safe integer') =>
  numberWhere(phrase, (v) => Number.isSafeInteger(v) && v >= 0);
const listOf = <T extends z.ZodType>(item: T, phrase: string) => z.array(item, takes(phrase));
const textList = (phrase = 'a list of strings') => listOf(text(), phrase);
const mapOf = <T extends z.ZodType>(value: T, phrase = 'an object') => z.record(z.string(), value, takes(phrase));
const anyObject = (phrase = 'an object') => mapOf(z.unknown(), phrase);
const textNumberOrBoolean = () =>
  z.union([z.string(), z.number(), z.boolean()], takes('a string, a number, true or false'));

type Exact<S extends z.core.$ZodShape> = z.output<z.ZodObject<S>>;

type Show = (subpath: string, value: unknown) => string;
type Sentence = (words: { readonly at: (subpath?: string) => string; readonly show: Show }) => string;

const pathOf = (dotted: string): PropertyKey[] =>
  (dotted === '' ? [] : dotted.split('.').map((key) => (/^\d+$/.test(key) ? Number(key) : key)));

function overlaps(a: readonly PropertyKey[], b: readonly PropertyKey[]): boolean {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (String(a[i]) !== String(b[i])) return false;
  return true;
}

const isRuleFault = (issue: { readonly code?: string; readonly params?: Record<string, unknown> }): boolean =>
  issue.code === 'custom' && typeof issue.params?.sentence === 'function';

const faultOfShape = (issue: { readonly code?: string; readonly params?: Record<string, unknown> }): boolean =>
  issue.code !== 'unrecognized_keys' && !isRuleFault(issue);

function rule<T>(reads: readonly [string, ...string[]], test: (value: T) => Sentence | readonly Sentence[] | undefined) {
  const paths = reads.map(pathOf);
  return z.superRefine<T>((value, ctx) => {
    const said = test(value);
    for (const sentence of typeof said === 'function' ? [said] : said ?? []) {
      ctx.addIssue({ code: 'custom', message: 'rule', params: { sentence, reads: paths }, input: value });
    }
  }, {
    when: (payload) => !payload.issues.some((issue) =>
      faultOfShape(issue) && paths.some((p) => overlaps(issue.path ?? [], p))),
  });
}

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j]!;
      prev[j] = Math.min(up + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length]!;
}

function nearestKey(key: string, known: readonly string[]): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const candidate of known) {
    const d = editDistance(key.toLowerCase(), candidate.toLowerCase());
    if (d < bestDistance) { bestDistance = d; best = candidate; }
  }
  return best !== null && bestDistance <= Math.max(2, Math.floor(key.length / 3)) ? best : null;
}

function unknownKeysWords(keys: readonly string[], known: readonly string[], instead: Readonly<Record<string, string>> = {}): string {
  const named = keys.map((key) => {
    const hint = Object.hasOwn(instead, key) ? instead[key] : undefined;
    const near = hint === undefined ? nearestKey(key, known) : null;
    return `${JSON.stringify(key)}${hint !== undefined ? ` (${hint})` : near ? ` (did you mean "${near}"?)` : ''}`;
  });
  return `has unknown key${keys.length > 1 ? 's' : ''} ${named.join(', ')}; it takes ${inProse(known)}`;
}

const shapeKeys = (inst: unknown): string[] => (inst instanceof z.ZodObject ? Object.keys(inst.shape) : []);

const KIND_WORDS: Readonly<Record<string, string>> = {
  string: 'a string', number: 'a number', int: 'a whole number', boolean: 'true or false',
  object: 'an object', array: 'a list', record: 'an object',
};

const words: z.core.$ZodErrorMap = (issue) => {
  if (issue.code === 'unrecognized_keys') return unknownKeysWords(issue.keys, shapeKeys(issue.inst));
  if (issue.code === 'invalid_type') return KIND_WORDS[issue.expected] ?? issue.expected;
  if (issue.code === 'invalid_value') return listed(issue.values);
  return undefined;
};

/**
 * Where the values that a load checks came from, so that its message prints
 * no value that came from the environment.
 * - `literal`: each value is the caller's own, and a message prints a string,
 *   a number, true, false or null as it is, and a list or an object by its kind.
 * - `authored`: `document` is the recipe as its author wrote it, before
 *   environment values went in. A message prints a string that names one as
 *   it is written there, such as `"prefix-${TOKEN}"`.
 * - `resolved`: a legacy snapshot, saved with its environment values in and
 *   no references. A message prints no string of it, only its kind.
 */
export type RecipeOrigin =
  | { readonly kind: 'literal' }
  | { readonly kind: 'authored'; readonly document: unknown }
  | { readonly kind: 'resolved' };

function valueAt(root: unknown, path: readonly PropertyKey[]): unknown {
  let value = root;
  for (const key of path) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Record<PropertyKey, unknown>)[key];
  }
  return value;
}

function dotted(path: readonly PropertyKey[]): string {
  return path.map((k, i) => (typeof k === 'number' ? `[${k}]` : i === 0 ? String(k) : `.${String(k)}`)).join('');
}

function printed(value: unknown, path: readonly PropertyKey[], origin: RecipeOrigin): string {
  if (value === undefined) return 'nothing';
  if (Array.isArray(value)) return value.length === 0 ? 'an empty list' : 'a list';
  if (value !== null && typeof value === 'object') return 'an object';
  if (typeof value !== 'string') return shown(value);
  if (origin.kind === 'resolved') return 'a string';
  if (origin.kind === 'authored') {
    const written = valueAt(origin.document, path);
    if (typeof written === 'string' && new RegExp(ENV_REFERENCE).test(written)) return JSON.stringify(written);
  }
  return JSON.stringify(value);
}

const refusesKind = (issues: readonly z.core.$ZodIssue[], value: unknown): boolean =>
  issues.some((issue) => issue.path.length === 0 && (issue.code === 'invalid_type'
    || (issue.code === 'invalid_value' && value !== null && typeof value === 'object')));

type Subject = (at: string) => string;
const recipeSubject: Subject = (at) => (at === '' ? 'Recipe' : `Recipe ${at}`);

function mayBeLeftOut(root: z.core.$ZodType, input: unknown, path: readonly PropertyKey[]): boolean {
  let schema = root;
  let value = input;
  let optional = false;
  for (const key of path) {
    let at = bare(schema);
    if (at instanceof z.ZodUnion) {
      const arm = armFor(at, value);
      if (arm === undefined) return false;
      at = bare(arm);
    }
    if (at instanceof z.ZodObject && typeof key === 'string' && Object.hasOwn(at.shape, key)) {
      const field: z.core.$ZodType = at.shape[key];
      schema = field;
      optional = field instanceof z.ZodOptional || field instanceof z.ZodDefault;
    } else if (at instanceof z.ZodRecord) {
      schema = at.valueType;
      optional = false;
    } else if (at instanceof z.ZodArray) {
      schema = at.element;
      optional = false;
    } else {
      return false;
    }
    value = valueAt(value, [key]);
  }
  return optional;
}

function withoutKey(value: unknown, path: readonly PropertyKey[]): unknown {
  const [key, ...rest] = path;
  if (key === undefined) return value;
  if (Array.isArray(value)) return value.map((item, i) => (i === key ? withoutKey(item, rest) : item));
  if (!isPlainObject(value) || typeof key !== 'string') return value;
  if (rest.length > 0) return { ...value, [key]: withoutKey(value[key], rest) };
  const copy = { ...value };
  delete copy[key];
  return copy;
}

const isPath = (value: unknown): value is PropertyKey[] =>
  Array.isArray(value) && value.every((key) => typeof key === 'string' || typeof key === 'number');

function pathsRulesRead(issues: readonly z.core.$ZodIssue[], base: readonly PropertyKey[]): PropertyKey[][] {
  return issues.flatMap((issue) => {
    const at = [...base, ...issue.path];
    if (issue.code === 'invalid_union') return issue.errors.flatMap((arm) => pathsRulesRead(arm, at));
    const reads: unknown = issue.code === 'custom' && isRuleFault(issue) ? issue.params?.reads : undefined;
    return Array.isArray(reads) ? reads.filter(isPath).map((read) => [...at, ...read]) : [];
  });
}

function leavingOutBreaksARule(root: z.core.$ZodType, input: unknown, paths: readonly (readonly PropertyKey[])[]): boolean {
  const result = z.safeParse(root, paths.reduce<unknown>(withoutKey, input));
  return !result.success && pathsRulesRead(result.error.issues, []).some((read) => paths.some((path) => overlaps(read, path)));
}

/**
 * The refusal's sentences. A null may be left out where its field is
 * optional, and where leaving it out together with each key offered so far
 * (`offered`, in the refusal's order) breaks no rule that reads one of
 * them, so that the offers hold together.
 */
function sentences(issues: readonly z.core.$ZodIssue[], base: readonly PropertyKey[], input: unknown, origin: RecipeOrigin, subject: Subject, root: z.core.$ZodType,
  offered: PropertyKey[][]): string[] {
  const out: string[] = [];
  for (const issue of issues) {
    const path = [...base, ...issue.path];
    const at = dotted(path);
    const name = subject(at);
    const got = () => printed(valueAt(input, path), path, origin);
    if (issue.code === 'invalid_union') {
      if (issue.errors.length > 0) {
        const meant = issue.errors.filter((arm) => !refusesKind(arm, valueAt(input, path)));
        if (meant.length === 1) { out.push(...sentences(meant[0]!, path, input, origin, subject, root, offered)); continue; }
      } else if (issue.discriminator !== undefined) {
        const options = 'options' in issue ? issue.options ?? [] : [];
        out.push(`${name} must be ${listed(options.filter((o) => o !== null && o !== undefined))}, got ${got()}.`);
        continue;
      }
    }
    if (issue.code === 'unrecognized_keys') {
      out.push(/^Recipe /.test(issue.message) ? issue.message : `${name} ${issue.message}.`);
      continue;
    }
    const sentence: unknown = issue.code === 'custom' ? issue.params?.sentence : undefined;
    if (isRuleFault(issue) && typeof sentence === 'function') {
      const sub = (subpath = '') => [...path, ...pathOf(subpath)];
      out.push((sentence as Sentence)({
        at: (subpath) => dotted(sub(subpath)),
        show: (subpath, value) => printed(value, sub(subpath), origin),
      }));
      continue;
    }
    const leaveOut = valueAt(input, path) === null && mayBeLeftOut(root, input, path) && !leavingOutBreaksARule(root, input, [...offered, path]);
    if (leaveOut) offered.push(path);
    const advice = valueAt(input, path) !== null ? '' : leaveOut ? '; give it a value, or leave the key out' : '; give it a value';
    out.push(`${name} must be ${issue.message}, got ${got()}${advice}.`);
  }
  return out;
}

function faultMessage(issues: readonly z.core.$ZodIssue[], input: unknown, origin: RecipeOrigin, root: z.core.$ZodType, subject: Subject = recipeSubject, whole = 'The recipe'): string {
  const all = [...new Set(sentences(issues, [], input, origin, subject, root, []))];
  return all.length === 1 ? all[0]! : `${whole} has ${all.length} faults:\n${all.map((s) => `- ${s}`).join('\n')}`;
}

const nonNegative = (phrase = 'a finite number of 0 or more') => numberWhere(phrase, (v) => v >= 0);
const aboveZero = (phrase = 'a finite number above 0') => numberWhere(phrase, (v) => v > 0);
const fraction = () => numberWhere('a number from 0 to 1', (v) => v >= 0 && v <= 1);

const kvUnifiedPolicyShape = {
  alpha: nonNegative(),
  budgetLowRatio: number('a finite number'),
  budgetHighRatio: number('a finite number'),
  budgetUnderLambda: nonNegative(),
  budgetOverLambda: nonNegative(),
  cacheLambda: nonNegative(),
  cacheScale: aboveZero(),
  cacheReadPrice: nonNegative(),
  cacheWritePrice: nonNegative(),
  continuityLambda: nonNegative(),
  continuityScale: aboveZero(),
  continuityRecencyHalfLifeTokens: aboveZero(),
  continuityRecencyFloor: fraction(),
  continuityStableHalfLife: aboveZero(),
  continuityStableFloor: fraction(),
  /** Age bands per doubling for fidelity and continuity ages
   * (context-manager ≥ 0.17): an integer from 0 to 64, 0 prices exact ages.
   * Optional; a strategy built from a recipe takes 4 unless set. */
  ageBandSteps: numberWhere('a whole number from 0 to 64', (v) => Number.isInteger(v) && v >= 0 && v <= 64).optional(),
  /** What rewriting the prompt costs, in points per `cacheScale` tokens
   * a layout change rewrites, linear in the rewrite (context-manager
   * ≥ 0.25.3): it takes the place of the quadratic `cacheLambda` term, so
   * the layout last sent is cheaper than any change by that change's
   * whole rewrite. Optional; absent or 0 keeps the quadratic term. */
  rewriteLambda: nonNegative().optional(),
};
const kvUnifiedPolicy: z.ZodType<Exact<typeof kvUnifiedPolicyShape>> = z.looseObject(kvUnifiedPolicyShape, takes('a complete object'))
  .check(rule<Exact<typeof kvUnifiedPolicyShape>>(['budgetLowRatio', 'budgetHighRatio'], (p) =>
    p.budgetLowRatio < 0 || p.budgetHighRatio > 1 || p.budgetLowRatio > p.budgetHighRatio
      ? () => 'Recipe kvUnified budget ratios must satisfy 0 <= low <= high <= 1.'
      : undefined));

const kvUnifiedShape = {
  policy: kvUnifiedPolicy,
  tokenBucketSize: positiveSafeInteger(),
  continuityBucketSize: positiveSafeInteger(),
  fidelityBucketSize: positiveSafeInteger(),
  labelCeiling: positiveSafeInteger(),
  adoptEpsilon: nonNegative('a finite non-negative number'),
  /** What a change of layout costs in thinking, in points per token of the
   * agent's own thinking the change would make a model that binds thinking
   * drop (context-manager ≥ 0.25.3). It is added to `adoptEpsilon` for the
   * compile, so the layout holds while recent thinking is live and moves
   * once it is gone anyway. Optional; absent or 0 prices none, and a model
   * that doesn't bind thinking is never priced. */
  thinkingLambda: nonNegative().optional(),
  /** How far back thinking still counts for `thinkingLambda`: a reply's
   * thinking weighs half as much for each this many raw tokens between it
   * and the newest message. Optional; 50,000 unless set. */
  thinkingHalfLifeTokens: aboveZero().optional(),
  treeifyNonContiguousSummaries: trueOrFalse('an explicit boolean'),
  /** Preserve summaries spanning gaps instead of treeifying them. Mutually exclusive
   * with treeifyNonContiguousSummaries; both flags must be explicit. */
  preserveGapBearingSummaries: trueOrFalse('an explicit boolean'),
  /** Skip the full Pareto pass when the previously accepted layout is provably
   * still selected (context-manager ≥ 0.14). Optional; from context-manager
   * 0.15 a strategy built from a recipe takes it on unless set to `false`. */
  hysteresisCertificate: trueOrFalse().optional(),
  /** Which engine solves the forest (context-manager ≥ 0.17): `auto` (absent)
   * runs the subtree engine and falls back to the packed DAG engine past the
   * label ceiling; `subtree` and `dag` pin one. */
  engine: oneOf(['auto', 'subtree', 'dag']).optional(),
  /** How producible merges are measured against the live cut
   * (context-manager ≥ 0.17): `joint` unless set to `individual`. */
  latentDemandMode: oneOf(['individual', 'joint']).optional(),
};
const kvUnified: z.ZodType<Exact<typeof kvUnifiedShape>> = z.looseObject(kvUnifiedShape, takes('a complete object (omit it for the standard block)'))
  .check(rule<Exact<typeof kvUnifiedShape>>(['treeifyNonContiguousSummaries', 'preserveGapBearingSummaries'], (k) =>
    k.treeifyNonContiguousSummaries && k.preserveGapBearingSummaries
      ? ({ at }) => `Recipe ${at('treeifyNonContiguousSummaries')} and preserveGapBearingSummaries are mutually exclusive.`
      : undefined));

const toolProseFallback = z.strictObject({
  intoTool: nonEmptyText(),
  fromTools: listOf(nonEmptyText('a tool name'), 'a non-empty list of tool names')
    .min(1, takes('a non-empty list of tool names')),
  field: nonEmptyText().optional(),
  result: nonEmptyText().optional(),
  minChars: nonNegativeSafeInteger().optional(),
}, takes('an object { intoTool, fromTools, field?, result?, minChars? }'))
  .check(rule<{ intoTool: string; fromTools: string[] }>(['intoTool', 'fromTools'], (h) =>
    h.fromTools.includes(h.intoTool) ? ({ at }) => `Recipe ${at('fromTools')} must not contain intoTool.` : undefined));

const strategyShape = {
  /** Built-in strategy name, or a custom type registered by a
   *  `kind: "strategy"` extension (see `Recipe.extensions`). */
  type: nonEmptyText('"autobiographical", "passthrough", "frontdesk" or a custom type').nullable().optional(),
  headWindowTokens: number().optional(),
  /** Verbatim tail. When unset, 40% of the compile budget (120k of a 300k
   *  budget), or 40% of the budget less agent.maxTokens where the head and
   *  that tail wouldn't fit beside agent.maxTokens with overBudgetGraceRatio's
   *  grace. */
  recentWindowTokens: number().optional(),
  compressionModel: text().optional(),
  /** Cap compression `max_tokens` at the compression model's OUTPUT ceiling.
   *  Required for pre-4.x models (Claude 3 Opus caps at 4096) — without it the
   *  summarizer's 16k floor is rejected and the agent never folds. */
  compressionMaxTokens: number().optional(),
  /**
   * Opt-in compatibility for a non-reasoning model that authors the complete
   * compression result inside one closed literal `<thinking>…</thinking>`
   * text wrapper. Recovers only that exact whole-response shape as prose.
   */
  recoverLiteralThinkingWrappedCompression: trueOrFalse().optional(),
  maxMessageTokens: number().optional(),
  /** Maximum live image count, newest-first (default 6). Zero means up to
   * context-manager's image ceiling, 500, and a larger value is held to it. */
  maxLiveImages: nonNegativeSafeInteger().optional(),
  /** Token depth from the tail beyond which images become placeholders (default 30000).
   * Zero disables depth-based stripping; surrounding text stays verbatim. */
  imageStripDepthTokens: nonNegativeSafeInteger().optional(),
  /** Cumulative base64 byte budget for live images (default 20 MiB).
   * Zero means up to context-manager's byte ceiling, 24 MiB, and a larger
   * value is held to it. Count and depth limits still apply. */
  maxLiveImageBytes: nonNegativeSafeInteger().optional(),
  overBudgetGraceRatio: number().optional(),
  enforceBudget: trueOrFalse().optional(),
  maxSpeculativeL1s: number().optional(),
  /** Number of coverage-equivalent recall curves to try after the canonical
   * autobiographical compression request is explicitly refused. Zero disables
   * fallback while retaining the canonical attempt. */
  compressionRefusalCurveFallbacks: nonNegativeSafeInteger().optional(),
  /** Complete provider-request admission ceiling for compression fallbacks,
   * including the output reserve. */
  compressionContextBudgetTokens: positiveSafeInteger().optional(),
  /** Residence-scoped direct source-only L1 compression: the summarizer sees
   * only the compression marker + exact target chunk + directive (no head,
   * recall, or non-target raw recent material). One call, not a refusal
   * ladder. Source-preserving; L1 only. Default off. */
  compressionSourceOnly: trueOrFalse().optional(),
  /** Preserve canonical + recall variants, then issue one source-only L1 request last. */
  compressionSourceOnlyFallback: trueOrFalse().optional(),
  /** Legacy first-choice target-only merge request. */
  compressionMergeSourceOnly: trueOrFalse().optional(),
  /** Preserve ordinary merge retries, then use target-only on the final attempt. */
  compressionMergeSourceOnlyFallback: trueOrFalse().optional(),
  /**
   * Context Manager tool-prose hoist rung (default off). On an L1 refusal, retry
   * with long `fromTools` string arguments (e.g. a diary kept in
   * `skip_reply.reason`) moved into calls to `intoTool` — a note-taking tool the
   * agent really has (agent-framework `journal`). Skipped when `intoTool` is not
   * among the declared tools.
   */
  compressionToolProseFallback: toolProseFallback.optional(),
  /** Context Manager split-stitch L1 fallback rung (default off). */
  compressionSplitFallback: trueOrFalse().optional(),
  /** Allow a single-message placeholder inside a split-stitched L1 (default off). */
  compressionSplitPlaceholder: trueOrFalse().optional(),
  /**
   * Context Manager: carry a summary no merge can take up a level, unchanged
   * and with no model call, until it stands beside summaries of its level and
   * the ordinary merge takes it (default off). A carried entry is never
   * rendered, so a compile does not change at a carry.
   */
  carryStrandedSummaries: trueOrFalse().optional(),
  /** Split-stitch: max sub-calls per chunk (default 40). */
  compressionSplitMaxCallsPerChunk: positiveSafeInteger().optional(),
  /** Split-stitch: max sub-calls per strategy instance per 10-minute in-memory window (default 80). */
  compressionSplitMaxCallsPer10Min: positiveSafeInteger().optional(),
  /**
   * Context Manager fallback-model rung (default unset). Once
   * `compressionModel` has refused a compression or a merge on every rung
   * that keeps it writing the memory in full, the canonical request goes once
   * more to this model, before the split rung and before quarantine. The
   * model is reached through the agent's own provider.
   */
  compressionFallbackModel: nonEmptyText().optional(),
  /** Token budget for prior recall-pair context in compression/merge
   * requests (Context Manager `compressionRecallBudgetTokens`). */
  compressionRecallBudgetTokens: positiveSafeInteger().optional(),
  positionedRecallPairs: trueOrFalse().optional(),
  recallHeaderTemplate: text().optional(),
  /**
   * Where a summary's signed reasoning carriers (the compressor's own
   * thinking blocks, `responseContent`) are replayed. `'full'` (default):
   * unchanged — carriers ride both the live window and mint/merge recall
   * pairs. `'live-strip'`: carriers are omitted from the LIVE window only
   * (whole blocks dropped, never mutated — signatures only verify
   * byte-identical) — the agent's own compiled context renders recall
   * pairs text-only, while compression/merge requests still carry the full
   * signed content unconditionally (measured load-bearing there: some
   * providers refuse a compress request without it). Useful when a
   * provider's classifier treats a replayed foreign-request signature
   * inside the LIVE window as reasoning extraction.
   */
  carrierPolicy: oneOf(['full', 'live-strip']).optional(),
  targetChunkTokens: number().optional(),
  mergeThreshold: number().optional(),
  mergeMaxSourceSpanMessages: number().optional(),
  summaryTargetTokens: number().optional(),
  /** Standing production target: keep the summary forest deep enough to fit
   *  this budget, enabling a later live-budget descent with no fold-storm and
   *  a single KV invalidation (see context-manager productionBudgetTokens). */
  productionBudgetTokens: number().optional(),
  l1BudgetTokens: number().optional(),
  l2BudgetTokens: number().optional(),
  l3BudgetTokens: number().optional(),
  toolResultMaxLastN: z.union([number(), mapOf(number(), 'a number')],
    takes('a number, or an object from tool names to numbers')).optional(),
  toolUseInputMaxTokens: number().optional(),
  /** Adaptive resolution (document-based gradual compression). For the
   *  'autobiographical' strategy type this defaults ON; set
   *  `adaptiveResolution: false` to opt back to the count-based
   *  hierarchical renderer. The remaining knobs only apply when
   *  adaptiveResolution is true. */
  adaptiveResolution: trueOrFalse().optional(),
  /** kv-stable: trust region P on per-turn perturbation (tokens re-read).
   *  See context-manager adaptive-resolution-design.md §13. */
  kvStableReachTokens: number().optional(),
  /** kv-stable: quality-gap override threshold (§13.4). Default 0.35. */
  kvStableQualityGapRatio: number().optional(),
  compressionSlackRatio: number().optional(),
  /** Adaptive-resolution fold planner. An omitted value is 'kv-unified', the
   *  cost-aware solver (see buildFrameworkStrategy). A resident whose store
   *  was built under 'kv-stable' pins it here. 'flat-profile' /
   *  'oldest-first' are the legacy planners. */
  foldingStrategy: oneOf(['flat-profile', 'oldest-first', 'kv-stable', 'kv-unified']).optional(),
  /** Policy for the kv-unified solver. Omitted, the host supplies its standard
   * block (standardKvUnifiedConfig), with cache prices matched to the
   * provider, cacheTtl and model. Written out, it must be complete: there is
   * no per-field merging, so a load refuses a block that lacks a required
   * field, and, under a built-in strategy type, warns of a key that it
   * doesn't know. */
  kvUnified: kvUnified.optional(),
  speculativeProduction: trueOrFalse().optional(),
  /** L1 production holdback: keep the newest N closed chunks out of the
   *  speculative compression queue (default 1); demand still overrides. */
  l1HoldbackChunks: number().optional(),
  /** Self-voice / compression framing. The host defaults summaryParticipant to
   *  the agent's name (`agent.name`, or the name it runs under when that's
   *  unset), so self-recollections speak as the agent itself. Set
   *  explicitly only to voice summaries as someone else — a mismatched
   *  participant surfaces in the compiled prompt as another voice speaking in
   *  first person about the agent. */
  summaryParticipant: text().optional(),
  summarySystemPrompt: text().optional(),
  summaryUserPrompt: text().optional(),
  /** The `Context Manager` turn before a summary in the compiled context,
   *  under adaptive resolution (the default) or `positionedRecallPairs:
   *  false`. The host sets no default: left out, context-manager's own
   *  wording applies (see buildFrameworkStrategy). */
  summaryContextLabel: text().optional(),
  /** As-of perspective pin: chunks wholly below this message sequence are
   *  compressed as inherited/witnessed record, not first-person memory.
   *  For residents continued from a shared log they joined partway through. */
  witnessedBeforeSequence: number().optional(),
  /** Override wording for the witnessed-record instruction ({targetTokens}
   *  substituted). */
  witnessedInstruction: text().optional(),
  /** Identity reminder appended to every compression/merge instruction.
   *  For agents in multi-resident channels (and older models especially):
   *  names the agent and directs attribution so pure-witness chunks don't
   *  flip the summarizer into another speaker's identity. */
  identityReminder: text().optional(),
  /** Reminder for WHOLLY inherited targets (L1 chunks entirely before
   *  witnessedBeforeSequence; merges of all-witnessed sources). Lived and
   *  mixed targets keep identityReminder (context-manager
   *  witnessedIdentityReminder). */
  witnessedIdentityReminder: text().optional(),
};
type StrategyShape = Exact<typeof strategyShape>;

function kvUnifiedSelected(s: StrategyShape): boolean {
  const type = s.type ?? 'autobiographical';
  return s.foldingStrategy === 'kv-unified' || (
    s.foldingStrategy === undefined && s.adaptiveResolution !== false && (type === 'autobiographical' || type === 'frontdesk'));
}

const strategy: z.ZodType<StrategyShape> = z.looseObject(strategyShape, takes('an object'))
  .check(
    rule<StrategyShape>(['type', 'foldingStrategy'], (s) =>
      s.foldingStrategy === 'kv-unified' && s.type === 'passthrough'
        ? () => 'Recipe foldingStrategy "kv-unified" requires an autobiographical or frontdesk strategy.'
        : undefined),
    rule<StrategyShape>(['type', 'foldingStrategy', 'adaptiveResolution', 'kvUnified'], (s) =>
      s.kvUnified !== undefined && !kvUnifiedSelected(s)
        ? ({ at }) => `Recipe ${at('kvUnified')} requires foldingStrategy "kv-unified".`
        : undefined),
  );

const retryKeysShape = {
  maxRetries: nonNegative('a non-negative number').optional(),
  retryDelayMs: nonNegative('a non-negative number').optional(),
  backoffMultiplier: nonNegative('a non-negative number').optional(),
  maxRetryDelayMs: nonNegative('a non-negative number').optional(),
};
const retry = z.strictObject({
  ...retryKeysShape,
  overloaded: z.strictObject(retryKeysShape, takes('an object')).optional(),
}, takes('an object'));

const clock = z.strictObject({
  intervalMinutes: number('a positive whole number').optional(),
  intervalSeconds: number('a positive whole number').optional(),
  precision: oneOf(['minutes', 'seconds']).optional(),
}, takes('an object'))
  .check(rule<object>(['intervalMinutes', 'intervalSeconds', 'precision'], (c) => {
    try {
      resolveClockConfig('recipe', c);
      return undefined;
    } catch (err) {
      const said = (err instanceof Error ? err.message : String(err)).replace('Agent "recipe" clock', 'Recipe agent.clock');
      return () => said;
    }
  }));

/** `agent.autoContinue` as an object: agent-framework's `AutoContinueConfig`. */
export type RecipeAutoContinue = z.output<typeof autoContinue>;
const autoContinue = z.strictObject({
  /** Continuations in a row before the agent waits for the next event: a
   *  whole number, 1 to 20. Default 3. */
  maxConsecutive: numberWhere('a whole number from 1 to 20', (v) => Number.isInteger(v) && v >= 1 && v <= 20).optional(),
}, takes('an object'));

const cacheKeepaliveShape = {
  /** Default true (anthropic provider only). */
  enabled: trueOrFalse().optional(),
  /** Stop refreshing this long after the last REAL request. Default 24. */
  maxIdleHours: aboveZero('a positive number (finite)').optional(),
  /** Refresh once untouched this long. Must be < 60 with a 1h TTL. Default 45. */
  refreshAfterMinutes: aboveZero('a positive number').optional(),
};
const cacheKeepalive: z.ZodType<Exact<typeof cacheKeepaliveShape>> = z.looseObject(cacheKeepaliveShape, takes('an object'));

const thinkingShape = {
  enabled: trueOrFalse(),
  budgetTokens: aboveZero('a positive number (finite)').optional(),
  /** 'enabled' (explicit budget, legacy) or 'adaptive' (model-managed;
   * required by opus-4-7+ / fable-5 era models). */
  type: oneOf(['enabled', 'adaptive']).optional(),
  /** 'summarized' returns readable reasoning summaries in `thinking`;
   * 'omitted' returns empty text + signature only. Models 4.7+ default
   * to 'omitted' server-side. Through the Anthropic adapter, with
   * reasoning_enabled on, a config carrying agent_settings'
   * reasoning_display goes in place of this block's whole thinking
   * config, binding controls included, on a model that takes adaptive
   * thinking; on a streamed call to a model the host sends the drop
   * control to, the control is then added to that config
   * (LoggingAnthropicAdapter.withBinding). On a streamed call through it to a model
   * modelReturnsNotesInThinking lists, a request that would go with
   * display 'omitted', or with no thinking config, goes with 'updates'
   * instead, so the notes between tool calls come back as text
   * (LoggingAnthropicAdapter.withProgressNotes). So there, with
   * reasoning_enabled off, a 'summarized' goes as 'updates' too wherever
   * membrane builds no config from this block, as for a display alone on
   * Fable and Mythos. */
  display: oneOf(['summarized', 'omitted']).optional(),
  /** Anthropic streaming effort baseline, independent of enabled. Explicit agent
   * settings override it until reset, from the point where they were set;
   * compression calls are unaffected. Other providers ignore this field;
   * OpenAI uses responses.reasoningEffort. */
  effort: oneOf(REASONING_EFFORTS).optional(),
};
const thinking: z.ZodType<Exact<typeof thinkingShape>> = z.looseObject(thinkingShape, takes('an object with "enabled" and optional "budgetTokens"'));

const responsesShape = {
  reasoningEffort: oneOf(['none', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
  reasoningContext: oneOf(['current_turn', 'all_turns']).optional(),
  compactThreshold: aboveZero('a positive number (finite)').optional(),
  /** OpenAI Responses API processing tier. `priority` is the API-key
   * equivalent of Codex fast mode. */
  serviceTier: oneOf(['auto', 'default', 'flex', 'priority']).optional(),
};
const responses: z.ZodType<Exact<typeof responsesShape>> = z.looseObject(responsesShape, takes('an object'));

const codexShape = { fastMode: trueOrFalse().optional() };
const codex: z.ZodType<Exact<typeof codexShape>> = z.looseObject(codexShape, takes('an object'));

const mockShape = {
  /** Echo the last user message (`[Echo] …`). Default true in this host. */
  echoMode: trueOrFalse().optional(),
  /** Reply when not echoing and the queue is empty. */
  defaultResponse: nonBlankText().optional(),
  /** Delay before a non-streamed `complete()` reply, in ms (membrane
   *  default 10). Agent turns stream; compression and session naming don't. */
  completeDelayMs: nonNegative('a non-negative finite number (milliseconds)').optional(),
  /** Delay between streamed chunks, in ms (membrane default 5). There is no
   *  delay before the first chunk: a streamed reply of `L` characters takes
   *  about `(ceil(L / streamChunkSize) - 1) * streamChunkDelayMs`. */
  streamChunkDelayMs: nonNegative('a non-negative finite number (milliseconds)').optional(),
  /** Characters per streamed chunk; a positive integer (membrane default 10). */
  streamChunkSize: positiveSafeInteger('a positive integer (characters per chunk)').optional(),
  /** Replies returned in order, one per provider call, before falling back
   *  to the echo / `defaultResponse`. Every call through the adapter takes
   *  one, auxiliary calls (compression, session naming) included. */
  responseQueue: listOf(nonBlankText(), 'a list of non-empty strings').optional(),
};
/**
 * Settings for membrane's MockAdapter (`agent.provider: "mock"`). The default
 * (no block) echoes the last user message back — the most informative shape
 * for interactive smoke runs, since you can see your own words complete the
 * loop. `echoMode: false` returns `defaultResponse` instead, which gives
 * deterministic output for scripted tests. The timing knobs and the queue let
 * a run reproduce delay-sensitive behavior (event coalescing during a slow
 * turn, say) offline.
 *
 * Each reply is chosen in this order: the next `responseQueue` entry, then
 * the echo, then `defaultResponse`. Unset numbers keep membrane's defaults.
 */
export type RecipeMockConfig = z.output<typeof mock>;
const mock: z.ZodType<Exact<typeof mockShape>> = z.looseObject(mockShape, takes('an object'));

const refusalHandlingShape = {
  retries: number().optional(),
  autoRewind: trueOrFalse().nullable().optional(),
  maxRewinds: number().optional(),
  /**
   * @deprecated No agent-framework release reads it, so on any release it
   * changes nothing. A recipe that still sets it loads as before.
   */
  announceHumanTurns: trueOrFalse().optional(),
};
const refusalHandlingObject: z.ZodType<Exact<typeof refusalHandlingShape>> = z.looseObject(refusalHandlingShape, takes('an object'))
  .check(rule<object>(['primarySummaryFallback'], (r) =>
    Object.hasOwn(r, 'primarySummaryFallback')
      ? ({ at }) => `Recipe ${at('primarySummaryFallback')} was removed and is unsupported.`
      : undefined));

const absolutePath = (phrase = 'an absolute path') => textWhere(phrase, (s) => isAbsolute(s));
const CATALOGUE_PATH = /^[^/]+\/[^/]+(?:\/[^/]+)*$/;

const toolPresentation = z.strictObject({
  path: absolutePath(),
  cataloguePath: textWhere('a path in a workspace mount, such as "mount/catalogue.json", with no "." or ".." part',
    (s) => CATALOGUE_PATH.test(s) && !s.split('/').some((p) => p === '.' || p === '..')),
  defaults: listOf(z.strictObject({ source: nonBlankText(), path: absolutePath() }, takes('an object { source, path }')),
    'a list of { source, path } objects').optional(),
}, takes('an object { path, cataloguePath, defaults? }'))
  .check(rule<{ defaults?: { source: string }[] }>(['defaults'], (tp) =>
    tp.defaults !== undefined && new Set(tp.defaults.map((d) => d.source)).size !== tp.defaults.length
      ? ({ at }) => `Recipe ${at('defaults')} require unique component sources.`
      : undefined));

const PROVIDERS = ['anthropic', 'openai-responses', 'openai-codex', 'openrouter', 'bedrock', 'openai-compatible', 'mock'] as const;

function httpUrl(text: string): boolean {
  try {
    const { protocol } = new URL(text);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function validTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

const agentShape = {
  /** Opt-in presentation; absolute local JSON path and reserved generated workspace path. */
  toolPresentation: toolPresentation.optional(),
  name: text().optional(),
  model: text().optional(),
  /** IANA zone used when rendering wall-clock times to the agent. */
  timezone: textWhere('an IANA time zone, such as "Europe/Berlin"', (s) => s.trim() !== '' && validTimeZone(s)).optional(),
  /** Provider transport. Omitted preserves the historical Anthropic default.
   * 'mock' wires membrane's MockAdapter — canned/echo responses, no API key,
   * no provider spend; for exercising the full host loop offline. */
  provider: oneOf(PROVIDERS).optional(),
  /**
   * Base URL of an OpenAI-compatible chat-completions endpoint, e.g.
   * `http://localhost:11434/v1` (Ollama), a vLLM server, Together, Groq,
   * NanoGPT... Required with `provider: 'openai-compatible'`, rejected with
   * any other provider (those have their own `*_BASE_URL` env overrides).
   * The API key comes from `OPENAI_COMPATIBLE_API_KEY` only — deliberately no
   * `OPENAI_API_KEY` fallback, since `baseUrl` is recipe-controlled and a real
   * OpenAI credential must never travel silently to an arbitrary endpoint.
   * Local servers may need none. `agent.model` is required
   * too — there is no sensible default model for an arbitrary endpoint.
   */
  baseUrl: textWhere('an absolute http(s) URL', httpUrl).optional(),
  /** Message formatter. 'native' (default) = structured user/assistant turns.
   * 'anthropic-xml' = classic prefill format ("participant: text" runs, XML
   * tools) — for migrating prefill-era bots (chapterx borgs) with their exact
   * prompting structure intact. */
  formatter: oneOf(['native', 'anthropic-xml']).optional(),
  /**
   * Retry settings for framework turns AND other provider calls (compression
   * and merging, retrieval, session naming and the TUI status line).
   * A non-empty object installs a framework-wide DefaultErrorPolicy, completing
   * partial fields from the framework's turn defaults;
   * absent or {} leaves the turn policy untouched. It covers the resident,
   * forks and subagents in that instance; separate fleet hosts use their own
   * recipes. maxRetries counts total sends including the first: 4 means 4
   * sends / 3 waits for ordinary retryable failures. Rate limits get at least
   * 5 sends per policy cycle. Turn policies keep 13 overloaded sends per cycle
   * unless overloaded.maxRetries is specified, with equal-jitter backoff,
   * at-least-10-minute stated-wait ceilings
   * for subagents, and one fresh call after a deadline cut;
   * overloaded.maxRetries:0 uses the base schedule instead. Other calls keep
   * hostMembraneRetry's existing default
   * (overloaded schedule off), with recipe overrides. See RetryConfigInput.
   */
  retry: retry.optional(),
  /** Prefill scaffold user message appended after the conversation (e.g.
   * chapterx CLI-sim's "<cmd>cat untitled.txt</cmd>"). Prefill formatter only. */
  prefillUserMessage: text().optional(),
  systemPrompt: text().nullish().transform((prompt) => prompt ?? ''),
  /** Agent Framework exact-name tool allowlist. Omitted preserves its 'all' default.
   * This configures tool visibility; dispatch enforcement belongs to the framework. */
  allowedTools: z.union([z.literal('all', takes('"all" or a list of tool names')), textList()],
    takes('"all" or a list of tool names')).optional(),
  /** The reply's max_tokens; 16,384 when unset. On a model the host knows a
   *  window for (on Anthropic's API, recipe-fit.ts), a load that resolves
   *  the system prompt refuses one over the model's maximum output. */
  maxTokens: number().optional(),
  /**
   * Per-agent stream token budget — the accumulated-input ceiling at which the
   * framework breaks the stream and lets the strategy compress. Mirrors the
   * runtime `/budget` command. When unset: contextBudgetTokens + 20k if the
   * budget is left out too; else 150k, a null budget included. It counts the provider's input tokens,
   * which with prompt caching on are only those after the last cache marker.
   * On a model whose thinking binds and whose window the host passes, through
   * the Anthropic API (`thinkingBindingSettings` in framework-agent-config.ts
   * says which, from `modelThinking`), the framework doesn't break a turn's
   * stream at it; the window still does.
   */
  maxStreamTokens: aboveZero('a positive number (finite)').optional(),
  /** Per-agent context compile budget (input tokens), which holds
   *  maxTokens for the reply. When unset: on a model the host knows a window
   *  for (on Anthropic's API, recipe-fit.ts), with a maxTokens that is unset
   *  or a positive number, the smaller of 300k and the window less the system
   *  prompt and 32k for the tools; otherwise 300k. Where the host knows the
   *  window and maxTokens is unset or a positive number, a load that
   *  resolves the system prompt refuses a budget that
   *  leaves too little room for the head and the verbatim tail once
   *  maxTokens is kept for the reply, or one whose prompt (the budget less
   *  maxTokens, or the head and tail where they come to more, plus the
   *  system prompt) is over the window. */
  contextBudgetTokens: number().nullable().optional(),
  /** Prompt-cache TTL ('5m' | '1h') forwarded to the provider. Defaults to
   *  '1h'; set '5m' explicitly for high-frequency, sub-5-minute workloads.
   *  Not forwarded on bedrock — that transport only has the default 5m
   *  cache and rejects the ttl field. */
  cacheTtl: oneOf(['5m', '1h']).default('1h'),
  /**
   * Prompt-cache keepalive. With `cacheTtl: '1h'`, an idle agent's cached
   * prefix expires after an hour and its next wake pays a 2x cache write
   * over the whole context. Reading an entry refreshes its TTL at the
   * cache-read price (0.1x for most models), so a periodic `max_tokens: 0`
   * replay holds it warm for pennies.
   *
   * On by default for the anthropic provider (ignored elsewhere — bedrock
   * has no 1h cache).
   *
   * Cost is proportional to actual idleness, not to `maxIdleHours` — a busy
   * agent never fires one, because its own traffic already refreshes the TTL.
   */
  cacheKeepalive: cacheKeepalive.optional(),
  /**
   * Explicit prompt-caching override. Unset means provider-appropriate
   * default: on for everything except bedrock models that predate caching
   * support there (see bedrockModelSupportsPromptCaching). Set false if a
   * transport/account rejects cache_control markers — AWS's "your request
   * did not allow prompt caching" can also be account/region-dependent.
   */
  promptCaching: trueOrFalse().optional(),
  /**
   * Same-round routing policy for ordinary text emitted beside think().
   * Omitted preserves the compatibility carry-forward in Agent Framework.
   */
  sameRoundThinkTextPolicy: oneOf(['public', 'private']).optional(),
  /**
   * What becomes of ordinary text that a `skip_reply` would leave unsent.
   * Omitted or 'private': it stays private and isn't held. 'ask': it is held
   * as a draft. With native tools, where some of it would have been posted
   * or bounced without the `skip_reply`, the turn's first such `skip_reply`
   * is refused once with a result that names the drafts and asks where they
   * should go. With the XML formatter, nothing is refused, and the text is
   * held when the turn ends. Nothing is held while proseRouting is
   * 'disabled'. The agent can change its own with `agent_settings`.
   */
  sameRoundSkipReplyTextPolicy: oneOf(['private', 'ask']).optional(),
  /**
   * Prose delivery mode (agent-framework docs/explicit-prose-routing.md).
   * 'explicit' = model prefixes plain text with `>>destination`; unprefixed
   * prose bounces to a clipboard instead of auto-routing.
   * 'hybrid' = unprefixed prose keeps the current locus while an exact leading
   * `>>>destination` envelope routes through the authorized channel registry.
   * 'locked' = plain text goes to one destination the agent chose, on every
   * turn; only its `prose_locus` tool moves it, to a channel or to drafts
   * (agent-framework docs/locked-prose-routing.md). An `allowedTools` list
   * must name `prose_locus` for the agent to move it, and `drafts` for it to
   * resend drafts; without a `proseLock`, a list that doesn't name
   * `prose_locus` is refused. Refused beside `conversations`, whose forks
   * speak in their home channel.
   * Default 'locus'.
   */
  proseRouting: oneOf(['locus', 'explicit', 'hybrid', 'disabled', 'locked']).optional(),
  /**
   * Locked routing's destination until the agent chooses one with
   * `prose_locus`: "#channel", "@person", a channel id or "drafts". Left out,
   * plain text is held as drafts until the agent chooses. Refused under any
   * other mode, which would ignore it.
   */
  proseLock: nonBlankText('"#channel", "@person", a channel id or "drafts"').optional(),
  /** Default-off containment of whole-response prose wrappers for known tools. */
  toolWrapperProseGuard: trueOrFalse().optional(),
  /**
   * Hold a turn's start until the agent's compression call already in flight
   * ends (agent-framework `AgentConfig.primaryWaitsForAuxiliary`). Default
   * false: the turn starts beside it. For a model whose provider limits how
   * fast input tokens per minute may grow, such as Claude 3 Opus, where a
   * compression call in flight can cost the larger turn its admission. An
   * agent-framework that predates the setting always waits.
   */
  primaryWaitsForAuxiliary: trueOrFalse().optional(),
  /**
   * Whether an explicit send (send_message, channel_publish, a `drafts`
   * resend and the like) silences the plain speech its round and later
   * rounds aim where the send may have posted, holding it as drafts
   * (agent-framework `AgentConfig.sendSilencing`). Default false: plain
   * speech beside a send is posted as any other is. An agent-framework that
   * predates the setting always silences.
   */
  sendSilencing: trueOrFalse().optional(),
  /**
   * Continue until skip_reply (agent-framework `AgentConfig.autoContinue`,
   * agent-framework's docs/auto-continue.md; off when omitted): a turn the
   * model ends itself, with prose or with nothing, is followed by another
   * turn straight away, until the agent calls skip_reply (or another tool
   * that ends the turn), ends on a `>>skip_reply` / `>>>skip_reply`
   * envelope, or reaches `maxConsecutive` continuations in a row (default
   * 3, 1 to 20). Each next turn reads a short system row saying so, which
   * names skip_reply as the way to stop.
   * `true` is `{}`. An agent-framework release without it ignores it.
   */
  autoContinue: z.union([trueOrFalse(), autoContinue],
    takes('true, false, or an object such as { "maxConsecutive": 3 }')).optional(),
  /**
   * Clock rows (agent-framework `AgentConfig.clock`): every 10 minutes when
   * omitted (`DEFAULT_RECIPE_CLOCK`), `false` for none, or e.g.
   * `{ "intervalMinutes": 30 }`, or `{ "intervalSeconds": 15 }` for clocks
   * finer than a minute, with optional `"precision": "minutes" | "seconds"`.
   * When a boundary of the interval on the agent's local wall clock (in
   * `timezone`) has passed, the window takes one `Clock: 10:50 Europe/Berlin
   * (UTC+02:00)` row before the next event or turn start, or mid-turn after
   * a tool round's results (not on the `anthropic-xml` formatter's XML
   * prefill path); on some models that mid-turn row drops the loop's earlier
   * thinking, at most once an interval. Subagent streams take none; see the
   * README.
   */
  clock: z.union([z.literal(false, takes('false (no clock rows) or an object such as { "intervalMinutes": 10 }')), clock],
    takes('false (no clock rows) or an object such as { "intervalMinutes": 10 }')).optional(),
  /**
   * Extra Anthropic beta flags sent as the `anthropic-beta` header on every
   * request. Merged with any transport-required betas (OAuth). Anthropic
   * provider only.
   */
  anthropicBetas: textList().optional(),
  strategy: strategy.optional(),
  /**
   * Native extended thinking. When `enabled: true`, the agent's API requests
   * include Anthropic's thinking config and responses carry signed `thinking`
   * blocks. Required for matching the cognitive mode of claude.ai web Sonnet.
   */
  thinking: thinking.optional(),
  /** OpenAI Responses settings. Reasoning applies to both OpenAI providers;
   * the host sends compaction and serviceTier on `openai-responses` only: a
   * Codex recipe that sets them is warned at start-up
   * (responsesTransportSettingsWarning), as a recipe on any other provider
   * that sets `agent.codex.fastMode` is. */
  responses: responses.optional(),
  /** ChatGPT-subscription Codex settings. Only used with
   * `provider: "openai-codex"`. Runtime `/fast` overrides fastMode. */
  codex: codex.optional(),
  /** Mock-provider settings. Only used with `provider: "mock"`. See
   * RecipeMockConfig. */
  mock: mock.optional(),
  /**
   * Content-refusal handling. The host hands an object to agent-framework's
   * AgentConfig.refusalHandling as written, except that it leaves out a null
   * `autoRewind`, and hands false or null nothing. agent-framework documents
   * `retries`, `autoRewind` and `maxRewinds`.
   */
  refusalHandling: z.union([z.literal(false, takes('an object, such as {"autoRewind": true}, or left out')), refusalHandlingObject],
    takes('an object, such as {"autoRewind": true}, or left out')).nullable().optional(),
};
type AgentShape = Exact<typeof agentShape>;

const agent: z.ZodType<AgentShape> = z.looseObject(agentShape, takes('an object'))
  .check(
    rule<AgentShape>(['proseLock', 'proseRouting'], (a) =>
      a.proseLock !== undefined && a.proseRouting !== 'locked'
        ? ({ at, show }) => `Recipe ${at('proseLock')} requires agent.proseRouting "locked", got ${
          a.proseRouting === undefined ? 'no proseRouting (locus)' : show('proseRouting', a.proseRouting)}.`
        : undefined),
    rule<AgentShape>(['proseRouting', 'proseLock', 'allowedTools'], (a) =>
      a.proseRouting === 'locked' && a.proseLock === undefined && Array.isArray(a.allowedTools) && !a.allowedTools.includes('prose_locus')
        ? () => 'Recipe agent.proseRouting "locked" without agent.proseLock needs agent.allowedTools to name "prose_locus": ' +
          "otherwise the agent can't move its prose lock, so its plain text stays held as drafts, or where it chose before, on every turn. " +
          'Add "prose_locus" to allowedTools (and "drafts", to resend drafts), or, for an agent that hasn\'t chosen yet, set agent.proseLock ' +
          '("drafts" to hold plain text on purpose); a choice it has made stays until prose_locus moves it.'
        : undefined),
    rule<AgentShape>(['cacheKeepalive.refreshAfterMinutes', 'cacheTtl'], (a) => {
      const refresh = a.cacheKeepalive?.refreshAfterMinutes;
      const ttlMinutes = a.cacheTtl === '1h' ? 60 : 5;
      return refresh !== undefined && refresh >= ttlMinutes
        ? ({ at, show }) => `Recipe ${at('cacheKeepalive.refreshAfterMinutes')} (${refresh}) must be less than the ${
          show('cacheTtl', a.cacheTtl)} cache TTL (${ttlMinutes}m), ` +
          'or every keepalive would land after the entry expired and pay a full cache write instead of a read.'
        : undefined;
    }),
    rule<AgentShape>(['thinking', 'maxTokens'], (a) =>
      a.thinking?.enabled === true && a.thinking.budgetTokens !== undefined && a.maxTokens !== undefined
        && a.thinking.budgetTokens >= a.maxTokens
        ? ({ at }) => `Recipe ${at('thinking.budgetTokens')} (${a.thinking?.budgetTokens}) must be less than agent.maxTokens (${a.maxTokens}) ` +
          '(Anthropic requires max_tokens > thinking.budget_tokens).'
        : undefined),
    rule<AgentShape>(['provider', 'baseUrl'], (a) =>
      a.provider === 'openai-compatible' && a.baseUrl === undefined
        ? () => "Recipe agent.baseUrl is required when agent.provider is 'openai-compatible' (e.g. \"http://localhost:11434/v1\")."
        : undefined),
    rule<AgentShape>(['provider', 'model'], (a) =>
      a.provider === 'openai-compatible' && (a.model === undefined || !a.model.trim())
        ? () => "Recipe agent.model is required when agent.provider is 'openai-compatible' (no default model for an arbitrary endpoint)."
        : undefined),
    rule<AgentShape>(['provider', 'baseUrl'], (a) =>
      a.provider !== 'openai-compatible' && a.baseUrl !== undefined
        ? ({ show }) => `Recipe agent.baseUrl only applies to agent.provider 'openai-compatible' (got provider ${
          a.provider === undefined ? '"anthropic"' : show('provider', a.provider)}); ` +
          'other providers take their endpoint from ANTHROPIC_BASE_URL / OPENAI_BASE_URL / BEDROCK_BASE_URL / CODEX_BASE_URL / OPENROUTER_BASE_URL.'
        : undefined),
  );

const nonEmptyPatterns = (phrase: string) => listOf(nonEmptyText(), phrase);

/** A narrowing for one tool-lifecycle path (RFC-007 §4.3). Every stated key
 *  must hold; patterns use the RFC-007 §6.2 grammar (`*` = any run). */
export type RecipeToolLifecycleNarrowing = z.output<typeof narrowing>;
const narrowing = z.strictObject({
  /** Patterns over the model-facing tool name: `mcpl--<serverId>--<tool>`
   *  for an MCPL server's tools unless its entry sets `toolPrefix`
   *  (`mcpl--cua--*`), `<module>--<tool>` for host modules. */
  tools: nonEmptyPatterns('a list of non-empty patterns').optional(),
  /** RFC-008 classes the tool must have one of; `"default"` = computer,
   *  shell, files, web, media, body. */
  classes: z.union([
    z.literal('default', takes(`"default" or a non-empty list of: ${TOOL_CLASSES.join(', ')}`)),
    listOf(oneOf(TOOL_CLASSES), `"default" or a non-empty list of: ${TOOL_CLASSES.join(', ')}`)
      .min(1, takes(`"default" or a non-empty list of: ${TOOL_CLASSES.join(', ')}`)),
  ], takes(`"default" or a non-empty list of: ${TOOL_CLASSES.join(', ')}`)).optional(),
  /** Patterns over the conversation id (the agent name in this host). */
  conversations: nonEmptyPatterns('a list of non-empty patterns').optional(),
}, takes('a narrowing object ({} for no narrowing); omit it to leave the path denied'));

/** `mcpServers.ID.toolLifecycle`, and mcpl-servers.json's `toolLifecycle`.
 *  agent-framework reads a narrowing of the wrong shape as admitting nothing,
 *  so a malformed block would turn an intended grant off without a word. */
export const toolLifecycleSchema = z.strictObject({
  observe: narrowing.optional(),
  inputs: narrowing.optional(),
  /** Serialized-size bound for argument payloads. Framework default 16 KiB. */
  maxInputBytes: numberWhere('a positive integer', (v) => Number.isInteger(v) && v > 0).optional(),
}, takes('an object'));

const installShape = {
  run: text(),
  runtime: oneOf(['node', 'python3', 'custom', 'bun']),
};
const installObject: z.ZodType<Exact<typeof installShape>> = z.looseObject(installShape,
  takes("'npm', 'pip-editable', or { run: string, runtime: 'node' | 'python3' | 'custom' | 'bun' }"));

const inContainerShape = { path: text() };
const inContainer: z.ZodType<Exact<typeof inContainerShape>> = z.looseObject(inContainerShape, takes('an object'));

const DEBIAN_PACKAGE = /^[a-z0-9][a-z0-9+.\-]+$/;

const sourceShape = {
  /** Git URL to clone from. Mutually exclusive with `npm`. */
  url: text().optional(),
  /**
   * npm registry package spec (`pkg@version` / `@scope/pkg@version`) that
   * build tooling bakes via a global install instead of a git clone —
   * matches connectome-cook's `source.npm` grammar.  The git-form fields
   * (`ref`, `install`, `inContainer`, ...) don't apply.  Mutually
   * exclusive with `url`.
   */
  npm: text().optional(),
  /**
   * Git ref: branch, tag, or commit SHA.  Default: "main".
   * If the value starts with "refs/" (e.g. "refs/pull/3/head"), it's
   * treated as an explicit refspec — tools fetch it then check out
   * FETCH_HEAD.  Useful for tracking PR heads on GitHub/GitLab.
   */
  ref: text().optional(),
  /**
   * How to install inside the cloned dir at build time.
   *   "npm"           runs `npm install && npm run build`; implies node runtime.
   *   "pip-editable"  creates a venv at `.venv/` and runs `pip install -e .`;
   *                   implies python3 runtime.
   *   { run, runtime } runs an arbitrary shell command from the cloned dir;
   *                   `runtime` tells the tool which base packages to install
   *                   in the image (node / python3 / custom / bun = no defaults).
   * Omit entirely for sources that need no build step (e.g. the tool is
   * fetched at runtime by npx/uvx — the recipe's `command` is enough).
   */
  install: z.union([
    oneOf(['npm', 'pip-editable'], "'npm', 'pip-editable', or { run: string, runtime: 'node' | 'python3' | 'custom' | 'bun' }"),
    installObject,
  ], takes("'npm', 'pip-editable', or { run: string, runtime: 'node' | 'python3' | 'custom' | 'bun' }")).optional(),
  /**
   * Build-arg name for an auth token if the URL is private.
   * Tools consuming `source` should mount this via BuildKit secrets
   * (so the token doesn't leak into image layers).  The same env var
   * name is typically already needed at runtime by the operator's
   * `.env`, so this field doesn't introduce new secret surface.
   */
  authSecret: text().optional(),
  /**
   * True if the URL's TLS cert isn't in the container's trust store
   * (e.g. self-signed internal CAs on private GitLab/Gitea).  Tools
   * should add `-c http.sslVerify=false` to the git clone of this source.
   * Prefer installing a proper CA bundle in the image over using this flag.
   */
  sslBypass: trueOrFalse().optional(),
  /**
   * Override the in-container path of the installed source.  Default:
   * `/<basename-of-url-without-.git-suffix>` (e.g. the URL
   * `https://github.com/x/zulip_mcp.git` places the source at `/zulip_mcp`).
   */
  inContainer: inContainer.optional(),
  /**
   * Extra apt packages this source needs in the runtime image (e.g.
   * `ffmpeg`/`curl` for a tool that shells out to them).  Build tooling
   * appends these to the runtime stage's apt install; connectome-host
   * ignores the field at runtime (it doesn't build images).
   */
  systemPackages: listOf(textWhere('a Debian package name', (p) => DEBIAN_PACKAGE.test(p)), 'a list of Debian package names').optional(),
};
type SourceShape = Exact<typeof sourceShape>;
/**
 * How to obtain and install an MCP server at deploy time.  Consumed by
 * build tooling like connectome-cook.  Exactly one of `url` (git form) or
 * `npm` (registry form) must be set; tools may require more depending on
 * the install pattern they're generating.
 */
export type RecipeMcpServerSource = z.output<typeof source>;
const source: z.ZodType<SourceShape> = z.looseObject(sourceShape, takes('an object'))
  .check(rule<SourceShape>(['url', 'npm'], (s) => {
    if (s.url && s.npm) return ({ at }) => `Recipe ${at()} must not set both "url" and "npm".`;
    if (!s.url && !s.npm) return ({ at }) => `Recipe ${at()} must have a non-empty "url" (git clone) or "npm" (registry package spec) string.`;
    return undefined;
  }));

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const scopeShape = { whitelist: textList().optional(), blacklist: textList().optional() };
const scope: z.ZodType<Exact<typeof scopeShape>> = z.looseObject(scopeShape, takes('an object'));
const autofetchShape = { maxBytes: number().optional(), maxTotalBytes: number().optional() };
const autofetch: z.ZodType<Exact<typeof autofetchShape>> = z.looseObject(autofetchShape, takes('an object'));

const credentialFieldShape = {
  /** Field name as written in the file (e.g. `email`, `key`, `site`).
   *  For `ini` / `env` formats this is the literal key.  For `json` it
   *  becomes the JSON property name. */
  name: nonEmptyText(),
  /** Optional env var name that, when set in `process.env` (or supplied
   *  via cook's `--env-file`), substitutes for prompting.  Lets the
   *  operator pre-set values in CI / scripted contexts. */
  envOverride: textWhere('a valid env var name', (s) => ENV_NAME.test(s)).optional(),
  /** Operator-facing description of what to enter (one short line). */
  description: text().optional(),
  /** Placeholder shown next to the prompt (e.g. `bot@example.zulipchat.com`). */
  placeholder: text().optional(),
  /** When true, build tooling masks the input (no echo while typing).
   *  Default `false`. */
  secret: trueOrFalse().optional(),
};
const credentialField: z.ZodType<Exact<typeof credentialFieldShape>> = z.looseObject(credentialFieldShape, takes('an object'));

const credentialFileShape = {
  /** Where the runtime expects the file.  In a Docker context this also
   *  determines the bind-mount target; the host-side path is `<outDir>` +
   *  basename(path).  Relative paths resolve against the conductor's CWD
   *  (typically `/app`); absolute paths land verbatim. */
  path: nonEmptyText(),
  /** Serialization format.  `ini` writes `key=value` lines under an
   *  optional `[section]` header; `json` writes `{ "field": "value", ... }`;
   *  `env` writes `KEY=value` (no quoting). */
  format: oneOf(['ini', 'json', 'env']),
  /** Optional INI section header (`[<section>]`) preceding the fields.
   *  Ignored by `json` / `env` formats. */
  section: text().optional(),
  /** Filesystem mode as an octal string.  Default `0600` (typical for
   *  credentials).  Build tooling sets this on the host file before bind-
   *  mounting; the container inherits the mode through the mount. */
  mode: textWhere('an octal string like "0600"', (s) => /^0?[0-7]{3,4}$/.test(s)).optional(),
  /** Fields the operator must supply. */
  fields: listOf(credentialField, 'a non-empty list').min(1, takes('a non-empty list')),
};
type CredentialFileShape = Exact<typeof credentialFileShape>;
/**
 * One auxiliary credential or config file the MCP server reads at runtime.
 * Build tooling (cook, etc.) prompts the operator for the field values,
 * serializes them in the declared format, and writes the file at the
 * declared path so the bind-mounted file appears in the container.
 *
 * Example for Zulip's `.zuliprc`:
 * ```json
 * {
 *   "path": "./.zuliprc",
 *   "format": "ini",
 *   "section": "api",
 *   "mode": "0600",
 *   "fields": [
 *     { "name": "email", "envOverride": "ZULIP_EMAIL", "placeholder": "bot@example.zulipchat.com" },
 *     { "name": "key",   "envOverride": "ZULIP_KEY",   "placeholder": "abc123...", "secret": true },
 *     { "name": "site",  "envOverride": "ZULIP_SITE",  "placeholder": "https://example.zulipchat.com" }
 *   ]
 * }
 * ```
 */
export type RecipeCredentialFile = z.output<typeof credentialFile>;
const credentialFile: z.ZodType<CredentialFileShape> = z.looseObject(credentialFileShape, takes('an object'))
  .check(rule<CredentialFileShape>(['fields'], (f) => {
    const twice = f.fields.findIndex((field, i) => f.fields.findIndex((other) => other.name === field.name) !== i);
    return twice >= 0
      ? ({ at, show }) => `Recipe ${at(`fields.${twice}.name`)} ${show(`fields.${twice}.name`, f.fields[twice]!.name)} is duplicated.`
      : undefined;
  }));

const mcpServerShape = {
  /** Command to spawn (stdio transport). With a url too, `transport` says which
   *  to use. */
  command: nonEmptyText().optional(),
  args: listOf(textNumberOrBoolean(), 'a list of strings, numbers, true or false').optional(),
  env: mapOf(textNumberOrBoolean()).optional(),
  /** Opt in to the full host environment for stdio servers, including those
   * defined in mcpl-servers.json. Prefer declaring needed variables in env.
   * Requires an agent-framework version with inheritEnv support. */
  inheritEnv: trueOrFalse().optional(),
  /**
   * Per-request timeout for this server's outbound JSON-RPC (tools/call,
   * tools/list, channels/*), in milliseconds. Passed through to the
   * framework's `McplServerConfig.requestTimeoutMs`. Raise it for tools that
   * legitimately outlive the 60s default (image-generation gateways, long
   * searches); `0` disables the timeout.
   */
  requestTimeoutMs: nonNegative('a non-negative number (ms; 0 disables)').optional(),
  /** WebSocket URL (WebSocket transport). With a command too, `transport` says
   *  which to use. */
  url: nonEmptyText().optional(),
  transport: oneOf(['stdio', 'websocket', 'http']).optional(),
  /** Bearer token for WebSocket auth (appended as ?token= query param). */
  token: text().optional(),
  /**
   * Name of a host-managed access grant (archipelago audience, e.g.
   * "eidoverse"). Requires the `identity` module. The host resolves fresh
   * credentials per dial; neither the recipe nor the agent holds one.
   */
  access: text().optional(),
  /** Namespace for this server's model-facing tool names. Default
   *  `mcpl--<id>`, so tools surface as `mcpl--<id>--<tool>`. */
  toolPrefix: text().optional(),
  /**
   * Feature-set allow-list (`*` matches one dot-separated segment). Omitted:
   * every declared set is a candidate. `[]`: none (deny-all), in a recipe or
   * mcpl-servers.json alike; only the agent's own overlay file reads `[]` as
   * unset. A set whose declaration has no valid `uses` stays disabled either
   * way (MCPL §6.4, fail-closed).
   */
  enabledFeatureSets: textList().optional(),
  /** Feature-set deny-list; wins over enabledFeatureSets on overlap. */
  disabledFeatureSets: textList().optional(),
  /**
   * MCPL RFC-014: whether this host advertises `toolHints` to the
   * server, so it lists every tool with its hints (static or dynamic,
   * visible or not, which toolset) and its toolsets can be opened and
   * closed, instead of tailoring its list to a host that reads no hints.
   * Hints confer no authority. Passed through to agent-framework; omitted,
   * the framework's default applies (on, from agent-framework 0.29.0).
   */
  toolHints: trueOrFalse().optional(),
  /**
   * How agents are shown this server at first (agent-framework's host
   * toolsets): `'full'` (the default) puts its tools in the tool list;
   * `'tab'` keeps it connected, its events still arriving, with its tools
   * starting out of the list: `toolsets--open {server}` lists them for
   * `toolsets--act`, and `toolsets--open {server, full: true}` puts them back
   * in the list; `'closed-tab'` is a tab that also starts out disconnected.
   * Each agent can change how it's shown the server later, which this doesn't
   * decide. An agent without both `toolsets--open` and `toolsets--act` isn't
   * shown tabs. Passed through to agent-framework.
   */
  presentation: oneOf(SERVER_PRESENTATIONS).optional(),
  /**
   * Tool allow-list (bare tool names as the server exports them, no toolPrefix).
   * `*` is a substring wildcard (`read_*`, `*_file`, `*`).
   * If set, only matching tools are exposed to the model AND callable at dispatch.
   */
  enabledTools: nonEmptyPatterns('a list of non-empty strings').optional(),
  /**
   * Tool deny-list (same syntax as enabledTools). Wins over enabledTools on overlap.
   * Denied tools are hidden from the model and rejected at dispatch — both, so a
   * model that imitates a prior call from message history can't sneak the call through.
   */
  disabledTools: nonEmptyPatterns('a list of non-empty strings').optional(),
  reconnect: trueOrFalse().optional(),
  /** Base reconnect interval; the framework doubles it per consecutive
   *  failure (with jitter) up to reconnectMaxIntervalMs. */
  reconnectIntervalMs: number().optional(),
  /** Ceiling for the exponential reconnect backoff. Default: 5 minutes. */
  reconnectMaxIntervalMs: number().optional(),
  /**
   * @deprecated One-time migration input for legacy recipes. Runtime channel
   * desired state is Chronicle-backed and changed with channel_open/close.
   */
  channelSubscription: z.union([oneOf(['auto', 'manual'], '"auto", "manual" or a list of channel ids'), textList()],
    takes('"auto", "manual" or a list of channel ids')).optional(),
  /**
   * Optional install metadata for build/deploy tooling (e.g. connectome-cook).
   * The host doesn't read it at runtime, and the load checks its shape —
   * agents don't need this; only tools that produce deployable artifacts
   * (Docker images, etc.) do.
   */
  source: source.optional(),
  sourceMeta: z.unknown().optional(),
  /**
   * Auxiliary credential / config files this MCP server needs at runtime
   * (e.g. `.zuliprc` for the Zulip adapter, `~/.netrc` for HTTP-auth APIs,
   * a `gcloud.json` service-account key for Google APIs).  Build tooling
   * collects values from the operator (env vars or interactive prompts),
   * writes the file, and bind-mounts it into the container.  The host
   * doesn't read these files: the load checks each entry's shape, and the
   * MCP server reads the file via whatever path it expects (typically
   * declared in `env`).
   *
   * Like `source`, this is build-tooling metadata that the host doesn't
   * read at runtime.
   */
  credentialFiles: listOf(credentialFile, 'a list').optional(),
  /**
   * MCPL tool lifecycle (RFC-007) policy for this server: whether it may
   * observe the agent's OTHER tool calls (`observe`) and their requested
   * argument fields (`inputs`), each with an optional narrowing. Both are
   * denied by default; stating a block is the operator's grant. `inputs`
   * needs a `tools` or `classes` term to deliver anything, and never
   * carries `comms` or unclassed arguments.
   */
  toolLifecycle: toolLifecycleSchema.optional(),
  protocol: oneOf(['legacy', 'modern']).optional(),
  tokenTransport: oneOf(['query', 'header']).optional(),
  credentialRequired: trueOrFalse().optional(),
  allowHostCommands: trueOrFalse().optional(),
  enabledCapabilities: textList().optional(),
  disabledCapabilities: textList().optional(),
  scopes: mapOf(scope).optional(),
  autofetch: autofetch.optional(),
};
type McpServerShape = Exact<typeof mcpServerShape>;
const mcpServer: z.ZodType<McpServerShape> = z.looseObject(mcpServerShape, takes('an object'))
  .check(rule<McpServerShape>(['credentialFiles'], (s) => {
    const files = s.credentialFiles ?? [];
    const twice = files.findIndex((file, i) => files.findIndex((other) => other.path === file.path) !== i);
    return twice >= 0
      ? ({ at, show }) => `Recipe ${at(`credentialFiles.${twice}.path`)} ${show(`credentialFiles.${twice}.path`, files[twice]!.path)} is duplicated within the same server.`
      : undefined;
  }));

const givesAnotherId = (entry: Readonly<Record<string, unknown>>, name: string): boolean =>
  Object.hasOwn(entry, 'id') && entry.id !== name;
const mcpServers = mapOf(mcpServer, 'an object that gives each server a name')
  .check(rule<Readonly<Record<string, McpServerShape>>>([''], (servers) =>
    Object.keys(servers).filter((key) => givesAnotherId(servers[key]!, key)).map((name): Sentence => ({ at }) =>
      `Recipe ${at(`${name}.id`)} is not a setting: a server's id is its name in mcpServers. ` +
      'Remove id, or rename the entry if the server should have that name.')));

const bool = (phrase: string) => trueOrFalse(phrase);
const either = <T extends z.ZodType>(object: T, phrase: string) => z.union([bool(phrase), object], takes(phrase));

const subagentsShape = {
  defaultModel: text().optional(),
  defaultMaxTokens: number().optional(),
  /**
   * What a forked or spawned stream is told at its start. `'full'`
   * (default) describes the launch and the stream's place in it, and
   * gives a fork the "two parallel streams of you" framing; `'none'` hands
   * a spawn its task alone; a fork with a parent agent its task after
   * saying it is the forked stream and, where its prose routing isn't its
   * parent's (a locked parent's fork runs disabled), what that routing is;
   * and a fork with no parent agent its task after saying to return its
   * findings with subagent--return. What a stream is told is the
   * deployment's to decide, not the host's.
   */
  orientation: oneOf(['full', 'none']).optional(),
  /**
   * How far the lifecycle tools (list, stop, message, adopt, resume)
   * reach. `'subtree'` (default): a caller sees and acts on the subagents
   * it started and theirs, as `peek` is scoped; `'all'`: every subagent
   * the host knows, though an orphan is still adopted only by an agent it
   * was offered to or in whose tree it hung.
   */
  lifecycleReach: oneOf(['subtree', 'all']).optional(),
};
const subagents: z.ZodType<Exact<typeof subagentsShape>> = z.looseObject(subagentsShape, takes('an object'));

const retrievalShape = {
  model: text().optional(),
  maxInjected: number().optional(),
  /**
   * Optional OpenAI Responses/Codex reasoning effort for both retrieval calls.
   * Requires an explicit retrieval model.
   */
  reasoningEffort: oneOf(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
};
type RetrievalShape = Exact<typeof retrievalShape>;
const retrieval: z.ZodType<RetrievalShape> = z.looseObject(retrievalShape, takes('an object'))
  .check(
    rule<object>(['reasoningContext'], (r) =>
      Object.hasOwn(r, 'reasoningContext')
        ? () => 'Recipe modules.retrieval.reasoningContext is not supported: retrieval model calls ' +
          'are independent one-shot requests with no earlier reasoning items.'
        : undefined),
    rule<RetrievalShape>(['reasoningEffort', 'model'], (r) =>
      r.reasoningEffort !== undefined && (r.model === undefined || !r.model.trim())
        ? () => 'Recipe modules.retrieval.model must be a non-empty string when modules.retrieval.reasoningEffort is configured.'
        : undefined),
  );

const MAX_FETCH_MAX_BYTES = 64 * 1024 * 1024;
const fetchShape = {
  /** The model that answers `prompt`. Defaults to a Claude Haiku, so a recipe on another provider sets this. */
  model: nonBlankText().optional(),
  /**
   * Let the tool read local files too. It reads them through the workspace's
   * `read`, so it reaches what that reaches and nothing more: what the
   * mounts allow, and a file outside them where the workspace's
   * `outsideMounts` is set. It needs `modules.workspace`. Off by default. On, fetch is a reader of
   * those files in its own right: an agent whose `allowedTools` holds
   * fetch--fetch reads them with it, whether or not workspace--read is on
   * that list.
   */
  local: trueOrFalse().optional(),
  /**
   * Let web addresses reach private and local addresses: loopback, the LAN,
   * a tailnet, cloud metadata services. Off by default, so a page or a
   * redirect can't point the tool at one of those. It tells addresses apart
   * by their range alone: an internal service on a publicly routable address
   * reads as the internet does.
   */
  allowPrivateNetwork: trueOrFalse().optional(),
  /** Most bytes of one document to read. Defaults to 5 MiB, at most 64 MiB. */
  maxBytes: numberWhere(`a whole number from 1 to ${MAX_FETCH_MAX_BYTES}`,
    (v) => Number.isSafeInteger(v) && v > 0 && v <= MAX_FETCH_MAX_BYTES).optional(),
  /**
   * Let the model that answers `prompt` look at a page's images: it is given
   * a tool that fetches one the page names, under the same address guard as
   * the page, a few to a call. Off by default, since it makes requests the
   * page chooses and costs image tokens, and the model must be one that
   * takes images.
   */
  images: trueOrFalse().optional(),
};
const fetchModule: z.ZodType<Exact<typeof fetchShape>> = z.looseObject(fetchShape, takes('an object'));

/** `modules.wake.judge`, as agent-framework's `ReplyJudgeOptions` takes it. */
export type RecipeReplyJudge = z.output<typeof replyJudge>;
const replyJudge = z.strictObject({
  /** False leaves the judge unwired: `judge` rules then wake as debounces. */
  enabled: trueOrFalse().optional(),
  /** The judge's model id as this host's provider names it (e.g. an
   *  `anthropic.`/`anthropic/` prefix on Bedrock/OpenRouter). */
  model: nonEmptyText().optional(),
  /** The most input tokens one judge request may carry (4000 or more; default 90000). */
  maxInputTokens: numberWhere('a whole number of tokens, 4000 or more', (v) => Number.isInteger(v) && v >= 4000).optional(),
  /** How long a judge request may take, in ms. */
  timeoutMs: timerMs(1).optional(),
  /** What a failed judge does: wake the agent (default) or not. */
  onError: oneOf(['wake', 'skip']).optional(),
  /** The judge's effort; `none` sends none, for a provider without Anthropic's `output_config`. */
  effort: oneOf(['low', 'medium', 'high', 'none']).optional(),
  /** The prompt cache's lifetime for the judge's context document. */
  cacheTtl: oneOf(['5m', '1h']).optional(),
}, takes('an object, such as {"model": "claude-haiku-5-5"}'));

const wakeShape = {
  policies: z.unknown().optional(),
  default: z.unknown().optional(),
  /**
   * The reply judge: the small model a `judge` wake rule asks whether now is a
   * good time for the agent to reply, before it wakes the agent
   * (agent-framework's `GateOptions.judge`). Every key is optional, and
   * agent-framework's defaults apply where one is left out: Claude Haiku 5.5
   * on this host's provider, 90,000 input tokens, low effort, a 20 s timeout,
   * and a wake when the judge fails.
   */
  judge: replyJudge.optional(),
};
/** `modules.wake` as an object: starting rules, and the reply judge. */
export type RecipeWake = z.output<typeof wake>;
const wake: z.ZodType<Exact<typeof wakeShape>> = z.looseObject(wakeShape, takes('an object'));

/** `modules.heartbeat.defaults`. */
export type RecipeHeartbeatDefaults = z.output<typeof heartbeatDefaults>;
const heartbeatDefaults = z.strictObject({
  /** 60 or more. */
  intervalSeconds: numberWhere('a number of seconds, 60 or more', (v) => v >= 60).optional(),
  paused: trueOrFalse().optional(),
  message: nonEmptyText().optional(),
  deliveryMode: oneOf(['message', 'silent']).optional(),
}, takes('an object'));

/** `modules.heartbeat` as an object. */
export type RecipeHeartbeat = z.output<typeof heartbeat>;
const heartbeat = z.strictObject({
  /** The state file; relative to the install directory. Default `{dataDir}/heartbeat.json`: the
   *  install's, so every session reads the same schedule, as heartbeat-mcpl's state was. */
  statePath: nonEmptyText().optional(),
  /** The schedule a first start writes when there's nothing to import. */
  defaults: heartbeatDefaults.optional(),
  /** heartbeat-mcpl's files (its HEARTBEAT_CONFIG_FILE and HEARTBEAT_REMINDERS_FILE),
   *  read once by a start that finds no state file; relative to the install directory. */
  importFrom: z.strictObject({
    configPath: nonEmptyText().optional(),
    remindersPath: nonEmptyText().optional(),
  }, takes('an object')).optional(),
}, takes('true, false or an object, such as {"defaults": {"intervalSeconds": 14400}}'));

const MOUNT_KEY_INSTEAD: Readonly<Record<string, string>> = {
  readOnly: 'mode: "read-only" makes a mount read-only, and a mount is read-write without it',
};
const MOUNT_WAKE_OPS = ['created', 'modified', 'deleted'] as const;

const mountShape = {
  name: nonEmptyText(),
  path: nonEmptyText(),
  /**
   * Left out, the host makes a mount read-write. A direct mount
   * (`backend: 'direct'`) must say its mode; one that doesn't stops the
   * recipe loading (validateRecipe).
   */
  mode: oneOf(['read-write', 'read-only']).optional(),
  /**
   * Where the mount's tools get what they read, as agent-framework's
   * `MountConfig.backend` says (its default is 'chronicle'). 'direct' reads
   * disk's own copy as it is, keeps none of the mount's files in the store,
   * and runs no scan or watcher, so a writable one's writes have no undo. A
   * direct mount says its mode, and the framework
   * refuses one with a setting that would never act there, such as a watch
   * other than 'never', a wake on change or auto-materialize, which stops
   * the recipe loading (validateRecipe). A mount configured direct whose
   * store holds changes disk lacks, left from when it ran as 'chronicle' (a
   * draft, a deletion or a conflict), runs as 'chronicle' until a start
   * after they're settled, and the framework says at start how to settle
   * them. A direct mount that names no `ignore` passes over node_modules,
   * .git, dist, build, coverage, target, __pycache__ and .venv; one that
   * names any passes over only what it names.
   */
  backend: oneOf(['chronicle', 'direct']).optional(),
  /**
   * What the mount holds, as agent-framework's `MountConfig.include` says:
   * a non-empty list of names, `*.ext` globs and `dir/**` globs. A file the
   * list doesn't cover is refused by reads and writes and left out of
   * listings and searches, and a pattern the framework can't read stops the
   * recipe loading (validateRecipe). agent-framework keeps its own files
   * (spilled tool results, saved payloads, fetched references) only in the
   * first read-write mount with no include that isn't configured direct: a
   * recipe with no such mount keeps none of them in a file.
   */
  include: listOf(text(), 'a non-empty list of strings').min(1, takes('a non-empty list of strings')).optional(),
  watch: oneOf(['always', 'on-agent-action', 'never']).optional(),
  ignore: textList().optional(),
  /** Maximum file size in bytes (defaults to the framework's 5 MiB limit). */
  maxFileSize: numberWhere('a whole number of bytes, 1 or more', (v) => Number.isInteger(v) && v >= 1).optional(),
  /**
   * The most entries one walk of this mount takes: files, and links or other
   * entries that aren't directories (agent-framework's default, 5000, unless
   * set). A whole number from 1 to `Number.MAX_SAFE_INTEGER`, as
   * agent-framework takes it; anything else stops the recipe loading, naming
   * the mount. A sync that reaches the cap reports the rest as incomplete,
   * and the next sync of the same scope resumes after the last entry it took,
   * so repeated syncs cover a larger mount. agent-framework makes that place
   * durable with the store's next sync, so if the machine goes down before
   * then, a sync can start again from an earlier place. A watched mount's catch-up scan takes its
   * turn in the same rotation, so on a mount over the cap a change made while
   * the host was down waits for the rotation to reach it. Listings (`ls`,
   * `glob`, `grep`) and an `on-agent-action` scan take up to the cap from
   * their scope's start every time. It bounds what a walk observes, not its
   * work: directories don't count, and each one the walk visits is read
   * whole.
   */
  walkCap: numberWhere(`a whole number of entries from 1 to ${Number.MAX_SAFE_INTEGER}`,
    (v) => Number.isSafeInteger(v) && v >= 1).optional(),
  /**
   * Request inference when files in this mount change. Pair with
   * `watch: 'always'` so chokidar actually observes the mount.
   * - `true` — any of created | modified | deleted
   * - array — only the listed ops
   */
  wakeOnChange: z.union([trueOrFalse(), listOf(oneOf(MOUNT_WAKE_OPS), `a list of ${listed(MOUNT_WAKE_OPS)}`)],
    takes(`true, false, or a list of ${listed(MOUNT_WAKE_OPS)}`)).optional(),
  /**
   * Persist every write/edit/delete to disk immediately. Required for mounts
   * shared across agents as a communication channel (tickets, reports, etc.)
   * so other agents' chokidar watchers actually see the change. A direct
   * mount refuses it: its writes are on disk when they answer.
   */
  autoMaterialize: trueOrFalse().optional(),
  /** With `watch: 'always'`, how long changes are gathered before the workspace looks at them, in ms (the framework's default is 300). */
  watchDebounceMs: timerMs(0).optional(),
  /** With `watch: 'always'`, how often the watcher checks that the mount's directory is still the one it watches, in ms (the framework's default is 2000). */
  watchRootPollMs: timerMs(1).optional(),
  /**
   * Passed to agent-framework's mount: whether the workspace follows a
   * symlink inside the mount (the framework's default is off), a file that
   * is itself a link and, from the framework's release with
   * anima-research/agent-framework#468, a link among a path's directories
   * too, which earlier releases follow either way. The framework still
   * doesn't read through a link whose target lies outside the mount.
   */
  followSymlinks: trueOrFalse().optional(),
};
type MountShape = Exact<typeof mountShape>;
/**
 * A recipe's workspace mount: every key of agent-framework's MountConfig,
 * passed to the framework as given but for `path`, which is resolved,
 * with `mode` and `watch` optional because the host defaults them. The
 * maximum file size is operator-configurable because binary service
 * artifacts may legitimately exceed the conservative framework default.
 */
export type RecipeWorkspaceMount = z.output<typeof mount>;
const mount = z.strictObject(mountShape, {
  error: (issue) => (issue.code === 'unrecognized_keys'
    ? unknownKeysWords(issue.keys, Object.keys(mountShape), MOUNT_KEY_INSTEAD)
    : 'an object'),
})
  .check(
    rule<MountShape>(['name'], (m) =>
      m.name === '_config'
        ? ({ at }) => `Recipe ${at()} is named "_config", the name of the host's own mount of the session's config directory, which configMount: true adds. Give this mount another name.`
        : undefined),
    rule<MountShape>(['backend', 'mode'], (m) =>
      m.backend === 'direct' && m.mode === undefined
        ? ({ at }) => `Recipe ${at()} is direct, so it must say its mode: add "mode": "read-only", or "read-write" for one the agent writes on disk directly, with no undo.`
        : undefined),
  );

const workspaceObjectShape = {
  mounts: listOf(mount, 'a non-empty list of mounts').min(1, takes('a non-empty list of mounts')),
  configMount: trueOrFalse().optional(),
  outsideMounts: oneOf(['read-only', 'read-write']).optional(),
};
type WorkspaceObject = Exact<typeof workspaceObjectShape>;
const workspaceObject = z.strictObject(workspaceObjectShape, takes('true, false or an object of settings'))
  .check(
    rule<WorkspaceObject>(['mounts'], (ws) => {
      const firstByName = new Map<string, number>();
      for (const [i, m] of ws.mounts.entries()) {
        const first = firstByName.get(m.name);
        if (first !== undefined) {
          return ({ at, show }) => `Recipe ${at(`mounts.${i}`)} is named ${show(`mounts.${i}.name`, m.name)}, as ${at(`mounts.${first}`)} is: ` +
            'a workspace takes each mount name once, since its tools and the instructions find a mount by its name. Give one of them another name.';
        }
        firstByName.set(m.name, i);
      }
      return undefined;
    }),
    rule<WorkspaceObject>(['mounts', 'configMount', 'outsideMounts'], (ws) => {
      const warn = console.warn;
      console.warn = () => {};
      try {
        const config = workspaceConfig(ws, '.');
        if (config) new WorkspaceModule(config);
        return undefined;
      } catch (err) {
        const said = (err instanceof Error ? err.message : String(err)).replace(/^\[workspace\] /, '');
        return ({ at, show }) => `Recipe ${at()}: ${namedAsShown(said, ws, show)}`;
      } finally {
        console.warn = warn;
      }
    }),
  );

function stringsUnder(value: unknown, path: string, out: Array<readonly [string, string]>): void {
  const under = (key: string | number) => (path === '' ? String(key) : `${path}.${key}`);
  if (typeof value === 'string') out.push([path, value]);
  else if (Array.isArray(value)) value.forEach((item, i) => stringsUnder(item, under(i), out));
  else if (isPlainObject(value)) for (const [key, item] of Object.entries(value)) stringsUnder(item, under(key), out);
}

function namedAsShown(said: string, root: unknown, show: Show): string {
  const strings: Array<readonly [string, string]> = [];
  stringsUnder(root, '', strings);
  let text = said;
  for (const [path, value] of strings.sort((a, b) => b[1].length - a[1].length)) {
    const quoted = JSON.stringify(value);
    const shownAs = show(path, value);
    if (value !== '' && shownAs !== quoted) text = text.replaceAll(quoted, () => shownAs).replaceAll(`"${value}"`, () => shownAs);
  }
  return text;
}

const instructions = z.strictObject({
  /** Workspace path "<mountName>/<relativePath>". Default "instructions/AGENTS.md". */
  path: textWhere('a workspace path of the form "<mountName>/<relativePath>"', (s) => {
    const slash = s.indexOf('/');
    return s.trim() !== '' && slash > 0 && slash !== s.length - 1;
  }).optional(),
  /**
   * Heading line prepended to the injected block.
   * Default "# Shared operating instructions (live document)".
   */
  header: text().optional(),
  /**
   * Truncate content beyond this many bytes, appending a
   * "[truncated: first N of M bytes]" marker (N may sit up to 3 bytes
   * under the cap when a multibyte character straddles it). Reads ask for
   * no more than this. Default 32768.
   */
  maxBytes: numberWhere('a positive integer', (v) => Number.isInteger(v) && v > 0).optional(),
  /** Where the block lands: 'system' (default) | 'beforeUser' (deprecated) | 'afterUser'. */
  position: oneOf(['system', 'beforeUser', 'afterUser']).optional(),
}, takes('true, false or an object'));

const activityShape = { channels: textList().optional() };
const activity: z.ZodType<Exact<typeof activityShape>> = z.looseObject(activityShape, takes('an object'));

const noticeList = () => listOf(nonEmptyText(), 'a list of non-empty strings');
const notices = z.strictObject({
  statusChannels: noticeList().optional(),
  reply: z.strictObject({ in: noticeList().optional(), not: noticeList().optional() }, takes('an object ({ in?, not? })')).optional(),
  kinds: mapOf(oneOf(['silent', 'status', 'reply']), 'an object of kind → tier').optional(),
  quietMs: nonNegative('a non-negative number').optional(),
  renotifyMs: nonNegative('a non-negative number').optional(),
}, takes('true, false or an object'));

const mcplAdminShape = { surface: oneOf(['tools', 'utilities']).optional() };
const mcplAdmin: z.ZodType<Exact<typeof mcplAdminShape>> = z.looseObject(mcplAdminShape, takes('an object'));

const embedUrl = text('an http(s) URL with a host (the embed-service base URL)')
  .refine((s) => {
    try {
      const url = new URL(s);
      return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '' && !/^https?:\/\/\//i.test(s);
    } catch {
      return false;
    }
  }, { ...takes('an http(s) URL with a host (the embed-service base URL)'), abort: true })
  .refine((s) => {
    const url = new URL(s);
    return !(url.username || url.password || url.search || url.hash || s.includes('?') || s.includes('#'));
  }, takes('a URL without credentials, a query or a fragment (use `token` for auth)'));

const semanticShape = {
  url: embedUrl,
  token: nonBlankText().optional(),
  namespace: nonBlankText().optional(),
  syncIntervalMs: numberWhere('0 (no background sync) or an integer >= 5000',
    (v) => Number.isInteger(v) && (v === 0 || v >= 5000)).optional(),
  maxSyncPerTick: numberWhere('an integer >= 1', (v) => Number.isInteger(v) && v >= 1).optional(),
  maxSyncBeforeSearch: numberWhere('an integer >= 1', (v) => Number.isInteger(v) && v >= 1).optional(),
  includePrivateTools: trueOrFalse().optional(),
  /** Allow plaintext http to a host outside loopback/tailnet. Host-side only. */
  allowInsecureHttp: trueOrFalse().optional(),
};
type SemanticShape = Exact<typeof semanticShape>;
const history = z.strictObject({
  semantic: z.strictObject(semanticShape, takes('an object'))
    .check(rule<SemanticShape>(['url', 'allowInsecureHttp'], (s) =>
      new URL(s.url).protocol === 'http:' && !isLoopbackOrTailnetHost(new URL(s.url).hostname) && s.allowInsecureHttp !== true
        ? ({ at, show }) => `Recipe ${at('url')} ${show('url', s.url)} is plaintext http to a host that is neither loopback nor tailnet ` +
          '(100.64.0.0/10, *.ts.net): history and the token would cross the network unencrypted. ' +
          'Use https, or set allowInsecureHttp: true if the path is otherwise private.'
        : undefined))
    .optional(),
}, takes('true, false or an object'));

const identityShape = { home: text().optional(), audience: text().optional() };
const identity: z.ZodType<Exact<typeof identityShape>> = z.looseObject(identityShape, takes('an object'));

const fleetChildShape = {
  name: nonEmptyText(),
  /**
   * Recipe path or http(s) URL.  Relative paths are resolved at `loadRecipe`
   * time against the directory of the parent recipe file (or URL base), so
   * a sibling recipe is referenced by its filename regardless of where the
   * parent is launched from.  Absolute paths and URLs pass through
   * unchanged.
   */
  recipe: nonEmptyText(),
  /** Data dir override; default `./data/<name>`. */
  dataDir: text().optional(),
  /** Env overrides on top of parent env. */
  env: mapOf(textNumberOrBoolean()).optional(),
  /**
   * Event subscription at handshake (supports glob like `tool:*`).
   * Relevant synthetic events the parent may care about:
   *   - `lifecycle` (includes `ready` / `idle` / `exiting`) — required for fleet--await.
   *   - `inference:speech` — per-final-inference speech text, required for fleet--relay.
   *   - `inference:completed` / `inference:failed` / `tool:completed` / `tool:failed` — useful for status tracking.
   */
  subscription: textList().optional(),
  /** Launch this child on framework start. Default: true. */
  autoStart: trueOrFalse().optional(),
  /** Respawn on crash. */
  autoRestart: trueOrFalse().optional(),
};
const fleetChild: z.ZodType<Exact<typeof fleetChildShape>> = z.looseObject(fleetChildShape, takes('an object'));

const fleetShape = {
  /** Children to manage. autoStart children launch when the framework starts. */
  children: listOf(fleetChild, 'a list').optional(),
  /**
   * Allowlist for `fleet--launch`. With neither this nor a recipe in
   * `children` there is no allowlist; otherwise it holds these patterns
   * and every recipe path named in `children`. A launch call targeting a
   * recipe outside the allowlist fails with an error telling the agent to
   * ask the user to extend `allowedRecipes`.
   *
   * Pattern syntax (intentionally minimal to keep matcher and intent aligned):
   *   - Literal exact match: `"recipes/miner.json"`
   *   - Single `"*"`: allow everything
   *   - Trailing `"*"` only (prefix match): `"recipes/*"` matches any path
   *     under `recipes/`.  A mid-string `*` is rejected at validation time
   *     — it would look like a glob but behave only as a literal.
   */
  allowedRecipes: listOf(textWhere('a recipe path, with a "*" only at its end (prefix match) or alone (allow all)',
    (p) => p === '*' || !p.includes('*') || p.indexOf('*') === p.length - 1), 'a list of strings').optional(),
  /** Default subscription sent to each child at handshake if they don't specify their own. */
  defaultSubscription: textList().optional(),
  /**
   * Spawn-readiness timeouts forwarded to FleetModule.  Bump these when a
   * child's startup work (heavy MCP servers, large state load) won't fit
   * inside the FleetModule defaults (15s / 10s / 10s / 5s respectively).
   */
  socketWaitTimeoutMs: nonNegative('a non-negative number (finite)').optional(),
  readyTimeoutMs: timerMs(0).optional(),
  gracefulShutdownMs: timerMs(0).optional(),
  sigtermEscalationMs: timerMs(0).optional(),
};
type FleetShape = Exact<typeof fleetShape>;
const fleet: z.ZodType<FleetShape> = z.looseObject(fleetShape, takes('an object'))
  .check(rule<FleetShape>(['children'], (f) => {
    const children = f.children ?? [];
    const twice = children.findIndex((child, i) => children.findIndex((other) => other.name === child.name) !== i);
    return twice >= 0
      ? ({ at, show }) => `Recipe ${at(`children.${twice}.name`)} ${show(`children.${twice}.name`, children[twice]!.name)} is duplicated.`
      : undefined;
  }));

const basicAuthShape = { username: text(), password: text() };
const basicAuth: z.ZodType<Exact<typeof basicAuthShape>> = z.looseObject(basicAuthShape, takes('an object { username, password }'));
const webuiShape = {
  port: number().optional(),
  host: text().optional(),
  /**
   * No longer read: the observer grant tools (observers--get/grant/revoke)
   * live in agent-framework's built-in toolset ("settings"), out of the tool
   * list, opened with `toolsets--open {toolset:"settings"}` and called with
   * `toolsets--act`, for an agent that may call both (for one that may not,
   * they stay in its tool list). It's accepted so older recipes still load.
   * Consent semantics unchanged: the agent holds the pen.
   */
  observersSurface: oneOf(['tools', 'utilities']).optional(),
  /**
   * Basic-Auth credentials. Required whenever the bind host is non-loopback
   * (which is the default). `${VAR}`-substitutable from .env. When set, both
   * must be strings: the load refuses a missing one or another kind, and the
   * Web UI refuses an empty one at its start. A null basicAuth reads as none.
   */
  basicAuth: basicAuth.nullable().optional(),
  /**
   * Override the default Origin allowlist for the WebSocket upgrade. Default
   * is `http(s)://127.0.0.1:<port>` and `http(s)://localhost:<port>`. Write
   * each entry as an `http` or `https` URL the way a browser sends its
   * Origin (scheme, host and any non-default port, with no path or trailing
   * slash); without `basicAuth`, only on 127.0.0.1, localhost or [::1], any
   * port. With `basicAuth`, add your reverse proxy's origin (e.g.
   * `https://admin.example.com`) if it rewrites `Host`. The load refuses a
   * value that isn't a list of strings or `null`. The host refuses at start an empty
   * list and an entry that isn't an `http` or `https` URL (without
   * `basicAuth`, one on those three names); a null list reads as absent.
   * Beyond that it doesn't check how an entry is written, so one with, say,
   * a path, a trailing slash, a default port or capital letters starts and
   * never matches.
   */
  allowedOrigins: textList().nullable().optional(),
};
const webui: z.ZodType<Exact<typeof webuiShape>> = z.looseObject(webuiShape, takes('an object'));

const ttsRelayShape = {
  /** Relay bot endpoint, e.g. "ws://localhost:8800/bot". */
  url: textWhere('a ws:// or wss:// URL', (s) => /^wss?:\/\//.test(s)),
  /** Shared secret for the relay's /bot auth (its BOT_TOKENS). */
  token: nonEmptyText('a non-empty string (use ${VAR} substitution)'),
  /** Relay-side bot identifier. Defaults to the agent's name. */
  botId: text().optional(),
  /** Discord user id stamped on stream events (client voice-config key).
   *  Defaults to botId. */
  userId: text().optional(),
  /** Display name stamped on stream events. Defaults to the agent's name. */
  username: text().optional(),
  /** MCPL server whose channels the relay voices, and which owns `edit_message` for interruption trims. Default 'discord'.
   *  A message published on another server isn't voiced; the host logs a line naming that server at the first such message from it. */
  editServerId: nonEmptyText("a non-empty string, the key of the server the relay voices (leave it out for 'discord')").optional(),
  reconnectIntervalMs: number().optional(),
  /** Whether an interruption puts a note in the context of the agent voiced, when one agent can be named, saying what was voiced and whether the posted message was trimmed. Default true. */
  notifyOnInterruption: trueOrFalse().optional(),
};
const ttsRelay: z.ZodType<Exact<typeof ttsRelayShape>> = z.looseObject(ttsRelayShape, takes('false or an object ({ url, token, ... })'));

const subscriptionGcShape = { defaultLimitChars: number().optional(), serverId: text().optional(), toolPrefix: text().optional() };
const subscriptionGc: z.ZodType<Exact<typeof subscriptionGcShape>> = z.looseObject(subscriptionGcShape, takes('an object'));

const channelModeShape = {
  serverId: text().optional(),
  toolPrefix: text().optional(),
  gcModuleName: text().optional(),
  defaultDebounceMs: number().optional(),
};
const channelMode: z.ZodType<Exact<typeof channelModeShape>> = z.looseObject(channelModeShape, takes('an object'));

const selfRestart = z.strictObject({
  cooldownMinutes: nonNegative('a non-negative number of minutes').optional(),
}, takes('true, false or an object ({ cooldownMinutes? })'));

const modulesShape = {
  /**
   * Subagent forking (spawn/fork parallel agents). OPT-IN — defaults to off
   * and is not part of the standard recipe.
   */
  subagents: either(subagents, 'true, false or an object').optional(),
  /**
   * Lesson library (persistent knowledge store + lesson tools). OPT-IN —
   * defaults to off and is not part of the standard recipe.
   */
  lessons: trueOrFalse().optional(),
  /**
   * Lesson retrieval-injection (requires `lessons`). OPT-IN — defaults to off
   * and is deliberately not part of the standard recipe: it injects
   * context-dependent content into every compile and spends up to two
   * configured retrieval-model calls. Enable only for agents that actually
   * curate a lesson library.
   */
  retrieval: either(retrieval, 'true, false or an object').optional(),
  /**
   * The fetch tool (`fetch--fetch`): read a web page as text, whole or through
   * a small model that answers a prompt. OPT-IN, defaults to off.
   */
  fetch: either(fetchModule, 'true, false or an object').optional(),
  /**
   * The gate (wake rules). `true` or left out: on, with the rules the agent
   * keeps in its gate.json. `false`: off. An object: on, with `policies` and
   * `default` as the host's starting rules (agent-framework's GateConfig),
   * and `judge` configuring the reply judge that `judge` wake rules ask.
   */
  wake: either(wake, 'true, false or an object').optional(),
  /**
   * The heartbeat, kept by agent-framework (its `FrameworkConfig.heartbeat`):
   * the agent's own periodic check-in and reminders, with the tools
   * `heartbeat--heartbeat_status`, `--heartbeat_configure`, `--heartbeat_trigger`,
   * `--reminder_add`, `--reminder_list` and `--reminder_cancel`. OPT-IN: off
   * by default. It replaces the heartbeat-mcpl server, so a recipe that turns
   * it on can't also name an `mcpServers.heartbeat`. `importFrom` brings that
   * server's schedule and reminders along on the first start.
   */
  heartbeat: either(heartbeat, 'true, false or an object, such as {"defaults": {"intervalSeconds": 14400}}').optional(),
  /**
   * The workspace's mounts. `configMount: true` adds `_config`, the
   * session's config directory, holding only files named `gate.json`,
   * `gate.js` or `gate.recipe.json`, the names of the gate's files, at any
   * depth (its include), with history in Chronicle; it isn't materialized
   * on agent writes (buildWorkspaceMounts). Since it has an include,
   * agent-framework keeps none of its own files there: a recipe whose other
   * mounts are each read-only, have an include, or are configured direct
   * keeps no over-cap tool result, saved payload or fetched reference in a
   * file. No mount of the recipe's own is named `_config`, and no two of
   * them share a name, compared exactly.
   *
   * `outsideMounts` lets the workspace's `read` and `read_image` take an
   * absolute path, or one from the home directory (`~/…`), for a file
   * outside every mount (`"read-only"`), and `write` too (`"read-write"`).
   * Left out, every path is a mount's. Such a file is read and written as
   * this process's own user, through no mount's boundary, so it gives the
   * agent every file that user reaches. The workspace keeps no copy of it,
   * so an undo leaves a write to it on disk; what the agent reads of it is
   * in its history, as any tool result is. `fetch.local` reads through the
   * workspace's `read`, so it takes such a path too; the file viewers, the
   * web UI's and the control socket's, show the mounts' files only
   * (namesOutsideMounts). An absolute path that lies in a mount is
   * that mount's file, so a read-only mount stays read-only. The tools'
   * descriptions say what the setting allows (agent-framework's
   * `WorkspaceConfig.outsideMounts`), so setting it changes them.
   */
  workspace: either(workspaceObject, 'true, false or an object of settings').optional(),
  /**
   * Shared operating instructions. OPT-IN — off by default. Reads a living
   * instructions document (a CLAUDE.md analogue maintained in a workspace
   * mount) and injects its current content into EVERY agent's context on
   * EVERY turn — the resident agent and all ephemeral subagents — via the
   * gatherContext hook. Injections are per-turn overlays (not persisted to
   * Chronicle), so edits to the file take effect on the next turn.
   *
   * Requires `workspace` (the path below is a workspace mount path);
   * enabling this alongside `workspace: false` fails validation. The mount
   * named by the path is cross-checked at load time in every configuration
   * (explicit mounts and the implicit "input"+"products" default alike),
   * so a path naming a nonexistent mount is a load error, never a silent
   * no-injection. A read-write instructions mount that isn't configured
   * direct must also set `autoMaterialize: true`: its writes are
   * Chronicle-first and the injection reads disk, so without
   * materialization an agent's own curation edits would never reach the
   * injection. A direct mount's write is on disk when it answers, and in a
   * session it runs as 'chronicle' its writes are refused. A read-only
   * mount is the alternative when the file is maintained outside the
   * agent. A missing FILE remains fail-open at runtime: no injection, with
   * a log line and an `instructions-unavailable` ops alert.
   *
   * Where the block lands, and what that costs:
   * - 'system' (the default) puts it in every agent's system prompt. An edit
   *   to the file misses the cache from the system prompt on, for every
   *   agent, at its next turn, so curate in batches.
   * - 'afterUser' places it after the newest user message at each start, so
   *   it stays near the end. Unlike another module's 'afterUser' block, which
   *   agent-framework stores where it lands, it isn't stored. It moves: a
   *   request misses the cache from its old place on, and on a model that
   *   binds a reply's thinking to everything before it, every reply after its
   *   old place loses its thinking.
   * - 'beforeUser' is deprecated (agent-framework#171). It's spliced in again
   *   before the newest user message at every compile, so it moves, and it
   *   can split a tool call from its result. Use 'afterUser' or 'system'.
   */
  instructions: either(instructions, 'true, false or an object').optional(),
  /**
   * Surface agent composition activity (typing indicators) to one or more
   * MCPL channels while inference is active. Opt-in per recipe; channel IDs
   * use the MCPL format (e.g. `zulip:tracker-miner-f`). The agent can also
   * adjust the set at runtime via the `activity:show_in` / `activity:hide_in`
   * tools.
   */
  activity: either(activity, 'true, false or an object').optional(),
  /**
   * Outage notices: tell the people in the agent's channels, through those
   * channels, when the host cannot answer them. A sink of the framework's
   * `ops:alert` stream (hard-down, spent quota, expired/rejected credential,
   * pending login, provider hold, MCPL server down, …). Off by default:
   * writing into a channel is a bigger act than showing a typing indicator.
   *
   * - `statusChannels` — get the kind and a fixed line saying what happened
   *   for `status` and `reply` kinds, after `quietMs` without a clear; the
   *   alert's own message stays on the operator's surfaces.
   * - `reply.in` / `reply.not` — channel-id patterns (`zulip:*`, exact ids)
   *   where a person who writes to the agent during an outage gets one canned
   *   "cannot respond right now" line, and where the channel whose message
   *   triggered the failing turn is told the same. Default `in: ['*']`.
   * - `kinds` — tier per alert kind (`silent` | `status` | `reply`), `*`
   *   wildcard allowed (`'auth-*': 'reply'`), merged over the built-in table;
   *   unknown kinds are silent.
   * - `quietMs` (default 60000), `renotifyMs` (default 1800000).
   *   `renotifyMs` controls reply re-notification after an announced end and
   *   the per-status-channel floor between acknowledged process notices.
   *
   * `true` = reply anywhere the agent is subscribed, no status channels.
   */
  notices: either(notices, 'true, false or an object').optional(),
  /**
   * MCPL self-administration. Off by default. When enabled, the agent gets
   * `mcpl_list` / `mcpl_deploy` / `mcpl_restart` / `mcpl_unload` tools to
   * hot-manage its own MCPL servers without a host restart. Deployments
   * persist to `mcpl-servers.agent.json` (the agent overlay, in the working
   * directory; a fleet child's is `mcpl-servers.agent.child.json` in its data
   * directory), merged over the
   * recipe/file server list at startup.
   *
   * SECURITY: `mcpl_deploy` spawns arbitrary commands as the host user —
   * enabling this module means trusting the agent with code execution.
   *
   * Its four tools live in agent-framework's built-in toolset ("settings"):
   * out of the tool list, opened with `toolsets--open {toolset:"settings"}`
   * and called with `toolsets--act`, for an agent that may call both; for
   * one that may not, they stay in its tool list.
   * `surface` is no longer read; it's accepted so older recipes still load.
   */
  mcplAdmin: either(mcplAdmin, 'true, false or an object').optional(),
  /**
   * Agent-facing history browsing (HistoryModule). OPT-IN — off by default.
   * Adds `history--stats` / `history--extract` / `history--search` /
   * `history--overview` tools for querying the agent's own uncompressed
   * chronicle (native secondary indexes: stats, time/channel extraction,
   * regex search) and for browsing already-compressed spans via existing
   * summaries (no new LLM calls). Channel-filter arguments on all four tools
   * accept a live or historical channel label/address, not just the raw
   * internal channel id, when MCPL is configured (resolved via the
   * framework's `ChannelRegistry`).
   *
   * Object form adds `history--semantic_search`: meaning-based search over the
   * agent's raw messages (text + its own think/journal/skip_reply notes) and
   * every compression summary, backed by a shared remote embed-service (one
   * per fleet; the vector index lives server-side, keyed by `namespace`).
   * The host keeps that index in sync in the background (default every 60 s)
   * and catches up before each search. `token` goes through the recipe's
   * `${ENV}` substitution like every other secret.
   *
   * Namespace: always `<prefix>/<session id>`, where `namespace` (default: the
   * agent name) is only the PREFIX — message ids are sequential per store, so
   * two stores in one namespace would overwrite each other's entries. A
   * COPIED data dir (staging restore, a local run off a prod snapshot) keeps
   * the session id: give the copy a different `namespace` prefix, or no
   * token, or it will write into the original's index.
   *
   * Transport: sync ships raw message text and the token. `url` must be https,
   * or plain http to loopback / the tailnet (100.64.0.0/10, *.ts.net), where
   * WireGuard is the encryption; any other http needs `allowInsecureHttp: true`.
   *
   * What the remote index holds: with `includePrivateTools` at the
   * framework default (true), the agent's think/journal/skip_reply prose is
   * indexed too. Search hits are checked against the CURRENT branch, so
   * /branchto, /checkout etc. hide rolled-back turns from results, but the remote
   * copy stays; `/session delete` removes only the local store, not the
   * remote namespace (the client has no namespace delete).
   */
  history: either(history, 'true, false or an object').optional(),
  /**
   * The agent's own archipelago-home identity (connectome docs/home-node.md):
   * an ed25519 keypair in the data dir, enrolled at the home node via an
   * operator invite, exchanged for fresh aid1 audience tokens on demand.
   * Its tools are utilities, in agent-framework's built-in toolset
   * ("settings": `toolsets--open {toolset:"settings"}`, then
   * `toolsets--act {tool:"identity--status"}`, or by its own name for an
   * agent that may not call both) — costs no tool slots. `home` defaults to id.animalabs.ai; `audience` is the
   * default for `token` calls.
   */
  identity: either(identity, 'true, false or an object').optional(),
  /**
   * Cross-process child fleet. When true (shorthand), FleetModule is
   * attached with no pre-configured children. When an object, declares
   * children the conductor supervises (auto-started by default on framework
   * start) and optionally an allowlist of recipe paths the conductor may
   * spawn at will.
   *
   * Recipe path resolution: relative paths in `children[].recipe` are resolved
   * at load time against the directory of the parent recipe file (or URL
   * base), NOT the process CWD. This lets a recipe bundle live anywhere on
   * disk and reference its siblings portably. Absolute paths and http(s)
   * URLs pass through unchanged.
   *
   * Note: this differs from runtime paths (workspace mounts, `dataDir`),
   * which stay CWD-relative because they describe where the running process
   * puts its state.
   */
  fleet: either(fleet, 'true, false or an object').optional(),
  /**
   * Web admin UI. Off by default. The default bind is 0.0.0.0:7340 (connectome
   * deployments are remote, not local), which hard-requires Basic-Auth: a
   * recipe that enables webui MUST supply `basicAuth`, or the host refuses to
   * start. Credentials should be `${VAR}`-substituted from .env, never literal.
   *
   * For remote admin, front this with a reverse proxy (Caddy/nginx) for TLS;
   * Basic-Auth is still required at the app layer. Set `host: '127.0.0.1'` to
   * bind loopback-only for local development, which skips the auth requirement.
   */
  webui: either(webui, 'true, false or an object').optional(),
  /**
   * TTS relay tap (melodeus-tts-relay). Off by default. When set, the host
   * sends the agent's turns (activation start/end, on the turn's channel)
   * and each message its prose publishes on the server `editServerId` names
   * (one text block, on the channel it was published to; a message that's
   * only whitespace isn't sent) to the relay's `/bot` WebSocket, where
   * voice clients (Melodeus / iOS) speak it. Text the agent didn't publish,
   * its thinking, tool calls and tool results, and messages sent by a tool
   * call aren't sent, and nothing is sent while the host isn't connected to
   * the relay, so a message published then isn't matched to an
   * interruption. Also handles the relay's `interruption` events: the host
   * edits at most one message it recently published in the interruption's
   * channel, one the heard words match, to the text the client reports as
   * voiced, and, with `notifyOnInterruption` on (its default), puts a note
   * in the context of the agent voiced, when one agent can be named.
   * Nothing is edited when no message matches, and no note is written when
   * the messages that match are by more than one agent. What an agent wrote
   * and didn't publish isn't voiced, so it holds back no edit. Messages are
   * matched among each channel's latest 32, in the 32 channels published in
   * last. A channel keeps the names of the agents voiced there, and of
   * those whose messages it let go, a channel past those 32 or a message
   * past its latest 32: until its next interruption, a message kept there
   * is edited, and its author told, only when no other agent's messages
   * were let go there. `token` should be `${VAR}`-substituted from .env,
   * never literal.
   */
  ttsRelay: z.union([z.literal(false, takes('false or an object ({ url, token, ... })')), ttsRelay],
    takes('false or an object ({ url, token, ... })')).optional(),
  /**
   * Auto-unsubscribe noisy ambient channels. On by default. Per subscribed
   * channel, the host counts ambient characters since the agent's last
   * activation. A mention, a DM and an event tagged `chat:addressed` aren't
   * ambient. When a channel crosses its limit before the next
   * activation, it's auto-unsubscribed (delivery stops, and the surface starts
   * tracking what's then missed). A channel the agent opened itself stays open
   * unless a limit is configured for it, and a tuned-out channel is left alone.
   * Counters reset on every activation — the agent sees all subscribed channels
   * in context, compressed if large — and persist across restarts. The agent
   * can override the per-channel limit at runtime via `agent_settings` (field
   * `channel_idle_limits`).
   *
   * `false` disables entirely. `defaultLimitChars` sets the global default
   * (20000 if omitted). `serverId` names the one MCPL server that the module
   * watches (default `discord`). The module counts that server's ambient
   * traffic and closes its channels. Use the server's id from `mcpServers` or
   * `mcpl-servers.json`. A host can lack the server of that id. Then the module
   * closes nothing, and the host says so in three places. If `serverId` names
   * the missing id, the host says so at start. The host writes a line at the
   * first ambient event with text from each other server. And `agent_settings`
   * carries `channel_idle_warning` on a host with any MCPL server. With
   * `serverId` left out on a host that has `discord`, the host writes a line
   * for each other server too. `toolPrefix` is deprecated and read by nothing.
   */
  subscriptionGc: either(subscriptionGc, 'true, false or an object').optional(),
  /**
   * One-step channel attention modes (the `set_channel_mode` tool): flip a
   * channel between mentions-only and every-message-debounced. Debounced mode
   * bundles subscribe + a per-channel ambient debounce gate rule + pinning
   * subscription-gc off (a host with `subscriptionGc: false` has nothing to
   * pin, and skips that step); mentions mode reverses all three. On by default
   * when the gate (`wake`) is enabled — it only ADDS a tool, inert until called.
   * `false` disables. Each call's MCPL server is the prefix of its channel
   * id (`zulip:backend` → `zulip`), which must name a server this host knows;
   * an id without one, or with a `*` in it, is refused. `serverId` is
   * deprecated and ignored (a startup line says so); it used to name the one
   * server for every call.
   * `toolPrefix` is deprecated and read by nothing.
   * `defaultDebounceMs` sets the debounced-mode quiet window (180000 if
   * omitted). `gcModuleName` names the cleanup module that the pin step calls
   * (`subscription-gc` if omitted). Left out, the pin is skipped on a host
   * without that module. If the recipe names `gcModuleName`, channel mode
   * always calls that module. So if no module has that name, each pin step
   * fails.
   */
  channelMode: either(channelMode, 'true, false or an object').optional(),
  /**
   * Self-restart (`lifecycle--restart`). Off by default. The agent can ask
   * its own host to restart: to pick up an edited recipe or rebuilt code, or
   * to get out of a wedged state. The restart waits for the asking turn to
   * end and nothing to be in flight (every agent idle, no turn, subagent run
   * or background script alive), then the host exits with code 75 and its
   * supervisor must start it again — launchd `KeepAlive`, systemd
   * `Restart=on-failure` or `always`, or a fleet parent's `autoRestart`. A
   * fleet parent restarts a child only when the child's entry sets
   * `autoRestart`, and counts each restart toward its cap of 3 in 60 s, so
   * `cooldownMinutes: 0` can leave a fast-restarting child down; a child the
   * parent adopted has no exit it sees, and stays down. A fleet parent's own
   * self-restart stops its children as any shutdown does, and the restarted
   * parent starts again only its `autoStart` children. Only
   * headless mode arms it; elsewhere the tool refuses. After the restart one
   * context line says which agent asked, when, why, and when the host came
   * back.
   *
   * `cooldownMinutes` (default 10) is the least time from one completed
   * self-restart to the next request; 0 turns the cooldown off. The request
   * and the last completed restart live in `DATA_DIR` as `self-restart.json`
   * and `self-restart.last.json`.
   *
   * Enable it only where a supervisor really restarts the host: without one,
   * the agent stays down after its own request.
   */
  selfRestart: either(selfRestart, 'true, false or an object ({ cooldownMinutes? })').optional(),
  /** The host's own setup agent's tools, which `connectome setup` starts. */
  setup: trueOrFalse().optional(),
  /**
   * The agent's own update (`lifecycle--update`). Off by default. The agent
   * can check for, install and restart onto a release of its own install,
   * as `/update` does; going back stays the person's. A restart begins at the
   * host's first quiet moment, as `QUIET_MOMENT` in `src/web/update-text.ts`
   * says, though no sooner than a minute after a try that found something
   * still going, and is armed only on a host whose environment at its start holds
   * `CONNECTOME_SUPERVISED=1`, which the service written by `connectome service
   * install` sets only if that service starts the host again when it exits
   * with 75 and when it exits with 1.
   */
  selfUpdate: trueOrFalse().optional(),
};
type ModulesShape = Exact<typeof modulesShape>;

function instructionsMount(m: ModulesShape): Sentence | undefined {
  if (m.instructions === undefined || m.instructions === false || m.workspace === false) return undefined;
  const ownPath = typeof m.instructions === 'object' ? m.instructions.path : undefined;
  const path = ownPath ?? DEFAULT_INSTRUCTIONS_PATH;
  const mountName = path.slice(0, path.indexOf('/'));
  const declared = typeof m.workspace === 'object' ? m.workspace.mounts.length : 0;
  const mounts = buildWorkspaceMounts(m.workspace, '.') ?? [];
  const named = mounts.filter((mount) => mount.name === mountName);
  if (named.length > 1) return undefined;
  const match = named[0];
  const pathWords = (show: Show) => (ownPath !== undefined ? show('instructions.path', ownPath) : JSON.stringify(path));
  const mountWords = (show: Show, kind: string) => {
    const shown = ownPath !== undefined ? show('instructions.path', mountName) : JSON.stringify(mountName);
    return shown === JSON.stringify(mountName) ? `${kind} ${shown}` : `a ${kind}`;
  };
  if (!match) {
    return ({ show }) => `Recipe modules.instructions.path ${pathWords(show)} names ${mountWords(show, 'workspace mount')}, but the ${
      declared > 0 ? 'declared' : 'implicit default'} mounts are: ${
      mounts.map((mount, i) => (i < declared ? show(`workspace.mounts.${i}.name`, mount.name) : JSON.stringify(mount.name))).join(', ')}. ` +
      '(The default path "instructions/AGENTS.md" requires a workspace mount named "instructions" — declare one under modules.workspace.mounts.)';
  }
  if (match.name === '_config') {
    return ({ show }) => `Recipe modules.instructions.path ${pathWords(show)} reads through the ` +
      'host-managed "_config" mount, which does NOT auto-materialize: agent edits stay ' +
      'Chronicle-side and only reach disk after branch-changing commands, so the ' +
      'instructions injection would silently serve stale content. Use a dedicated instructions mount instead.';
  }
  if (match.mode !== 'read-only' && match.backend !== 'direct' && match.autoMaterialize !== true) {
    return ({ show }) => `Recipe modules.instructions.path ${pathWords(show)} uses ${mountWords(show, 'read-write mount')} without autoMaterialize. ` +
      'Its writes are Chronicle-first and reach disk only when the mount materializes, while the ' +
      'instructions injection reads disk — agent edits to the file would silently never ' +
      'take effect. Set autoMaterialize: true on the mount, or configure it ' +
      '"backend": "direct" with "mode": "read-write" so edits reach disk at once, with no undo' +
      `${declared > 0 ? '' : ' (the implicit default workspace can do neither; declare explicit mounts)'}, ` +
      'or make the mount read-only if the file is maintained outside the agent.';
  }
  return undefined;
}

const modules: z.ZodType<ModulesShape> = z.looseObject(modulesShape, takes('an object of module settings, not null or a list'))
  .check(
    rule<ModulesShape>(['instructions', 'workspace'], (m) =>
      m.instructions !== undefined && m.instructions !== false && m.workspace === false
        ? () => 'Recipe modules.instructions requires modules.workspace: the instructions file is ' +
          'read through a workspace mount, but this recipe sets workspace: false.'
        : undefined),
    rule<ModulesShape>(['instructions', 'workspace'], instructionsMount),
    rule<ModulesShape>(['fetch', 'workspace'], (m) =>
      typeof m.fetch === 'object' && m.fetch.local === true && m.workspace === false
        ? () => 'Recipe modules.fetch.local reads files through the workspace, so it needs modules.workspace on.'
        : undefined),
  );

const extensionShape = {
  /** Primary purpose. Gates validation (a non-built-in `agent.strategy.type`
   *  requires at least one `kind: "strategy"` extension) and informs build
   *  tooling; does not restrict what `register` may call. */
  kind: oneOf(['strategy', 'module']),
  /** Path to the extension entry module. Relative paths resolve against the
   *  recipe file's directory at load time; URL-loaded recipes must use
   *  absolute paths (the host never imports code over the network). */
  path: nonEmptyText(),
  /** Opaque blob passed verbatim to the extension's `register` function and
   *  to module factory contexts. */
  config: anyObject().optional(),
  /** Build-tooling acquisition metadata (git url/ref/install pattern) —
   *  consumed by connectome-cook at build time, ignored at runtime. */
  source: anyObject().optional(),
  /** Build-only provenance: `source` demoted by build tooling into the
   *  shipped recipe. Ignored at runtime. */
  sourceMeta: anyObject().optional(),
};
/**
 * A deployment-specific code extension: a local TS/JS module that registers
 * custom context strategies and/or framework modules at boot. See
 * src/extensions.ts for the loader and the `register(api, config)` contract.
 */
export type RecipeExtension = z.output<typeof extension>;
const extension: z.ZodType<Exact<typeof extensionShape>> = z.looseObject(extensionShape, takes('an object'));
const extensions = mapOf(extension, 'an object mapping names to extension entries')
  .check(rule<Record<string, unknown>>([''], (e) =>
    Object.hasOwn(e, '') ? () => 'Recipe extensions keys must be non-empty names.' : undefined));

const sessionNamingShape = { examples: textList().optional() };
const sessionNaming: z.ZodType<Exact<typeof sessionNamingShape>> = z.looseObject(sessionNamingShape, takes('an object'));

const RETIRED_CODE_EXECUTION_KEYS: Readonly<Record<string, string>> = {
  pythonPath: 'scripts are JavaScript now, run by an engine built into agent-framework, so there is no interpreter to name; leave it out',
  idleReclaimMs: 'each script starts fresh and keeps nothing after it ends, so there is nothing to reclaim; leave it out',
  env: "a script's world holds only your agent's tools, with no environment; leave it out",
  inheritEnv: "a script's world holds only your agent's tools, with no environment; leave it out",
  scriptTimeoutMs: 'a script now yields at its bound and keeps running: set yieldMs for the bound',
  maxScriptTimeoutMs: 'set maxYieldMs, the most an agent may ask a run or a wait to wait',
  backgroundMaxLifetimeMs: 'every script now has one limit: set scriptLifetimeMs',
  maxBackgroundScripts: 'set maxRunningScripts, how many scripts an agent may have running at once, yielded ones included',
};
const retiredCodeExecutionKeys = (ce: Readonly<Record<string, unknown>>): string[] =>
  (ce.enabled === true ? Object.keys(RETIRED_CODE_EXECUTION_KEYS).filter((k) => ce[k] !== undefined && ce[k] !== null) : []);
const scriptCount = () => nonNegativeSafeInteger('a whole number of 0 or more').optional();
const codeExecutionShape = {
  enabled: trueOrFalse(),
  yieldMs: scriptCount(),
  maxYieldMs: scriptCount(),
  scriptLifetimeMs: scriptCount(),
  maxRunningScripts: scriptCount(),
  maxScriptChildren: scriptCount(),
  toolCallTimeoutMs: scriptCount(),
  wakeMinIntervalMs: scriptCount(),
  maxWakesPerScript: scriptCount(),
  memoryMaxBytes: scriptCount(),
};
type CodeExecutionShape = Exact<typeof codeExecutionShape>;
/**
 * Client-side programmatic tool calling (af `code_execution` tool), passed to
 * the framework as written, so its keys are agent-framework's CodeExecutionConfig.
 *
 * SECURITY: model-authored JavaScript runs in a QuickJS WebAssembly
 * engine, in a child process of the host, and reaches nothing but its
 * agent's tools: no network, files or environment. The framework claims no
 * containment beyond its engine and glue: the child runs as the host's
 * user, with no operating-system sandbox around it. Enable deliberately.
 */
export type RecipeCodeExecution = z.output<typeof codeExecution>;
const codeExecution: z.ZodType<CodeExecutionShape> = z.looseObject(codeExecutionShape, takes('an object'))
  .check(rule<CodeExecutionShape>(['enabled', ...Object.keys(RETIRED_CODE_EXECUTION_KEYS)], (ce) =>
    retiredCodeExecutionKeys(ce).map((key): Sentence => ({ at }) =>
      `Recipe ${at(key)} is no longer read (agent-framework 0.24): ${RETIRED_CODE_EXECUTION_KEYS[key]}.`)));

const channelKinds = <const T extends readonly [string, ...string[]]>(rules: T) => z.strictObject({
  dm: oneOf(rules).optional(),
  groupDm: oneOf(rules).optional(),
  channel: oneOf(rules).optional(),
}, takes('an object'));

/**
 * Per-channel conversation routing (agent-framework ConversationRouter):
 * the recipe's agent becomes a dormant "trunk" template, and qualifying
 * incoming channel messages spawn per-channel fork agents seeded from the
 * trunk's current context. The host fills in what the framework needs but a
 * recipe can't say: `templateAgent` is always the recipe's own agent, and
 * `strategyFactory` builds a fresh instance of the recipe's `agent.strategy`
 * per fork (strategy instances are stateful and must never be shared).
 *
 * @deprecated Per-channel conversation routing is deprecated and will be
 * removed (agent-framework#235). Its 'mention' bind/trigger rule reads
 * `metadata.mentioned`, which discord-mcpl does not set, so on Discord
 * channels an @-mention neither binds a fork nor triggers a bound one. Still
 * works; the host logs a `[deprecated]` line at startup when it is set.
 */
export type RecipeConversations = z.output<typeof conversations>;
const conversations = z.strictObject({
  /** When an unbound channel acquires a fork.
   * Defaults: dm 'always', groupDm 'always', channel 'mention'. */
  bind: channelKinds(['always', 'mention', 'never']).optional(),
  /** When a message on a bound channel triggers inference (it always lands
   * in the fork's context regardless).
   * Defaults: dm 'always', groupDm 'mention', channel 'mention'. */
  trigger: channelKinds(['always', 'mention']).optional(),
  /** Idle time before a binding expires and the fork runs its closure turn.
   * Default 12h. Expiry is checked at most about once a minute, so the sweep
   * usually notices an expired binding up to ~60s after the TTL elapses.
   * That is the usual extra delay, not a deadline for closing the fork: the
   * closure turn can be delayed further (e.g. while the host is quiesced, it
   * stays queued until resume). */
  idleTtlMs: numberWhere('a positive finite integer', (v) => Number.isInteger(v) && v > 0).optional(),
  /** Final system-initiated user message sent to a fork on expiry. */
  closurePrompt: nonBlankText().optional(),
  /** Prefix for generated fork agent names (default 'conversation'). Also
   * the Chronicle namespace segment, so it is restricted to [A-Za-z0-9_-]. */
  agentPrefix: textWhere('a non-empty string of [A-Za-z0-9_-] (it names fork agents and their Chronicle namespaces)',
    (s) => /^[A-Za-z0-9_-]+$/.test(s)).optional(),
}, takes('an object'));

const persistentReaderShape = {
  enabled: trueOrFalse(),
  reader: z.literal('persistent').optional(),
  name: nonBlankText().optional(),
  model: nonBlankText().optional(),
  systemPrompt: nonBlankText(),
  allowChannelSpeech: trueOrFalse().optional(),
  reAnchorFraction: numberWhere('a number in (0, 1]', (v) => v > 0 && v <= 1).optional(),
};
const forkReaderShape = {
  enabled: trueOrFalse(),
  reader: z.literal('forks'),
  model: nonBlankText('a non-empty string for reader "forks": say whose weights run the fork ' +
    '(the agent\'s own model for a copy of the resident, or another by name)'),
  voice: nonBlankText('a non-empty string for reader "forks"'),
  allowChannelSpeech: trueOrFalse().optional(),
  forkIdleTimeoutMs: aboveZero('a positive finite number of milliseconds').optional(),
};

function otherReadersKeys(reader: 'persistent' | 'forks'): (issue: z.core.$ZodRawIssue) => string | undefined {
  const own: object = reader === 'forks' ? forkReaderShape : persistentReaderShape;
  const other: object = reader === 'forks' ? persistentReaderShape : forkReaderShape;
  const otherName = reader === 'forks' ? 'persistent' : 'forks';
  return (issue) => {
    if (issue.code !== 'unrecognized_keys') return 'an object';
    const misplaced = issue.keys.filter((k) => Object.hasOwn(other, k));
    if (misplaced.length === 0) return unknownKeysWords(issue.keys, Object.keys(own));
    const unknown = issue.keys.filter((k) => !Object.hasOwn(other, k));
    const given = isPlainObject(issue.input) ? issue.input : {};
    const alsoRemove = Object.keys(own).filter((k) => !Object.hasOwn(other, k) && Object.hasOwn(given, k));
    const alsoGive = Object.entries(other)
      .filter(([k, field]) => k !== 'reader' && !(field instanceof z.ZodOptional) && !Object.hasOwn(given, k)).map(([k]) => k);
    const ways = [
      ...(alsoGive.length > 0 ? [`give ${inProse(alsoGive)}, which reader "${otherName}" needs`] : []),
      ...(alsoRemove.length > 0 ? [`remove ${inProse(alsoRemove)}, which only reader "${reader}" takes`] : []),
    ];
    return `Recipe ${inProse(misplaced.map((k) => `subconscious.${k}`))} ${misplaced.length > 1 ? 'are' : 'is'} for reader "${otherName}", ` +
      `and this recipe's reader is "${reader}". Remove ${inProse(misplaced)}, or set subconscious.reader to "${otherName}"` +
      `${ways.length > 0 ? ` and ${ways.join(', and ')}` : ''}. ` +
      (unknown.length > 0 ? `Recipe subconscious ${unknownKeysWords(unknown, Object.keys(own))}.` : `Reader "${reader}" takes ${inProse(Object.keys(own))}.`);
  };
}

/**
 * The tune-out reader (agent-framework FrameworkConfig.subconscious, issues
 * agent-framework#77 and #232): who reads the channels the resident has
 * tuned out and reports to them. Two readers exist:
 *
 * - `reader: 'persistent'` (the default): a persistent side-agent with its
 *   own window, reading the shared slot through a merged view. Passed
 *   through verbatim; the framework owns the defaults (name
 *   `Subconscious`, model = the resident's).
 * - `reader: 'forks'` (Dendrite): a succession of forks of the resident
 *   itself, each derived at the resident's head for one look and ended.
 *   The fork shares the resident's provider prefix. `model` says whose
 *   weights run the fork and is never defaulted — the resident's own model
 *   for a copy of the resident, or another by name. `voice` is the reader's
 *   voice block, delivered to each fork after the fork point with the held
 *   traffic, never a system prompt. Two of the framework's fields are
 *   function-valued, so a recipe cannot state them: the host supplies
 *   `strategyFactory`, a fresh instance of the recipe's strategy per fork
 *   (the same pattern as `conversations`; see buildSubconsciousConfig), and
 *   `framing`, how the fork is prompted, stays the framework's default.
 *
 * The keys are the framework's, less those two fields and `foreignRounds`,
 * `physicalWindowTokens` and `thinkingBinding`, which a recipe doesn't set;
 * agent-framework's src/tune-out/tools.ts documents each field.
 */
export type RecipeSubconscious = z.output<typeof subconscious>;
const subconscious = z.discriminatedUnion('reader', [
  z.strictObject(persistentReaderShape, { error: otherReadersKeys('persistent') }),
  z.strictObject(forkReaderShape, { error: otherReadersKeys('forks') }),
], takes('an object'));

/**
 * Where a turn's plain prose lands when nothing names a destination
 * (agent-framework FrameworkConfig.speech). `'delivery'` (the framework's
 * default): only the delivery that woke the turn, a fork's home channel or a
 * channel the agent opened this turn sets the locus; incoming traffic never
 * moves it, and a turn without one keeps its prose private.
 * `'latest-inbound'`: the previous rule, with the most recent delivered
 * inbound message as a global fallback locus.
 */
export type RecipeSpeech = z.output<typeof speech>;
const speech = z.strictObject({ locus: oneOf(['delivery', 'latest-inbound']).optional() }, takes('an object'));

/**
 * Tune-out settings (agent-framework FrameworkConfig.tuneOut): `announce`
 * only. The resident is offered `tune_out` / `focus` only with a reader
 * (`subconscious`); there is no silent hold. `enabled`, which offered them
 * without a reader, was removed in agent-framework 0.33.0: validateRecipe
 * refuses `enabled: true`, as the framework's `create` does, and lets
 * `enabled: false` load, which the framework accepts and ignores.
 */
export type RecipeTuneOut = z.output<typeof tuneOut>;
const tuneOut = z.strictObject({ enabled: trueOrFalse().optional(), announce: trueOrFalse().optional() }, takes('an object'))
  .check(rule<{ enabled?: boolean }>(['enabled'], (t) =>
    t.enabled === true
      ? () => 'Recipe tuneOut.enabled was removed in agent-framework 0.33.0 (tune-out without a reader): ' +
        'remove tuneOut.enabled; to keep tune_out, configure a subconscious as well.'
      : undefined));

/** Dendrite lifecycle options (agent-framework FrameworkConfig.dendrite). */
export type RecipeDendrite = z.output<typeof dendrite>;
const dendrite = z.strictObject({
  announceOrphans: trueOrFalse().optional(),
  collapseDerivationNoticesAfter: numberWhere('a non-negative integer', (v) => Number.isInteger(v) && v >= 0).optional(),
}, takes('an object'));

const TOOL_CLASS_LIST = `a non-empty list of: ${TOOL_CLASSES.join(', ')}`;
const toolClassOverrides = mapOf(listOf(oneOf(TOOL_CLASSES), TOOL_CLASS_LIST).min(1, takes(TOOL_CLASS_LIST)), 'an object of pattern → classes')
  .check(rule<Record<string, unknown>>([''], (t) =>
    Object.hasOwn(t, '') ? () => 'Recipe toolClassOverrides has an empty pattern.' : undefined));

const inferenceBounds = z.union([
  z.literal(false, takes('false or an object')),
  z.strictObject({
    progressBounds: z.strictObject({
      beforeContentMs: aboveZero().optional(),
      betweenEventsMs: aboveZero().optional(),
      thinkTokensPerSecond: aboveZero().optional(),
    }, takes('an object')).optional(),
    flatMinimumMs: aboveZero().optional(),
  }, takes('false or an object')),
], takes('false or an object'));

const recipeShape = {
  name: nonEmptyText(),
  description: text().optional(),
  version: text().optional(),
  agent,
  mcpServers: mcpServers.optional(),
  modules: modules.optional(),
  /** Deployment-specific code extensions, keyed by a human-readable name. */
  extensions: extensions.optional(),
  sessionNaming: sessionNaming.optional(),
  /** Client-side programmatic tool calling (code_execution tool). */
  codeExecution: codeExecution.optional(),
  /**
   * Per-channel conversation routing — fork-per-channel from this agent.
   *
   * @deprecated Deprecated and will be removed (agent-framework#235); see
   * `RecipeConversations`. Still works; the host logs a `[deprecated]` line
   * at startup when it is set.
   */
  conversations: conversations.optional(),
  /** Tune-out's reader: the persistent subconscious or reader forks (agent-framework#77, #232). */
  subconscious: subconscious.optional(),
  /** Where plain prose lands when nothing names a destination (agent-framework `speech`). */
  speech: speech.optional(),
  /** Tune-out settings (agent-framework `tuneOut`): `announce`. `tune_out` itself comes with `subconscious`. */
  tuneOut: tuneOut.optional(),
  /** Dendrite lifecycle options (agent-framework `dendrite`). The host passes no
   *  `derivationNotice`, so an agent isn't told of a derivation and
   *  `collapseDerivationNoticesAfter`, which only spaces those lines out, has no
   *  effect here. */
  dendrite: dendrite.optional(),
  /**
   * MCPL RFC-008 operator class overrides: tool-name pattern → classes. The
   * highest-precedence source of a tool's class, and the way to class
   * third-party MCP servers (blender, computer use, …) that will never
   * declare `_meta["mcpl/class"]`. Replaces, never merges with, what the
   * server declared. First matching pattern wins. Patterns match the
   * model-facing name, so an MCPL server's tools are
   * `mcpl--<serverId>--<tool>` (`"mcpl--blender--*": ["media"]`) unless its
   * entry sets `toolPrefix`.
   */
  toolClassOverrides: toolClassOverrides.optional(),
  /**
   * How often agent-framework's context maintenance pass runs, in
   * milliseconds: a whole number from 0 to 2147483647, where 0 turns the
   * timer off. Left out, the framework's own interval (5000 ms) stands.
   */
  maintenanceIntervalMs: timerMs(0).optional(),
  /**
   * How long agent-framework lets a model call go without progress
   * (FrameworkConfig.inferenceBounds), passed to it as written: `false` for
   * none of its bounds, or an object with `progressBounds`, any of
   * `beforeContentMs`, `betweenEventsMs` and `thinkTokensPerSecond`, and
   * `flatMinimumMs` beside it. Left out, agent-framework's defaults stand:
   * the "Inference bounds" section of the README its package ships gives them.
   */
  inferenceBounds: inferenceBounds.optional(),
  /**
   * The residence's inline cap for tool results, in characters, passed to
   * agent-framework as FrameworkConfig.toolResultInlineMaxChars. Left out,
   * agent-framework's default stands. A resident's own `agent_settings` value
   * `tool_result_inline_max_chars` wins over it for that agent. A value that
   * isn't a finite number of at least 1000, agent-framework's own minimum,
   * stops the load, naming it. The default, what becomes of a result over the
   * cap and how the cap in effect is reached are in that option's doc in
   * agent-framework's types.
   */
  toolResultInlineMaxChars: numberWhere('a finite number of at least 1000', (v) => v >= 1000).optional(),
};
type RecipeShape = Exact<typeof recipeShape>;

const on = (module: unknown): boolean => module !== undefined && module !== false;

const recipeSchema: z.ZodType<RecipeShape> = z.looseObject(recipeShape, takes('an object'))
  .check(
    rule<RecipeShape>(['agent.strategy.type', 'extensions'], (r) => {
      const type = r.agent.strategy?.type;
      if (!type || isBuiltinStrategyType(type)) return undefined;
      if (Object.values(r.extensions ?? {}).some((e) => e.kind === 'strategy')) return undefined;
      return ({ show }) => 'Recipe agent.strategy.type must be "autobiographical", "passthrough", "frontdesk" or a type that a ' +
        `"kind": "strategy" extension registers (none is declared), got ${show('agent.strategy.type', type)}.`;
    }),
    rule<RecipeShape>(['modules.fetch', 'agent.provider'], (r) => {
      const fetch = r.modules?.fetch;
      const provider = r.agent.provider;
      const model = typeof fetch === 'object' ? fetch.model : undefined;
      return on(fetch) && model === undefined && provider !== undefined && provider !== 'anthropic' && provider !== 'mock'
        ? ({ show }) => `Recipe turns modules.fetch on with agent.provider ${show('agent.provider', provider)} and no modules.fetch.model: ` +
          'the model that answers a fetch prompt defaults to a Claude id this provider doesn\'t take. Set modules.fetch.model to one it serves.'
        : undefined;
    }),
    rule<RecipeShape>(['modules.heartbeat', 'mcpServers'], (r) =>
      on(r.modules?.heartbeat) && r.mcpServers !== undefined && Object.hasOwn(r.mcpServers, 'heartbeat')
        ? () => 'Recipe turns modules.heartbeat on and names mcpServers.heartbeat (heartbeat-mcpl): both would wake the agent, and ' +
          'their tools share the names heartbeat--…. Remove mcpServers.heartbeat to use the framework\'s heartbeat ' +
          '(modules.heartbeat.importFrom can bring that server\'s schedule and reminders along: its HEARTBEAT_CONFIG_FILE ' +
          'and HEARTBEAT_REMINDERS_FILE), or turn modules.heartbeat off to keep the server.'
        : undefined),
    rule<RecipeShape>(['modules.retrieval', 'agent.provider'], (r) => {
      const retrieval = r.modules?.retrieval;
      const provider = r.agent.provider;
      return typeof retrieval === 'object' && retrieval.reasoningEffort !== undefined
        && provider !== 'openai-responses' && provider !== 'openai-codex'
        ? () => 'Recipe modules.retrieval.reasoningEffort requires agent.provider "openai-responses" or "openai-codex".'
        : undefined;
    }),
    rule<RecipeShape>(['conversations', 'agent.proseRouting'], (r) =>
      r.conversations !== undefined && r.agent.proseRouting === 'locked'
        ? () => 'Recipe agent.proseRouting "locked" can\'t be combined with conversations: the forks that answer each channel ' +
          'speak in their home channel, as in locus mode, so the lock would not govern their replies. ' +
          'Remove conversations, or choose another proseRouting, removing agent.proseLock if it\'s set, since only "locked" takes it.'
        : undefined),
    rule<RecipeShape>(['agent.toolPresentation', 'modules.workspace'], (r) => {
      const tp = r.agent.toolPresentation;
      if (tp === undefined) return undefined;
      const mounts = buildWorkspaceMounts(r.modules?.workspace, '/unused');
      return mounts?.some((m) => m.name === tp.cataloguePath.split('/')[0])
        ? undefined
        : () => 'Recipe agent.toolPresentation.cataloguePath requires an existing workspace mount.';
    }),
  );

const RETIRED_RECIPE_KEYS: Readonly<Record<string, string>> = {
  'modules.files': 'modules.workspace',
  'agent.strategy.identityReminderSilent':
    'a sentence asking for silence at the end of each nonblank reminder the recipe sets, ' +
    'agent.strategy.identityReminder and agent.strategy.witnessedIdentityReminder, ' +
    'if it was true; if it was false, nothing',
};

const REFUSED_RECIPE_KEYS: ReadonlySet<string> = new Set(['agent.refusalHandling.primarySummaryFallback', 'modules.retrieval.reasoningContext']);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function armFor(union: z.ZodUnion, value: unknown): z.core.$ZodType | undefined {
  const arms: readonly z.core.$ZodType[] = union.options;
  if (Array.isArray(value)) return arms.find((arm) => bare(arm) instanceof z.ZodArray);
  if (!isPlainObject(value)) return undefined;
  const objects = arms.filter((arm) => bare(arm) instanceof z.ZodObject || bare(arm) instanceof z.ZodRecord);
  if (!(union instanceof z.ZodDiscriminatedUnion)) return objects[0];
  const key: string = union.def.discriminator;
  return objects.find((arm) => {
    const object = bare(arm);
    const field = object instanceof z.ZodObject ? object.shape[key] : undefined;
    return field !== undefined && z.safeParse(field, value[key]).success;
  });
}

function bare(schema: z.core.$ZodType): z.core.$ZodType {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable || schema instanceof z.ZodDefault) {
    return bare(schema.unwrap());
  }
  return schema;
}

const same = (a: z.core.$ZodType, b: z.core.$ZodType): boolean => a === b;

function unknownIn(schema: z.core.$ZodType, value: unknown, path: string, found: string[], name?: string): void {
  const at = bare(schema);
  if (at instanceof z.ZodUnion) {
    const arm = armFor(at, value);
    if (arm) unknownIn(arm, value, path, found, name);
    return;
  }
  if (at instanceof z.ZodArray && Array.isArray(value)) {
    value.forEach((item, i) => unknownIn(at.element, item, `${path}[${i}]`, found));
    return;
  }
  if (!isPlainObject(value)) return;
  if (at instanceof z.ZodRecord) {
    for (const [key, item] of Object.entries(value)) unknownIn(at.valueType, item, path === '' ? key : `${path}.${key}`, found, key);
    return;
  }
  if (!(at instanceof z.ZodObject)) return;
  if (at === strategy && typeof value.type === 'string' && !isBuiltinStrategyType(value.type)) return;
  const prefix = path === '' ? '' : `${path}.`;
  const shape: Readonly<Record<string, z.core.$ZodType>> = at.shape;
  const known = Object.keys(shape);
  const warns = !(at.def.catchall instanceof z.ZodNever);
  const refused = same(at, codeExecution) ? retiredCodeExecutionKeys(value)
    : same(at, mcpServer) && name !== undefined && givesAnotherId(value, name) ? ['id'] : [];
  for (const key of Object.keys(value)) {
    const where = `${prefix}${key}`;
    if (!warns || Object.hasOwn(shape, key) || REFUSED_RECIPE_KEYS.has(where) || refused.includes(key)) continue;
    const retired = Object.hasOwn(RETIRED_RECIPE_KEYS, where) ? RETIRED_RECIPE_KEYS[where] : undefined;
    const near = retired === undefined ? nearestKey(key, known) : null;
    found.push(retired !== undefined ? `${where} (replaced by ${retired})` : near ? `${where} (did you mean ${prefix}${near}?)` : where);
  }
  for (const [key, item] of Object.entries(value)) {
    const child = Object.hasOwn(shape, key) ? shape[key] : undefined;
    if (child) unknownIn(child, item, `${prefix}${key}`, found);
  }
}

/**
 * The keys in a recipe's open sections that the schema doesn't know, each
 * with its path, and with the key that it most likely meant where one is
 * near, or the key that replaced it. It leaves out a key that the load
 * refuses by name, and everything under a custom strategy, which goes whole
 * to its extension. A closed section refuses an unknown key at the load
 * instead.
 */
export function unknownRecipeKeys(raw: unknown): string[] {
  const found: string[] = [];
  unknownIn(recipeSchema, raw, '', found);
  return found;
}

/**
 * The recipe that `raw` holds, as the load gives it: a new object, with
 * `agent.systemPrompt` and `agent.cacheTtl` written where they are left out.
 * It writes one warning line naming the keys that unknownRecipeKeys gives,
 * if it gives any, and notes it for the session's log only where the recipe
 * loads. It throws one error whose message names every fault that one parse
 * can judge, printing values as `origin` allows.
 */
export function validateRecipe(raw: unknown, origin: RecipeOrigin = { kind: 'literal' }): Recipe {
  const unknownKeys = unknownRecipeKeys(raw);
  const named = isPlainObject(raw) && raw.name !== undefined && origin.kind !== 'resolved' ? ` ${printed(raw.name, ['name'], origin)}` : '';
  const warning = unknownKeys.length > 0 ? `Recipe${named} has keys the host does not read (ignored): ${unknownKeys.join(', ')}.` : undefined;
  if (warning !== undefined) console.warn(warning);
  const result = recipeSchema.safeParse(raw, { error: words });
  if (!result.success) throw new Error(faultMessage(result.error.issues, raw, origin, recipeSchema));
  if (warning !== undefined) noteRecipeWarning(warning);
  return result.data;
}

export function parseToolLifecycle(value: unknown, where: string): RecipeToolLifecycle {
  const result = toolLifecycleSchema.safeParse(value, { error: words });
  if (result.success) return result.data;
  throw new Error(faultMessage(result.error.issues, value, { kind: 'literal' }, toolLifecycleSchema, (at) => (at === '' ? where : `${where}.${at}`), where));
}

type PersistentArm = Extract<z.output<typeof subconscious>, { systemPrompt: string }>;
type ForkArm = Extract<z.output<typeof subconscious>, { voice: string }>;

/** The recipe as the load gives it. */
export type Recipe = z.output<typeof recipeSchema>;
export type RecipeAgent = AgentShape;
export type RecipeStrategy = StrategyShape;
export type RecipeKvUnifiedConfig = z.output<typeof kvUnified>;
export type RecipeMcpServer = McpServerShape;
export type RecipeToolLifecycle = z.output<typeof toolLifecycleSchema>;
export type RecipeCredentialFileField = z.output<typeof credentialField>;
export type RecipeModules = ModulesShape;
export type RecipeWebUi = z.output<typeof webui>;
export type RecipeTtsRelay = z.output<typeof ttsRelay>;
export type RecipeFleet = FleetShape;
export type RecipeFleetChild = z.output<typeof fleetChild>;
export type RecipePersistentReader = PersistentArm;
export type RecipeForkReader = ForkArm;
