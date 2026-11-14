import { DEFAULT_AUTOBIOGRAPHICAL_CONFIG, defaultTokenEstimator } from '@animalabs/context-manager';
import { getDefaultModelLimits, type ModelLimits } from './model-limits.js';
import { resolveProvider, type Recipe } from './recipe.js';

const DEFAULT_CONTEXT_BUDGET_TOKENS = 300_000;

const DEFAULT_MAX_TOKENS = 16_384;

const TOOLS_ROOM_TOKENS = 32_000;

const DEFAULT_HEAD_WINDOW_TOKENS = 4000;

const DEFAULT_RECENT_WINDOW_RATIO = 0.4;

export function effectiveMaxTokens(recipe: Recipe): number {
  return recipe.agent.maxTokens ?? DEFAULT_MAX_TOKENS;
}

const isTokenSize = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const isTokenCount = (value: unknown): value is number => isTokenSize(value) && value > 0;

function unreadableTokenField(recipe: Recipe): 'maxTokens' | 'contextBudgetTokens' | undefined {
  const reply: unknown = recipe.agent.maxTokens;
  if (reply !== undefined && reply !== null && !isTokenCount(reply)) return 'maxTokens';
  const budget: unknown = recipe.agent.contextBudgetTokens;
  if (budget !== undefined && budget !== null && !isTokenSize(budget)) return 'contextBudgetTokens';
  return undefined;
}

function modelWindow(recipe: Recipe, model: string): ModelLimits | undefined {
  if (resolveProvider(recipe) !== 'anthropic' || typeof model !== 'string') return undefined;
  return getDefaultModelLimits(model);
}

function fittedWindow(recipe: Recipe, model: string): ModelLimits | undefined {
  return unreadableTokenField(recipe) === undefined ? modelWindow(recipe, model) : undefined;
}

function systemPromptTokens(recipe: Recipe): number {
  return defaultTokenEstimator(recipe.agent.systemPrompt);
}

/** The compile budget the recipe configures: its own, else the default. A
 *  runtime override (agent settings) can still move the live budget. */
export function effectiveContextBudgetTokens(recipe: Recipe, model: string): number {
  if (recipe.agent.contextBudgetTokens !== undefined && recipe.agent.contextBudgetTokens !== null) {
    return recipe.agent.contextBudgetTokens;
  }
  const window = fittedWindow(recipe, model);
  if (!window) return DEFAULT_CONTEXT_BUDGET_TOKENS;
  return defaultBudget(window.maxContextTokens, systemPromptTokens(recipe));
}

function defaultBudget(window: number, system: number): number {
  return Math.min(DEFAULT_CONTEXT_BUDGET_TOKENS, window - system - TOOLS_ROOM_TOKENS);
}

export function headWindowTokens(recipe: Recipe): number {
  return recipe.agent.strategy?.headWindowTokens ?? DEFAULT_HEAD_WINDOW_TOKENS;
}

type Numbers = {
  reply: number;
  replyFloor: number;
  budget: number | undefined;
  raw: boolean;
  head: number;
  ownHead: boolean;
  tail: number | undefined;
  grace: number;
};

const show = (value: unknown) => (typeof value === 'number' ? String(value) : JSON.stringify(value) ?? String(value));

