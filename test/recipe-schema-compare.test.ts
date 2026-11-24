import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { unknownRecipeKeys as unknownKeysToday, validateRecipe } from '../src/recipe.js';
import { substituteEnvVars } from '../src/recipe-document.js';
import { parseRecipe, unknownRecipeKeys } from '../src/recipe-schema.js';
import { DELETE, everySetting, variants } from './fixtures/recipe-schema/every-setting.js';

type Path = readonly (string | number)[];
type Outcome = { readonly loads: true; readonly recipe: unknown; readonly keys: string[] } | { readonly loads: false; readonly message: string; readonly keys: string[] };

const warnedPath = (warning: string): string => warning.replace(/ \(.*\)$/, '');

function today(input: unknown): Outcome {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const keys = unknownKeysToday(input).map(warnedPath);
    try {
      return { loads: true, recipe: validateRecipe(structuredClone(input)), keys };
    } catch (err) {
      return { loads: false, message: err instanceof Error ? err.message : String(err), keys };
    }
  } finally {
    console.warn = warn;
  }
}

function bySchema(input: unknown): Outcome {
  const keys = unknownRecipeKeys(input).map(warnedPath);
  try {
    return { loads: true, recipe: parseRecipe(structuredClone(input)), keys };
  } catch (err) {
    return { loads: false, message: err instanceof Error ? err.message : String(err), keys };
  }
}

const RECORD_PARENTS: Readonly<Record<string, string>> = {
  mcpServers: 'ID', extensions: 'NAME', env: 'KEY', kinds: 'KEY', toolClassOverrides: 'KEY', scopes: 'KEY',
};

function pattern(path: Path): string {
  return path.map((key, i) => {
    if (typeof key === 'number' || /^\d+$/.test(key)) return '[]';
    const parent = path[i - 1];
    return typeof parent === 'string' && Object.hasOwn(RECORD_PARENTS, parent) ? RECORD_PARENTS[parent] : key;
  }).join('.').replace(/\.\[\]/g, '[]');
}

const UNCHECKED_TODAY = new Set([
  'description', 'version',
  'agent.name', 'agent.model', 'agent.formatter', 'agent.prefillUserMessage', 'agent.maxTokens', 'agent.anthropicBetas',
  'agent.cacheKeepalive.enabled',
  'agent.strategy', 'agent.strategy.headWindowTokens', 'agent.strategy.recentWindowTokens', 'agent.strategy.compressionModel',
  'agent.strategy.compressionMaxTokens', 'agent.strategy.maxMessageTokens', 'agent.strategy.overBudgetGraceRatio',
  'agent.strategy.enforceBudget', 'agent.strategy.maxSpeculativeL1s', 'agent.strategy.positionedRecallPairs',
  'agent.strategy.recallHeaderTemplate', 'agent.strategy.targetChunkTokens', 'agent.strategy.mergeThreshold',
  'agent.strategy.mergeMaxSourceSpanMessages', 'agent.strategy.summaryTargetTokens', 'agent.strategy.productionBudgetTokens',
  'agent.strategy.l1BudgetTokens', 'agent.strategy.l2BudgetTokens', 'agent.strategy.l3BudgetTokens',
  'agent.strategy.toolResultMaxLastN', 'agent.strategy.toolUseInputMaxTokens', 'agent.strategy.adaptiveResolution',
  'agent.strategy.kvStableReachTokens', 'agent.strategy.kvStableQualityGapRatio', 'agent.strategy.compressionSlackRatio',
  'agent.strategy.speculativeProduction', 'agent.strategy.l1HoldbackChunks', 'agent.strategy.summaryParticipant',
  'agent.strategy.summarySystemPrompt', 'agent.strategy.summaryUserPrompt', 'agent.strategy.summaryContextLabel',
  'agent.strategy.witnessedBeforeSequence', 'agent.strategy.witnessedInstruction', 'agent.strategy.identityReminder',
  'agent.strategy.witnessedIdentityReminder',
  'agent.refusalHandling.retries', 'agent.refusalHandling.maxRewinds', 'agent.refusalHandling.announceHumanTurns',
  'mcpServers', 'mcpServers.ID.env', 'mcpServers.ID.transport', 'mcpServers.ID.token', 'mcpServers.ID.access',
  'mcpServers.ID.toolPrefix', 'mcpServers.ID.enabledFeatureSets', 'mcpServers.ID.disabledFeatureSets', 'mcpServers.ID.reconnect',
  'mcpServers.ID.reconnectIntervalMs', 'mcpServers.ID.reconnectMaxIntervalMs', 'mcpServers.ID.channelSubscription',
  'mcpServers.ID.source.url', 'mcpServers.ID.source.npm',
  'mcpServers.ID.protocol', 'mcpServers.ID.tokenTransport', 'mcpServers.ID.credentialRequired', 'mcpServers.ID.allowHostCommands',
  'mcpServers.ID.enabledCapabilities', 'mcpServers.ID.disabledCapabilities', 'mcpServers.ID.scopes', 'mcpServers.ID.scopes.KEY',
  'mcpServers.ID.scopes.KEY.whitelist', 'mcpServers.ID.scopes.KEY.blacklist', 'mcpServers.ID.autofetch',
  'mcpServers.ID.autofetch.maxBytes', 'mcpServers.ID.autofetch.maxTotalBytes',
  'modules.subagents', 'modules.subagents.defaultModel', 'modules.subagents.defaultMaxTokens',
  'modules.lessons',
  'modules.retrieval.model', 'modules.retrieval.maxInjected',
  'modules.wake',
  'modules.activity', 'modules.activity.channels',
  'modules.mcplAdmin', 'modules.mcplAdmin.surface',
  'modules.identity', 'modules.identity.home', 'modules.identity.audience',
  'modules.fleet', 'modules.fleet.children[].dataDir', 'modules.fleet.children[].env', 'modules.fleet.children[].autoRestart',
  'modules.webui', 'modules.webui.port', 'modules.webui.host', 'modules.webui.observersSurface',
  'modules.webui.basicAuth.username', 'modules.webui.basicAuth.password',
  'modules.ttsRelay.botId', 'modules.ttsRelay.userId', 'modules.ttsRelay.username', 'modules.ttsRelay.reconnectIntervalMs',
  'modules.ttsRelay.notifyOnInterruption',
  'modules.subscriptionGc', 'modules.subscriptionGc.defaultLimitChars', 'modules.subscriptionGc.serverId', 'modules.subscriptionGc.toolPrefix',
  'modules.channelMode', 'modules.channelMode.serverId', 'modules.channelMode.toolPrefix', 'modules.channelMode.gcModuleName',
  'modules.channelMode.defaultDebounceMs',
  'sessionNaming', 'sessionNaming.examples',
]);