function readNumbers(recipe: Recipe): Numbers | string {
  const unreadable = unreadableTokenField(recipe);
  const notA = (value: unknown) => (typeof value === 'number' ? 'not a finite number' : 'not a number');
  if (unreadable === 'maxTokens') {
    const value: unknown = recipe.agent.maxTokens;
    return `agent.maxTokens is ${show(value)}, ${isTokenSize(value) ? 'not a positive number' : notA(value)} of tokens.`;
  }
  if (unreadable) return `agent.contextBudgetTokens is ${show(recipe.agent.contextBudgetTokens)}, ${notA(recipe.agent.contextBudgetTokens)} of tokens.`;
  const strategy = recipe.agent.strategy;
  const type = strategy?.type ?? 'autobiographical';
  const raw = type === 'autobiographical' || type === 'frontdesk';
  const head: unknown = headWindowTokens(recipe);
  const tail: unknown = strategy?.recentWindowTokens ?? undefined;
  const grace: unknown = strategy?.overBudgetGraceRatio;
  if (raw && !isTokenSize(head)) return `strategy.headWindowTokens is ${show(head)}, ${notA(head)} of tokens.`;
  if (raw && tail !== undefined && !isTokenSize(tail)) {
    return `strategy.recentWindowTokens is ${show(tail)}, ${notA(tail)} of tokens.`;
  }
  if (raw && grace !== undefined && grace !== null && !isTokenSize(grace)) {
    return `strategy.overBudgetGraceRatio is ${show(grace)}, ${notA(grace)}.`;
  }
  const thinking = thinkingOf(recipe);
  return {
    reply: effectiveMaxTokens(recipe),
    replyFloor: thinking === undefined ? 1 : Math.floor(thinking) + 1,
    budget: recipe.agent.contextBudgetTokens ?? undefined,
    raw,
    head: isTokenSize(head) ? Math.max(0, head) : 0,
    ownHead: isTokenSize(strategy?.headWindowTokens),
    tail: isTokenSize(tail) ? Math.max(0, tail) : undefined,
    grace: grace === undefined
      ? (DEFAULT_AUTOBIOGRAPHICAL_CONFIG.overBudgetGraceRatio ?? 0)
      : Math.max(0, isTokenSize(grace) ? grace : 0),
  };
}

const limitOf = (x: Numbers, room: number) => Math.floor(room * (1 + x.grace));

function tailOf(x: Numbers, budget: number): number {
  if (x.tail !== undefined) return x.tail;
  const tail = Math.round(budget * DEFAULT_RECENT_WINDOW_RATIO);
  return x.head + tail > limitOf(x, budget - x.reply)
    ? Math.round(Math.max(0, budget - x.reply) * DEFAULT_RECENT_WINDOW_RATIO)
    : tail;
}

export function defaultRecentWindowTokens(recipe: Recipe, model: string): number {
  const budget = effectiveContextBudgetTokens(recipe, model);
  const x = readNumbers(recipe);
  if (typeof x === 'string') return Math.round(budget * DEFAULT_RECENT_WINDOW_RATIO);
  return tailOf({ ...x, tail: undefined }, budget);
}

type Fit = Numbers & { window: number; maxOutput: number; system: number };

type Problem = 'output' | 'system' | 'room' | 'window';

const budgetOf = (f: Fit) => f.budget ?? defaultBudget(f.window, f.system);

const windowsOf = (f: Fit, budget: number) => (f.raw ? f.head + tailOf(f, budget) : 0);

function roomHolds(f: Fit, budget: number): boolean {
  const room = budget - f.reply;
  return room > 0 && windowsOf(f, budget) <= limitOf(f, room);
}

const promptOf = (f: Fit, budget: number) => Math.max(budget - f.reply, windowsOf(f, budget)) + f.system;

function problemOf(f: Fit): Problem | undefined {
  if (f.reply > f.maxOutput) return 'output';
  if (f.system >= f.window) return 'system';
  const budget = budgetOf(f);
  if (!roomHolds(f, budget)) return 'room';
  if (promptOf(f, budget) > f.window) return 'window';
  return undefined;
}

const fits = (f: Fit) => problemOf(f) === undefined;