const ELEMENTS_UNCHECKED_TODAY = new Set([
  'agent.anthropicBetas[]', 'agent.strategy.toolResultMaxLastN.snapshot', 'mcpServers.ID.channelSubscription[]',
  'mcpServers.ID.enabledFeatureSets[]', 'mcpServers.ID.disabledFeatureSets[]', 'modules.activity.channels[]',
  'modules.fleet.children[].subscription[]', 'modules.webui.allowedOrigins[]', 'sessionNaming.examples[]',
  'mcpServers.ID.enabledCapabilities[]', 'mcpServers.ID.disabledCapabilities[]', 'mcpServers.ID.scopes.KEY.whitelist[]',
  'mcpServers.ID.scopes.KEY.blacklist[]',
]);

const TEXT_NUMBER_OR_BOOLEAN = new Set(['mcpServers.ID.args[]', 'mcpServers.ID.env.KEY', 'modules.fleet.children[].env.KEY']);
const NOT_TEXT_NUMBER_OR_BOOLEAN = ['= null', '= []', '= {}'];

const NULL_KEEPS_ITS_MEANING = new Set(['agent.contextBudgetTokens', 'modules.webui.basicAuth', 'modules.webui.allowedOrigins']);

const LOOSE_CHECK_TODAY: Readonly<Record<string, readonly string[]>> = {
  agent: ['= []'],
  'agent.cacheKeepalive': ['= []'],
  'agent.strategy.type': ['= 0', '= ""', '= false'],
  'agent.refusalHandling': ['= 0', '= ""'],
  'mcpServers.ID': ['= []'],
};

const CHECKED_TODAY_UNDER_ONE_BRANCH: Readonly<Record<string, readonly string[]>> = {
  'agent.strategy.maxLiveImages': ['passthrough', 'customStrategy'],
  'agent.strategy.imageStripDepthTokens': ['passthrough', 'customStrategy'],
  'agent.strategy.maxLiveImageBytes': ['passthrough', 'customStrategy'],
  'agent.strategy.type': ['customStrategy'],
  ...Object.fromEntries(['yieldMs', 'maxYieldMs', 'scriptLifetimeMs', 'maxRunningScripts', 'maxScriptChildren', 'toolCallTimeoutMs',
    'wakeMinIntervalMs', 'maxWakesPerScript', 'memoryMaxBytes'].map((key) => [`codeExecution.${key}`, ['codeExecutionOff']])),
};

const REQUIRED_BY_THE_SCHEMA = new Set(['modules.webui.basicAuth.username', 'modules.webui.basicAuth.password']);

function newlyRefused(at: string, change: string, variant: string): boolean {
  if (change === 'removed') return REQUIRED_BY_THE_SCHEMA.has(at);
  if (change === 'unknown key') return at === 'mcpServers.ID.scopes';
  return UNCHECKED_TODAY.has(at) || ELEMENTS_UNCHECKED_TODAY.has(at)
    || (TEXT_NUMBER_OR_BOOLEAN.has(at) && NOT_TEXT_NUMBER_OR_BOOLEAN.includes(change))
    || (NULL_KEEPS_ITS_MEANING.has(at) && change !== '= null')
    || (LOOSE_CHECK_TODAY[at]?.includes(change) ?? false)
    || (CHECKED_TODAY_UNDER_ONE_BRANCH[at]?.includes(variant) ?? false);
}

const NEWLY_WARNING_OBJECTS = new Set([
  'agent.cacheKeepalive', 'agent.strategy', 'agent.thinking', 'agent.responses', 'agent.codex', 'agent.refusalHandling',
  'codeExecution', 'mcpServers.ID', 'mcpServers.ID.source', 'mcpServers.ID.source.install', 'mcpServers.ID.source.inContainer',
  'mcpServers.ID.credentialFiles[]', 'mcpServers.ID.credentialFiles[].fields[]', 'modules.subagents', 'modules.retrieval',
  'modules.wake', 'modules.activity', 'modules.mcplAdmin', 'modules.identity', 'modules.fleet', 'modules.fleet.children[]',
  'modules.webui', 'modules.webui.basicAuth', 'modules.ttsRelay', 'modules.subscriptionGc', 'modules.channelMode',
  'extensions.NAME', 'sessionNaming', 'mcpServers.ID.scopes.KEY', 'mcpServers.ID.autofetch',
]);

const parentOf = (warned: string): string => pattern(warned.replace(/\[(\d+)\]/g, '.$1').split('.').slice(0, -1));

function differences(input: unknown, at: string, change: string, variant: string): string[] {
  const was = today(input);
  const now = bySchema(input);
  const found: string[] = [];
  if (was.loads && now.loads && !isDeepStrictEqual(was.recipe, now.recipe)) found.push(`P1 ${at} ${change}: the parsed recipe differs`);
  if (was.loads && !now.loads && !newlyRefused(at, change, variant)) found.push(`P1 ${at} ${change}: refused: ${now.message}`);
  if (!was.loads && now.loads) found.push(`P2 ${at} ${change}: loads, and today refuses: ${was.message}`);
  for (const key of was.keys) if (!now.keys.includes(key)) found.push(`P3 ${at} ${change}: no longer warns of ${key}`);
  for (const key of now.keys) {
    if (!was.keys.includes(key) && !NEWLY_WARNING_OBJECTS.has(parentOf(key))) found.push(`P3 ${at} ${change}: newly warns of ${key}`);
  }
  return found;
}

function withEdit(root: unknown, path: Path, value: unknown): unknown {
  const copy = structuredClone(root);
  let parent: unknown = copy;
  for (const key of path.slice(0, -1)) parent = (parent as Record<string | number, unknown>)[key];
  const last = path[path.length - 1]!;
  if (Array.isArray(parent) && value === DELETE) parent.splice(Number(last), 1);
  else if (value === DELETE) delete (parent as Record<string | number, unknown>)[last];
  else (parent as Record<string | number, unknown>)[last] = structuredClone(value);
  return copy;
}

function nodes(value: unknown, path: Path = []): Path[] {
  if (Array.isArray(value)) return [path, ...value.flatMap((item, i) => nodes(item, [...path, i]))];
  if (value !== null && typeof value === 'object') return [path, ...Object.entries(value).flatMap(([k, item]) => nodes(item, [...path, k]))];
  return [path];
}

const WRONG_VALUES: readonly (readonly [string, unknown])[] = [
  ['null', null], ['7', 7], ['0', 0], ['"zz"', 'zz'], ['""', ''], ['true', true], ['false', false], ['[]', []], ['{}', {}],
];

function variantRecipe(name: string): unknown {
  return (variants[name] ?? []).reduce<unknown>((recipe, [path, value]) => withEdit(recipe, path.split('.'), value), everySetting);
}