function greatest(lo: number, hi: number, ok: (value: number) => boolean): number | undefined {
  lo = Math.ceil(lo);
  hi = Math.min(Math.floor(hi), Number.MAX_SAFE_INTEGER - 1);
  if (hi < lo || !ok(lo)) return undefined;
  while (lo < hi) {
    const mid = lo + Math.ceil((hi - lo) / 2);
    if (ok(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function least(lo: number, hi: number, ok: (value: number) => boolean): number | undefined {
  lo = Math.ceil(lo);
  hi = Math.min(Math.floor(hi), Number.MAX_SAFE_INTEGER - 1);
  if (hi < lo || !ok(hi)) return undefined;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (ok(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

const uncapped = (f: Fit) => {
  const budget = budgetOf(f);
  return f.head + Math.round(budget * DEFAULT_RECENT_WINDOW_RATIO) <= limitOf(f, budget - f.reply);
};

function nearestRange(below: number, at: (value: number) => Fit): [number, number] | undefined {
  const hi = Math.ceil(below) - 1;
  const ok = (value: number) => fits(at(value));
  const capSwitches = at(0).raw && at(0).tail === undefined;
  const last = capSwitches ? greatest(0, hi, (value) => uncapped(at(value))) : undefined;
  const parts: Array<[number, number]> = last === undefined || last >= hi ? [[0, hi]] : [[0, last], [last + 1, hi]];
  const ranges: Array<[number, number]> = [];
  for (const [lo, top] of parts) {
    const end = greatest(lo, top, ok);
    if (end !== undefined) ranges.push([lo, end]);
  }
  if (ranges.length === 2 && ranges[0]![1] + 1 === ranges[1]![0]) return [ranges[0]![0], ranges[1]![1]];
  return ranges[ranges.length - 1];
}

const lowered = ([lo, hi]: [number, number]) =>
  lo === hi ? `to ${n(hi)}` : lo > 0 ? `to between ${n(lo)} and ${n(hi)}` : `to ${n(hi)} or less`;

const LESS_TOOLS = 'less the size of the tools the host sends beside the prompt';

const AT_AN_END = 'At an end of a named range, the compile can have no room left for older history, or the prompt can ' +
  'fill the window, leaving none for the tool definitions the host sends beside it; a recipe there loads and then ' +
  'fails once its conversation fills the compile.';

function full(f: Fit): boolean {
  const budget = budgetOf(f);
  const room = budget - f.reply;
  return (f.raw && (room - windowsOf(f, budget) <= 0 || !roomHolds({ ...f, reply: f.reply + 1 }, budget))) ||
    promptOf(f, budget) > f.window - 1;
}

export type RecipeFit =
  | { checked: false; line: string }
  | { checked: true; fits: true }
  | { checked: true; fits: false; refusal: string };

const n = (value: number) => value.toLocaleString('en-US');

function sentence(options: string[]): string {
  const joined = options.length > 1 ? `${options.slice(0, -1).join('; ')}; or ${options[options.length - 1]}` : options[0]!;
  return `${joined.charAt(0).toUpperCase()}${joined.slice(1)}.`;
}

function waysOut(f: Fit, problem: Problem): { floor: string; ways: string[]; atAnEnd: boolean } {
  const ways: string[] = [];
  let atAnEnd = false;
  const ends = ([lo, hi]: [number, number], at: (value: number) => Fit) => {
    if (full(at(lo)) || full(at(hi))) atAnEnd = true;
  };
  let floor = '';
  const top = Math.floor(f.reply) + f.window;
  const keep = f.budget === undefined ? TOOLS_ROOM_TOKENS : 0;
  const lo = least(Math.floor(f.reply) + 1, top, (budget) => roomHolds(f, budget));
  const most = greatest(Math.floor(f.reply) + 1, top, (budget) => promptOf(f, budget) + keep <= f.window);
  if (lo !== undefined && most !== undefined && lo <= most && fits({ ...f, budget: lo }) && fits({ ...f, budget: most })) {
    const tools = f.budget === undefined
      ? `which leaves ${n(TOOLS_ROOM_TOKENS)} of the window for the tools`
      : LESS_TOOLS;
    const theTail = f.tail === undefined ? 'the verbatim tail that budget gets' : 'the verbatim tail';
    const verb = f.budget === undefined ? 'set agent.contextBudgetTokens' : problem === 'window' ? 'lower the budget' : 'raise the budget';
    if (lo === most) {
      ways.push(`${f.budget === undefined ? verb : 'set the budget'} to ${n(lo)}, ` +
        (f.budget === undefined
          ? `the one whole budget that loads and leaves ${n(TOOLS_ROOM_TOKENS)} of the window for the tools`
          : 'the one whole budget this check accepts, counting no tools') +
        (windowsOf(f, lo) > 0 ? `, where the head and ${theTail} fill the compile and leave older history no room` : ''));
    } else if (problem === 'window') {
      ways.push(`${verb} to ${n(most)} or less, ${tools}, and above ` +
        (f.raw ? `${n(lo)}, which the head and ${theTail} fill alone` : 'agent.maxTokens'));
    } else {
      if (f.raw) floor = `A budget of ${n(lo)} holds the head and ${theTail}${f.tail === undefined ? '' : ' alone'}. `;
      ways.push(f.raw
        ? `${verb} above that, so older history has room beside them, and to no more than ${n(most)}, ${tools}`
        : `${verb} above agent.maxTokens, to no more than ${n(most)}, ${tools}`);
    }
  }
  const replyOk = (reply: number) => reply <= f.maxOutput && roomHolds({ ...f, reply }, budgetOf({ ...f, reply }));
  const replyHi = greatest(f.replyFloor, Math.ceil(f.reply) - 1, replyOk);
  if (replyHi !== undefined && fits({ ...f, reply: replyHi })) {
    const replyLo = least(f.replyFloor, replyHi, (reply) => fits({ ...f, reply }))!;
    ends([replyLo, replyHi], (reply) => ({ ...f, reply }));
    ways.push(`lower agent.maxTokens ${lowered([replyLo === 1 ? 0 : replyLo, replyHi])}`);
  }
  if (f.raw && f.tail !== undefined) {
    const range = nearestRange(f.tail, (tail) => ({ ...f, tail }));
    if (range) {
      ends(range, (tail) => ({ ...f, tail }));
      ways.push(`lower strategy.recentWindowTokens ${lowered(range)}`);
    }
  }
  if (f.raw && f.ownHead) {
    const range = nearestRange(f.head, (head) => ({ ...f, head }));
    if (range) {
      ends(range, (head) => ({ ...f, head }));
      ways.push(`lower strategy.headWindowTokens ${lowered(range)}`);
    }
  }
  const system = nearestRange(f.system, (value) => ({ ...f, system: value }));
  if (system) {
    ends(system, (value) => ({ ...f, system: value }));
    const [from, to] = system;
    const atTop = { ...f, system: to };
    const tools = f.budget !== undefined && to > 0 && promptOf(atTop, budgetOf(atTop)) > f.window - 1
      ? `, ${LESS_TOOLS}` : '';
    ways.push((to === 0 ? 'empty the system prompt'
      : from === to ? `shorten the system prompt to about ${n(to)} tokens`
      : from > 0 ? `shorten the system prompt to between about ${n(from)} and ${n(to)} tokens`
      : `shorten the system prompt to about ${n(to)} tokens or fewer`) + tools);
  }
  return { floor, ways, atAnEnd };
}

function thinkingOf(recipe: Recipe): number | undefined {
  const thinking: unknown = recipe.agent.thinking?.enabled === true ? recipe.agent.thinking.budgetTokens : undefined;
  return isTokenCount(thinking) ? thinking : undefined;
}

function capOutput(recipe: Recipe, most: number): string {
  const thinking = thinkingOf(recipe);
  if (thinking === undefined) return ` Set it to ${n(most)} or less.`;
  if (thinking >= most) return '';
  const least = Math.floor(thinking) + 1;
  return ` Set it to ${least === most ? n(most) : `between ${n(least)} and ${n(most)}`}.`;
}

export function recipeFit(recipe: Recipe, model: string): RecipeFit {
  const notChecked = (reason: string): RecipeFit => ({
    checked: false,
    line: `[fit] Not checked: whether agent.contextBudgetTokens and agent.maxTokens fit ${String(model)}'s window. ` +
      reason +
      (recipe.agent.contextBudgetTokens === undefined || recipe.agent.contextBudgetTokens === null
        ? ` With agent.contextBudgetTokens unset, the budget is ${n(effectiveContextBudgetTokens(recipe, model))}.`
        : ''),
  });
  const window = modelWindow(recipe, model);
  if (!window) {
    const provider = resolveProvider(recipe);
    return notChecked(provider === 'anthropic'
      ? `The host has no window for ${show(model)}.`
      : `The host knows windows only on provider "anthropic", and this recipe's is "${provider}".`);
  }
  const maxTokens: unknown = recipe.agent.maxTokens ?? DEFAULT_MAX_TOKENS;
  const thinking = thinkingOf(recipe);
  const overOutput = (value: number) => `Recipe agent.maxTokens (${n(value)}) is over ${model}'s maximum output of ` +
    `${n(window.maxOutputTokens)} tokens, which Anthropic's API refuses on every reply.` +
    (thinking !== undefined && thinking >= window.maxOutputTokens
      ? ` Recipe agent.thinking.budgetTokens (${n(thinking)}) is at or above that maximum, and the loader requires ` +
        `agent.maxTokens above it, so agent.maxTokens can't come within the maximum until the thinking budget is ` +
        `below ${n(window.maxOutputTokens)}.`
      : '');
  const numbers = readNumbers(recipe);
  if (typeof numbers === 'string') {
    if (!isTokenCount(maxTokens) || maxTokens <= window.maxOutputTokens) return notChecked(numbers);
    return {
      checked: true,
      fits: false,
      refusal: `${overOutput(maxTokens)}${capOutput(recipe, window.maxOutputTokens)} The rest of the fit isn't ` +
        `checked: ${numbers}`,
    };
  }
  const f: Fit = {
    ...numbers, window: window.maxContextTokens, maxOutput: window.maxOutputTokens, system: systemPromptTokens(recipe),
  };
  const problem = problemOf(f);
  if (problem === undefined) return { checked: true, fits: true };
  const budget = budgetOf(f);
  const room = budget - f.reply;
  const tail = tailOf(f, budget);
  const windows = `the ${n(f.head)}-token head and the ${n(tail)}-token verbatim tail`;
  const W = `${model}'s window of ${n(f.window)} tokens`;
  let facts: string;
  if (problem === 'output') {
    facts = overOutput(f.reply);
  } else if (problem === 'system') {
    facts = `Recipe agent.systemPrompt is about ${n(f.system)} tokens, which by itself fills ${W}.`;
  } else if (problem === 'room' && f.budget === undefined) {
    facts = `Recipe agent.systemPrompt is about ${n(f.system)} tokens, which leaves the conversation ` +
      (room > 0 ? `${n(room)} tokens, fewer than ${windows} need, so every reply fails once the conversation fills them,`
        : 'no room') +
      ` in ${W} once ${n(TOOLS_ROOM_TOKENS)} are kept for the tools and agent.maxTokens (${n(f.reply)}) for the reply.`;
  } else if (problem === 'room') {
    facts = `Recipe agent.contextBudgetTokens (${n(budget)}) ` + (room > 0
      ? `leaves the conversation ${n(room)} tokens once agent.maxTokens (${n(f.reply)}) is kept for the reply, ` +
        `fewer than ${windows} need, so every reply fails once the conversation fills them.`
      : `is no more than agent.maxTokens (${n(f.reply)}), which the host keeps out of the budget for the reply, ` +
        `so the conversation gets no room and every reply fails.`);
  } else {
    facts = (f.budget === undefined ? `The budget the host gives this recipe, ${n(budget)},`
      : `Recipe agent.contextBudgetTokens (${n(budget)})`) + ` lets a turn's prompt reach ${n(promptOf(f, budget))} ` +
      `tokens, over ${W}, and Anthropic's API refuses every prompt over the window. The host compiles the ` +
      `conversation up to the budget less agent.maxTokens (${n(f.reply)})` +
      (f.raw && f.head + tail > room ? `, or to ${windows} where they come to more` : '') +
      `, and the system prompt (about ${n(f.system)}) comes on top.`;
  }
  const { floor, ways, atAnEnd } = waysOut(f, problem);
  const lower = ['agent.maxTokens',
    ...(f.raw && f.tail !== undefined ? ['strategy.recentWindowTokens'] : []),
    ...(f.raw && f.ownHead ? ['strategy.headWindowTokens'] : [])];
  const lowerList = lower.length > 1 ? `${lower.slice(0, -1).join(', ')} or ${lower[lower.length - 1]}` : lower[0];
  return {
    checked: true,
    fits: false,
    refusal: `${facts} ${floor}` + (ways.length
      ? sentence(ways) + (atAnEnd ? ` ${AT_AN_END}` : '')
      : `No budget, no lower ${lowerList}, and no shorter system prompt fits it alone.`),
  };
}