describe('the schema against today\'s validateRecipe, for each setting of a recipe that sets every one', () => {
  for (const variant of Object.keys(variants)) {
    const recipe = variantRecipe(variant);
    const sections = Object.keys(recipe as object);
    test(`${variant}: the recipe itself, and an unknown key at its top`, () => {
      expect([
        ...differences(recipe, '(whole)', 'none', variant),
        ...differences(withEdit(recipe, ['zzUnknown'], 1), '(top)', 'unknown key', variant),
      ]).toEqual([]);
    });
    const NODES_PER_TEST = 20;
    const groups = sections.flatMap((section): { name: string; paths: Path[] }[] => {
      const value = (recipe as Record<string, unknown>)[section];
      if (value === null || typeof value !== 'object') return [{ name: section, paths: [[section]] }];
      return [
        { name: section, paths: [[section]] },
        ...Object.entries(value).flatMap(([key, child]) => {
          const paths = nodes(child, [section, Array.isArray(value) ? Number(key) : key]);
          return Array.from({ length: Math.ceil(paths.length / NODES_PER_TEST) }, (_, i) => ({
            name: `${section}.${key}${paths.length > NODES_PER_TEST ? ` (part ${i + 1})` : ''}`,
            paths: paths.slice(i * NODES_PER_TEST, (i + 1) * NODES_PER_TEST),
          }));
        }),
      ];
    });
    for (const group of groups) {
      test(`${variant}: each value in ${group.name} replaced by a wrong one, removed, or beside an unknown key`, () => {
        const found: string[] = [];
        for (const path of group.paths) {
          const at = pattern(path);
          for (const [label, wrong] of WRONG_VALUES) found.push(...differences(withEdit(recipe, path, wrong), at, `= ${label}`, variant));
          found.push(...differences(withEdit(recipe, path, DELETE), at, 'removed', variant));
          const here = path.reduce<unknown>((value, key) => (value as Record<string | number, unknown>)[key], recipe);
          if (here !== null && typeof here === 'object' && !Array.isArray(here)) {
            found.push(...differences(withEdit(recipe, [...path, 'zzUnknown'], 1), at, 'unknown key', variant));
          }
        }
        expect(found).toEqual([]);
      });
    }
  }
});

const shippedDir = join(import.meta.dir, '..', 'recipes');
const anyValue = new Proxy({}, { get: () => 'value' });

describe('the schema against today\'s validateRecipe, for the recipes this repository ships', () => {
  for (const file of readdirSync(shippedDir).filter((f) => f.endsWith('.json'))) {
    test(file, () => {
      const raw: unknown = JSON.parse(readFileSync(join(shippedDir, file), 'utf8'));
      const input = substituteEnvVars(raw, file, anyValue);
      expect(differences(input, file, 'as shipped', 'shipped')).toEqual([]);
      expect(bySchema(input).loads).toBe(true);
      expect(bySchema(input).keys).toEqual([]);
    });
  }
});

function decoded(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decoded);
  if (value === null || typeof value !== 'object') return value;
  const entries = Object.entries(value);
  if (entries.length === 1) {
    const [key, inner] = entries[0]!;
    if (key === '$u' && inner === 1) return undefined;
    if (key === '$f' && inner === 1) return () => {};
    if (key === '$n' && typeof inner === 'string') return Number(inner);
  }
  return Object.fromEntries(entries.map(([key, inner]) => [key, decoded(inner)]));
}

const NEWLY_REFUSABLE = new Set([
  ...UNCHECKED_TODAY, ...ELEMENTS_UNCHECKED_TODAY, ...TEXT_NUMBER_OR_BOOLEAN, ...NULL_KEEPS_ITS_MEANING,
  ...Object.keys(LOOSE_CHECK_TODAY), ...Object.keys(CHECKED_TODAY_UNDER_ONE_BRANCH),
]);

const faultPaths = (message: string): string[] =>
  [...message.matchAll(/Recipe ([A-Za-z0-9_.[\]-]+) /g)].map((m) => pattern(m[1]!.replace(/\[(\d+)\]/g, '.$1').split('.')));

describe('the schema against today\'s validateRecipe, for the inputs that the suite gave validateRecipe', () => {
  const suite: unknown[] = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'recipe-schema', 'suite-inputs.json'), 'utf8'));
  const BATCH = 100;
  for (let start = 0; start < suite.length; start += BATCH) {
    test(`inputs ${start} to ${Math.min(start + BATCH, suite.length) - 1}`, () => {
      const found: string[] = [];
      for (const [i, item] of suite.slice(start, start + BATCH).entries()) {
        const input = decoded(item);
        const was = today(input);
        const now = bySchema(input);
        const at = `input ${start + i}`;
        if (was.loads && now.loads && !isDeepStrictEqual(was.recipe, now.recipe)) found.push(`P1 ${at}: the parsed recipe differs`);
        if (was.loads && !now.loads && !faultPaths(now.message).every((p) => NEWLY_REFUSABLE.has(p))) {
          found.push(`P1 ${at}: refused: ${now.message}`);
        }
        if (!was.loads && now.loads) found.push(`P2 ${at}: loads, and today refuses: ${was.message}`);
        for (const key of was.keys) if (!now.keys.includes(key)) found.push(`P3 ${at}: no longer warns of ${key}`);
        for (const key of now.keys) {
          if (!was.keys.includes(key) && !NEWLY_WARNING_OBJECTS.has(parentOf(key))) found.push(`P3 ${at}: newly warns of ${key}`);
        }
      }
      expect(found).toEqual([]);
    });
  }
});
