import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModuleContext } from '@animalabs/agent-framework';
import { runningFit, substituteEnvVars, validateRecipe } from '../src/recipe.js';
import { takeRecipeWarnings } from '../src/recipe-warnings.js';
import { isRecipeSetting, nearestKey, settingFault, settingTakes } from '../src/recipe-schema.js';
import { buildFrameworkAgentConfig } from '../src/framework-agent-config.js';
import { dendriteCreateOptions } from '../src/framework-strategy.js';
import { SettingsModule } from '../src/modules/settings-module.js';
import {
  checkOwnSettings, ownSettingsAnswer, ownSettingsLines, startOwnSettings, valueAt, type OperatorRecipe, type RunningAgent,
} from '../src/own-settings.js';
import { OWN_SETTING_NAMES, OWN_SETTINGS, OWN_SETTINGS_MAX_BYTES, ownSettingsWarnings } from '../src/own-settings-table.js';
import { everySetting } from './fixtures/recipe-schema/every-setting.js';

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

function dataDir(files: { own?: unknown; parked?: unknown } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'chost-own-settings-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'own-settings'));
  const write = (name: string, content: unknown) =>
    writeFileSync(join(dir, 'own-settings', name), typeof content === 'string' ? content : JSON.stringify(content));
  if (files.own !== undefined) write('own.json', files.own);
  if (files.parked !== undefined) write('own.not-used.json', files.parked);
  return dir;
}

const ownFile = (dir: string, name = 'own.json'): string => join(dir, 'own-settings', name);

function operator(document: Record<string, unknown>, env: Record<string, string> = {}): OperatorRecipe {
  const written = { name: 'Ember', ...document, agent: { name: 'ember', model: 'claude-opus-4-6', systemPrompt: 'hi', ...(document.agent as object) } };
  const persistable = structuredClone(written);
  const origin = { kind: 'authored' as const, document: persistable };
  return { recipe: validateRecipe(substituteEnvVars(written, 'recipe.json', env), origin), origin };
}

const running: RunningAgent = { name: 'ember', proseRouting: undefined, restartOffered: true };
const answer = (op: OperatorRecipe, dir: string, start = startOwnSettings(op, dir).check) =>
  ownSettingsAnswer({ operator: op, start, dataDir: dir, running });

const quietly = <T>(work: () => T): T => {
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    return work();
  } finally {
    warn.mockRestore();
  }
};

const GOOD: Readonly<Record<string, unknown>> = Object.fromEntries(OWN_SETTINGS.map((setting) => [setting.name, setting.example]));

function without(document: unknown, path: readonly string[]): unknown {
  const [key, ...rest] = path;
  if (key === undefined || typeof document !== 'object' || document === null || !(key in document)) return document;
  const { [key]: inner, ...others } = document as Record<string, unknown>;
  return rest.length === 0 ? others : { ...others, [key]: without(inner, rest) };
}

function withValue(document: unknown, path: readonly string[], value: unknown): unknown {
  const [key, ...rest] = path;
  if (key === undefined) return value;
  const section: Record<string, unknown> = typeof document === 'object' && document !== null ? { ...document } : {};
  return { ...section, [key]: withValue(section[key], rest, value) };
}

const EVERY_MODULE = {
  subconscious: { enabled: true, reader: 'persistent', systemPrompt: 'read' },
  modules: { retrieval: true, lessons: true, subagents: true, ttsRelay: { url: 'ws://127.0.0.1:8800/bot', token: 't' }, wake: true },
};

describe('the table', () => {
  test('each name of the table is a path of the recipe schema, the schema says what it takes, and its example passes', () => {
    expect(OWN_SETTING_NAMES).toHaveLength(23);
    for (const setting of OWN_SETTINGS) {
      expect(isRecipeSetting(setting.name)).toBe(true);
      expect(settingTakes(setting.name)).toEqual(expect.any(String));
      expect([setting.name, settingFault(setting.name, setting.example)]).toEqual([setting.name, undefined]);
    }
    expect(settingTakes('agent.proseRouting')).toBe('"locus", "explicit", "hybrid", "disabled" or "locked"');
  });
});

describe('the schema\'s helpers', () => {
  test('a field in any arm of a union is a setting, and the nearest name ignores no candidate within reach', () => {
    expect(isRecipeSetting('subconscious.voice')).toBe(true);
    expect(isRecipeSetting('subconscious.systemPrompt')).toBe(true);
    expect(isRecipeSetting('subconscious.nothing')).toBe(false);
    expect(nearestKey('abc', ['a'])).toBe('a');
    expect(nearestKey('x'.repeat(100), ['a'])).toBeNull();
  });
});

describe('the fit check', () => {
  test('gives the same result with one example value of each setting of the table (case 29)', () => {
    const base = { ...EVERY_MODULE, agent: { contextBudgetTokens: 150_000 } };
    const fitOf = (document: Record<string, unknown>) => runningFit(operator(document).recipe, undefined);
    expect(fitOf(base).checked).toBe(true);
    for (const [name, value] of Object.entries(GOOD)) {
      const [key = '', ...rest] = name.split('.');
      const document = { ...base, [key]: withValue(Object.entries(base).find(([k]) => k === key)?.[1], rest, value) };
      expect([name, fitOf(document)]).toEqual([name, fitOf(base)]);
    }
  });
});

describe('the recipe key', () => {
  test('a name in the list that is not in the table is refused, naming the nearest (case 24)', () => {
    expect(() => operator({ ownSettings: ['agent.timezon'] }))
      .toThrow('Recipe ownSettings[0] must be a setting that a resident may manage (did you mean "agent.timezone"?), got "agent.timezon".');
  });

  test('an empty list is refused', () => {
    expect(() => operator({ ownSettings: [] })).toThrow('Recipe ownSettings must be "all", "read" or a non-empty list of setting names');
  });

  test('a recipe mount named _settings is refused beside the key, and loads without it (case 23)', () => {
    const workspace = { mounts: [{ name: '_settings', path: '/tmp/x' }] };
    expect(() => operator({ ownSettings: 'read', modules: { workspace } }))
      .toThrow('Recipe modules.workspace.mounts[0] is named "_settings", the name of the host\'s own mount');
    expect(() => operator({ modules: { workspace } })).not.toThrow();
  });

  test('a listed setting that does nothing here draws a warning; "all" and "read" draw none (case 11)', () => {
    const passthrough = { agent: { strategy: { type: 'passthrough' } } };
    expect(ownSettingsWarnings(quietly(() => operator({ ...passthrough, ownSettings: ['agent.strategy.maxLiveImages'] })).recipe))
      .toEqual(['Recipe ownSettings names agent.strategy.maxLiveImages, which does nothing on this host: it takes effect only ' +
        'with the strategy "autobiographical" or "frontdesk".']);
    expect(ownSettingsWarnings(operator({ ...passthrough, ownSettings: 'all' }).recipe)).toEqual([]);
    expect(ownSettingsWarnings(operator({ ...passthrough, ownSettings: 'read' }).recipe)).toEqual([]);
  });

  test('the start\'s log gives those warnings, and the load writes none of them', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const op = operator({ ownSettings: ['tuneOut.announce'] });
      expect(warn.mock.calls).toEqual([]);
      expect(startOwnSettings(op, dataDir()).log).toEqual(['[own-settings] Recipe ownSettings names tuneOut.announce, which does nothing ' +
        'on this host: it takes effect only with a reader (subconscious) on.']);
    } finally {
      warn.mockRestore();
    }
  });

  test('a reader that is switched off makes tuneOut.announce not available', () => {
    const subconscious = { ...EVERY_MODULE.subconscious, enabled: false };
    const start = startOwnSettings(operator({ ownSettings: 'all', subconscious }), dataDir({ own: { 'tuneOut.announce': true } }));
    expect(start.check.entries[0]!.notUsed?.kind).toBe('not-available');
    expect(start.check.recipe.tuneOut).toBeUndefined();
  });

  test('an allowlist that leaves out what the grant needs draws a warning naming each tool (case 26)', () => {
    const allowed = (ownSettings: unknown, allowedTools: string[], modules?: object) =>
      ownSettingsWarnings(quietly(() => operator({ ownSettings, agent: { allowedTools }, ...(modules ? { modules } : {}) })).recipe);
    expect(allowed('read', ['think'])).toEqual(['Recipe agent.allowedTools leaves out settings--own, which ownSettings needs: ' +
      'settings--own shows the resident its settings. Add it to the list.']);
    expect(allowed(['agent.timezone'], ['think'])).toEqual(['Recipe agent.allowedTools leaves out settings--own and ' +
      'workspace--write, which ownSettings needs: settings--own shows the resident its settings, and workspace--write writes ' +
      'its settings file. Add them to the list.']);
    expect(allowed(['agent.timezone'], ['think'], { workspace: false })[0]).toStartWith('Recipe agent.allowedTools leaves out settings--own, which');
    expect(allowed('all', ['settings--own', 'workspace--write'])).toEqual([]);
  });
});

describe('what a start does with the file', () => {
  test('no key: the recipe in force is the operator\'s, and a file there is parked after its note (case 1, 16, 30)', () => {
    const op = operator({ agent: { proseRouting: 'locus' } });
    const dir = dataDir({ own: { 'agent.proseRouting': 'explicit' } });
    const start = startOwnSettings(op, dir);
    expect(start.check.recipe.agent.proseRouting).toBe('locus');
    expect(start.note).toStartWith('Your operator\'s recipe no longer lets you change your own settings, so the recipe\'s values are in ' +
      'force, and the host parks your settings file');
    expect(start.note).not.toContain('settings--own');
    expect(readdirSync(join(dir, 'own-settings'))).toEqual(['own.json']);
    const failedBefore = startOwnSettings(op, dir);
    expect([failedBefore.move, failedBefore.note]).toEqual([start.move, start.note]);
    expect(start.moveFile()).toBe(`[own-settings] The host moved ${ownFile(dir)} to ${ownFile(dir, 'own.not-used.json')}.`);
    expect(JSON.parse(readFileSync(ownFile(dir, 'own.not-used.json'), 'utf-8'))).toEqual({ 'agent.proseRouting': 'explicit' });
    const again = startOwnSettings(op, dir);
    expect([again.move, again.note, again.moveFile()]).toEqual([null, undefined, null]);
  });

  test('an own-settings that is a file stops no start, and the tool and doctor say why', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chost-own-settings-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'own-settings'), 'not a directory');
    const op = operator({ ownSettings: 'all' });
    const start = startOwnSettings(op, dir);
    expect(start.check.recipe).toEqual(op.recipe);
    expect(start.note).toStartWith('The host did not use your settings file _settings/own.json at this start: it can\'t be read: a part of its path on the host is not a directory.');
    expect(answer(op, dir)).toContain('The next start does not use it: it can\'t be read: a part of its path on the host is not a directory.');
    expect(ownSettingsLines(op, dir)).toContain('The next start does not use the resident\'s file: it can\'t be read: a part of its path on the host is not a directory. Replace it with a plain file, or remove it.');
  });

  test('"read": a file there is parked and not used, and the start makes no directory for a mount (case 4, 16)', () => {
    const op = operator({ ownSettings: 'read' });
    const bare = mkdtempSync(join(tmpdir(), 'chost-own-settings-'));
    dirs.push(bare);
    expect(startOwnSettings(op, bare).log).toEqual([]);
    expect(existsSync(join(bare, 'own-settings'))).toBe(false);
    const dir = dataDir({ own: { 'agent.timezone': 'Europe/Berlin' } });
    const start = startOwnSettings(op, dir);
    expect(start.move).toBe('park');
    expect(start.check.recipe.agent.timezone).toBeUndefined();
    expect(start.note).toContain('settings--own shows your own settings');
    const broken = startOwnSettings(op, dataDir({ own: 'not json' }));
    expect(broken.move).toBe('park');
    expect(broken.note).not.toContain('did not use your settings file');
  });

  test('a list: the entry is in force, the saved document keeps the operator\'s value, and no note comes (case 2)', () => {
    const op = operator({ ownSettings: ['agent.proseRouting'], agent: { proseRouting: 'locus' } });
    const dir = dataDir({ own: { 'agent.proseRouting': 'explicit' } });
    const start = startOwnSettings(op, dir);
    expect(buildFrameworkAgentConfig(start.check.recipe, 'ember', 'claude-opus-4-6', undefined).proseRouting).toBe('explicit');
    expect(op.recipe.agent.proseRouting).toBe('locus');
    expect(valueAt(op.origin.kind === 'authored' ? op.origin.document : null, 'agent.proseRouting')).toBe('locus');
    expect(start.note).toBeUndefined();
    expect(start.log).toEqual(['[own-settings] agent.proseRouting is "explicit" from the resident\'s file; the recipe\'s own value is "locus".']);
  });

  test('each entry changes its own path of the recipe and nothing else, on a recipe that sets every other setting', () => {
    const { proseLock: _lock, ...agent } = everySetting.agent;
    for (const setting of OWN_SETTINGS) {
      const op = quietly(() => operator(without({ ...everySetting, agent, ownSettings: 'all' }, setting.name.split('.')) as Record<string, unknown>));
      expect(valueAt(op.recipe, setting.name)).toBeUndefined();
      const start = startOwnSettings(op, dataDir({ own: { [setting.name]: setting.example } }));
      expect([setting.name, start.check.entries[0]!.notUsed]).toEqual([setting.name, null]);
      expect(start.check.recipe).toEqual(withValue(op.recipe, setting.name.split('.'), setting.example));
    }
  });

  test('a very long name or value stops no start, and the note and the log stay short', () => {
    const op = operator({ ownSettings: 'all' });
    const long = 'x'.repeat(1_000_000);
    const start = startOwnSettings(op, dataDir({ own: { [long]: 1, 'agent.proseRouting': long, 'agent.timezone': 'UTC' } }));
    expect(start.check.recipe.agent.timezone).toBe('UTC');
    expect(start.check.entries.map((entry) => entry.notUsed?.kind ?? null)).toEqual(['unknown', 'value', null]);
    expect(start.note!.length).toBeLessThan(5_000);
    expect(start.log.every((line) => line.length < 2_000)).toBe(true);
  });

  test('a file of many entries, or of a large valid map, gives a short note and log', () => {
    const many = Object.fromEntries(Array.from({ length: 100_000 }, (_, i) => [`unknown.${i}`, i]));
    const start = startOwnSettings(operator({ ownSettings: 'all' }), dataDir({ own: { ...many, 'agent.timezone': 'UTC' } }));
    expect(start.check.recipe.agent.timezone).toBe('UTC');
    expect(start.note!.length).toBeLessThan(10_000);
    expect(start.note).toContain('- and 99980 more entries that are not used');
    expect(start.log.length).toBeLessThan(30);
    const map = Object.fromEntries(Array.from({ length: 50_000 }, (_, i) => [`tool_${i}`, 1]));
    const large = startOwnSettings(operator({ ownSettings: 'all' }), dataDir({ own: { 'agent.strategy.toolResultMaxLastN': map } }));
    expect(large.check.entries[0]!.notUsed).toBeNull();
    expect(large.log.every((line) => line.length < 2_000)).toBe(true);
  });

  test('a file that is not UTF-8 text is not used, and the note says so', () => {
    const dir = dataDir();
    writeFileSync(ownFile(dir), Buffer.from([0x7b, 0x22, 0x61, 0xff, 0x22, 0x3a, 0x31, 0x7d]));
    const start = startOwnSettings(operator({ ownSettings: 'all' }), dir);
    expect(start.check.file).toEqual({ kind: 'not-an-object', why: 'it is not UTF-8 text' });
    expect(start.note).toContain('it is not UTF-8 text');
  });

  test('an entry keeps the system prompt that the load fetched, where the author wrote a URL', () => {
    const op = operator({ ownSettings: 'all' });
    const fetched: OperatorRecipe = {
      recipe: { ...op.recipe, agent: { ...op.recipe.agent, systemPrompt: 'the fetched prompt' } },
      origin: { kind: 'authored', document: { ...(op.origin.kind === 'authored' ? op.origin.document as Record<string, unknown> : {}),
        agent: { name: 'ember', model: 'claude-opus-4-6', systemPrompt: 'https://example.invalid/prompt.md' } } },
    };
    const start = startOwnSettings(fetched, dataDir({ own: { 'agent.timezone': 'UTC' } }));
    expect(start.check.recipe.agent.systemPrompt).toBe('the fetched prompt');
    expect(start.check.recipe.agent.timezone).toBe('UTC');
  });

  test('a value nested deeper than the host can show stops no start', () => {
    for (const depth of [5_000, 50_000, 500_000]) {
      const text = `{"agent.timezone": "UTC", "agent.proseRouting": ${'['.repeat(depth)}${']'.repeat(depth)}}`;
      const start = startOwnSettings(operator({ ownSettings: 'all' }), dataDir({ own: text }));
      expect(start.check.recipe.agent.timezone).toBe('UTC');
      expect(start.note!.length).toBeLessThan(5_000);
      expect(start.log.every((line) => line.length < 2_000)).toBe(true);
    }
  });

  test('a parked file comes back only where no own.json was written during the start', () => {
    const op = operator({ ownSettings: 'all' });
    const dir = dataDir({ parked: { 'agent.timezone': 'Asia/Tokyo' } });
    const start = startOwnSettings(op, dir);
    expect(start.move).toBe('put-back');
    writeFileSync(ownFile(dir), JSON.stringify({ 'agent.timezone': 'Europe/Berlin' }));
    takeRecipeWarnings();
    const line = `[own-settings] ${ownFile(dir)} was written during the start, so the host left ${ownFile(dir, 'own.not-used.json')} where it is.`;
    expect(start.moveFile()).toBe(line);
    expect(takeRecipeWarnings()).toEqual([line]);
    expect(JSON.parse(readFileSync(ownFile(dir), 'utf-8'))).toEqual({ 'agent.timezone': 'Europe/Berlin' });
    expect(existsSync(ownFile(dir, 'own.not-used.json'))).toBe(true);
  });

  test('an unknown name in the file is not used, with the nearest name, and a later entry is in force', () => {
    takeRecipeWarnings();
    const start = startOwnSettings(operator({ ownSettings: 'all' }), dataDir({ own: { 'agent.timezon': 'UTC', 'agent.clock': false } }));
    expect(takeRecipeWarnings()).toEqual(['[own-settings] agent.timezon in the resident\'s file is not used: it is not a setting of the table (did you mean agent.timezone?).']);
    expect(start.check.entries[0]!.notUsed).toEqual({ kind: 'unknown' });
    expect(start.check.recipe.agent.clock).toBe(false);
    expect(start.note).toContain('- `agent.timezon` is not used: it is not a setting that you can manage (did you mean `agent.timezone`?).');
    expect(nearestKey('x'.repeat(5_000_000), OWN_SETTING_NAMES)).toBeNull();
  });

  test('the note names settings--own only where the tool list lets the resident call it', () => {
    const own = { 'agent.timezone': 'Nowhere/Zone' };
    expect(startOwnSettings(operator({ ownSettings: 'all' }), dataDir({ own })).note).toContain('settings--own shows your own settings');
    const blocked = quietly(() => operator({ ownSettings: 'all', agent: { allowedTools: ['workspace--write'] } }));
    expect(startOwnSettings(blocked, dataDir({ own })).note).not.toContain('settings--own');
  });

  test('an entry outside the list is not used, and the note names it; the others are in force (case 3)', () => {
    const op = operator({ ownSettings: ['agent.timezone'] });
    const start = startOwnSettings(op, dataDir({ own: { 'agent.proseRouting': 'explicit', 'agent.timezone': 'Europe/Berlin' } }));
    expect(start.check.recipe.agent.timezone).toBe('Europe/Berlin');
    expect(start.check.recipe.agent.proseRouting).toBeUndefined();
    expect(start.note).toContain('- `agent.proseRouting` is not used: your operator\'s recipe does not let you change it. Remove it from the file, or ask your operator.');
  });

  test('"all" with one entry for each of the 23, on a recipe with each module on: all are in force (case 5)', () => {
    const op = operator({ ownSettings: 'all', ...EVERY_MODULE });
    const start = startOwnSettings(op, dataDir({ own: GOOD }));
    expect(start.check.entries.filter((entry) => entry.notUsed !== null)).toEqual([]);
    for (const [name, value] of Object.entries(GOOD)) expect(valueAt(start.check.recipe, name)).toEqual(value);
    expect(start.note).toBeUndefined();
  });

  test('a wrong value is not used, with the schema\'s sentence in the value\'s frame; the others are in force (case 6, 27)', () => {
    const op = operator({ ownSettings: 'all' });
    const start = startOwnSettings(op, dataDir({ own: { 'agent.proseRouting': 'loud', 'agent.timezone': 'Europe/Berlin' } }));
    expect(start.check.recipe.agent.timezone).toBe('Europe/Berlin');
    expect(start.note).toContain('- `agent.proseRouting` is not used: "loud" is not a value that this setting takes. The host\'s check says: ' +
      '\'agent.proseRouting must be "locus", "explicit", "hybrid", "disabled" or "locked", got "loud".\'');
  });

  test('a file that is not JSON: no entry is used, and the note gives the parser\'s sentence (case 7)', () => {
    const op = operator({ ownSettings: 'all' });
    const start = startOwnSettings(op, dataDir({ own: '{"agent.timezone": ' }));
    expect(start.check.entries).toEqual([]);
    expect(start.note).toStartWith('The host did not use your settings file _settings/own.json at this start: it is not JSON: ');
    expect(start.note).toContain('JSON Parse error');
    expect(startOwnSettings(op, dataDir({ own: [1] })).note).toContain('it holds a list, not a JSON object');
  });

  test('a module that is off: its setting is not used, and the module stays off (case 8)', () => {
    const op = operator({ ownSettings: 'all' });
    const files = {
      'modules.retrieval.maxInjected': 4, 'modules.subagents.orientation': 'none',
      'modules.ttsRelay.notifyOnInterruption': false, 'tuneOut.announce': true,
    };
    const start = startOwnSettings(op, dataDir({ own: files }));
    expect(start.check.entries.map((entry) => entry.notUsed?.kind)).toEqual(['not-available', 'not-available', 'not-available', 'not-available']);
    expect(start.check.recipe.modules).toEqual(op.recipe.modules);
    expect(start.check.recipe.tuneOut).toBeUndefined();
    const judge = operator({ ownSettings: 'all', modules: { wake: { judge: { enabled: false } } } });
    expect(startOwnSettings(judge, dataDir({ own: { 'modules.wake.judge.onError': 'skip' } })).check.entries[0]!.notUsed)
      .toEqual({ kind: 'not-available', when: 'with the gate on (modules.wake not false) and its reply judge not switched off' });
  });

  test('a module that is true: its config gets the value (case 9)', () => {
    const op = operator({ ownSettings: 'all', modules: { retrieval: true, lessons: true, subagents: true } });
    const start = startOwnSettings(op, dataDir({ own: { 'modules.retrieval.maxInjected': 4, 'modules.subagents.orientation': 'none' } }));
    expect(start.check.recipe.modules?.retrieval).toEqual({ maxInjected: 4 });
    expect(start.check.recipe.modules?.subagents).toEqual({ orientation: 'none' });
    const wake = startOwnSettings(operator({ ownSettings: 'all' }), dataDir({ own: { 'modules.wake.judge.onError': 'skip' } }));
    expect(wake.check.recipe.modules?.wake).toEqual({ judge: { onError: 'skip' } });
  });

  test('a section that the recipe leaves out is made, and the create options have it (case 10)', () => {
    const op = operator({ ownSettings: 'all', subconscious: EVERY_MODULE.subconscious, agent: { refusalHandling: false } });
    const own = {
      'speech.locus': 'latest-inbound', 'tuneOut.announce': true,
      'agent.refusalHandling.autoRewind': true, 'agent.strategy.identityReminder': 'Write as me.',
    };
    const { recipe } = startOwnSettings(op, dataDir({ own })).check;
    const created = dendriteCreateOptions(recipe, 'claude-opus-4-6', 'UTC');
    expect([created.speech, created.tuneOut]).toEqual([{ locus: 'latest-inbound' }, { announce: true }]);
    expect(buildFrameworkAgentConfig(recipe, 'ember', 'claude-opus-4-6', undefined).refusalHandling).toEqual({ autoRewind: true });
    expect(recipe.agent.strategy).toEqual({ identityReminder: 'Write as me.' });
  });

  test('on passthrough, a strategy setting is not used, and the tool lists it as not available (case 11)', () => {
    const op = operator({ ownSettings: 'all', agent: { strategy: { type: 'passthrough' } } });
    const dir = dataDir({ own: { 'agent.strategy.maxLiveImages': 3 } });
    expect(startOwnSettings(op, dir).check.entries[0]!.notUsed?.kind).toBe('not-available');
    expect(answer(op, dir)).toContain('agent.strategy.maxLiveImages: not available on this host: it takes effect only ' +
      'with the strategy "autobiographical" or "frontdesk".');
  });

  test('a rule: the entry is not used, its reason quotes the rule in the resident\'s frame, and a second entry is in force (case 12, 27)', () => {
    const op = operator({ ownSettings: 'all', agent: { proseRouting: 'locked', proseLock: '#general' } });
    const start = startOwnSettings(op, dataDir({ own: { 'agent.proseRouting': 'locus', 'agent.timezone': 'Europe/Berlin' } }));
    expect(start.check.recipe.agent.proseRouting).toBe('locked');
    expect(start.check.recipe.agent.timezone).toBe('Europe/Berlin');
    expect(start.note).toContain('- `agent.proseRouting` is not used. With your value "locus", your operator\'s recipe fails a check of the host: ' +
      '\'Recipe agent.proseLock requires agent.proseRouting "locked", got "locus".\'\n' +
      '  That check reads settings that your operator holds. Choose a value that passes, or ask your operator.');
  });

  test('a rule\'s sentence shows the resident\'s value where the operator\'s recipe names a variable at that path', () => {
    const op = operator({ ownSettings: 'all', agent: { proseRouting: '${MODE}', proseLock: '#general' } }, { MODE: 'locked' });
    const start = startOwnSettings(op, dataDir({ own: { 'agent.proseRouting': 'hybrid' } }));
    expect(start.note).toContain('\'Recipe agent.proseLock requires agent.proseRouting "locked", got "hybrid".\'');
  });

  test('two entries that each pass alone are both in force, in either order (case 13)', () => {
    const op = operator({ ownSettings: 'all' });
    for (const own of [
      { 'agent.timezone': 'Europe/Berlin', 'agent.clock': false },
      { 'agent.clock': false, 'agent.timezone': 'Europe/Berlin' },
    ]) {
      const { recipe } = startOwnSettings(op, dataDir({ own })).check;
      expect([recipe.agent.timezone, recipe.agent.clock]).toEqual(['Europe/Berlin', false]);
    }
  });

  test('a parked file comes back when the grant does, and the note says so at that start alone (case 14)', () => {
    const dir = dataDir({ parked: { 'agent.proseRouting': 'explicit' } });
    const granted = operator({ ownSettings: ['agent.proseRouting'] });
    const back = startOwnSettings(granted, dir);
    expect([back.move, back.check.recipe.agent.proseRouting]).toEqual(['put-back', 'explicit']);
    expect(back.note).toStartWith('Your operator\'s recipe lets you change your own settings again, so the host puts your parked settings ' +
      'file back as _settings/own.json. In force from it:\n- `agent.proseRouting` is "explicit".');
    back.moveFile();
    expect(readdirSync(join(dir, 'own-settings'))).toEqual(['own.json']);
    expect(startOwnSettings(granted, dir).note).toBeUndefined();
  });

  test('with both files there, a start uses own.json and moves nothing; a dangling own.json link is not read, and moves nothing', () => {
    const op = operator({ ownSettings: 'all' });
    const both = dataDir({ own: { 'agent.timezone': 'Europe/Berlin' }, parked: { 'agent.timezone': 'Asia/Tokyo' } });
    const start = startOwnSettings(op, both);
    expect([start.move, start.check.recipe.agent.timezone]).toEqual([null, 'Europe/Berlin']);
    const dangling = dataDir({ parked: { 'agent.timezone': 'Asia/Tokyo' } });
    symlinkSync(join(dangling, 'nowhere.json'), ownFile(dangling));
    const linked = startOwnSettings(op, dangling);
    expect([linked.move, linked.check.recipe.agent.timezone]).toEqual([null, undefined]);
    expect(linked.note).toStartWith('The host did not use your settings file _settings/own.json at this start: it is a link');
  });

  test('a value that names a variable gets no substitution (case 15)', () => {
    const op = operator({ ownSettings: 'all' }, { ANTHROPIC_API_KEY: 'sk-secret' });
    const own = { 'agent.strategy.identityReminder': '${ANTHROPIC_API_KEY}' };
    expect(startOwnSettings(op, dataDir({ own })).check.recipe.agent.strategy?.identityReminder).toBe('${ANTHROPIC_API_KEY}');
  });

  test('the grant taken back for one name: the recipe\'s value is in force, the entry stays, and the note names it (case 16)', () => {
    const dir = dataDir({ own: { 'agent.timezone': 'Europe/Berlin' } });
    const start = startOwnSettings(operator({ ownSettings: ['agent.clock'], agent: { timezone: 'UTC' } }), dir);
    expect(start.check.recipe.agent.timezone).toBe('UTC');
    expect(JSON.parse(readFileSync(ownFile(dir), 'utf-8'))).toEqual({ 'agent.timezone': 'Europe/Berlin' });
    expect(start.note).toContain('`agent.timezone` is not used: your operator\'s recipe does not let you change it. Remove it from the file, or ask your operator.');
  });

  test('the recipe\'s value changed under an entry: the resident\'s value is in force, and the tool shows both (case 17)', () => {
    const op = operator({ ownSettings: 'all', agent: { timezone: 'Asia/Tokyo' } });
    const dir = dataDir({ own: { 'agent.timezone': 'Europe/Berlin' } });
    expect(startOwnSettings(op, dir).check.recipe.agent.timezone).toBe('Europe/Berlin');
    expect(answer(op, dir)).toContain('agent.timezone: "Europe/Berlin", from your file, and the recipe\'s own value is "Asia/Tokyo". You may change it.');
  });

  test('a file that is a link, a pipe or too large is not read; the recipe alone is in force and the note says why (case 21)', () => {
    const op = operator({ ownSettings: 'all' });
    const target = join(dataDir(), 'elsewhere.json');
    writeFileSync(target, JSON.stringify({ 'agent.timezone': 'Europe/Berlin' }));
    const linked = dataDir();
    symlinkSync(target, ownFile(linked));
    const piped = dataDir();
    expect(Bun.spawnSync(['mkfifo', ownFile(piped)]).exitCode).toBe(0);
    const large = dataDir({ own: `{"agent.timezone": "Europe/Berlin"}${' '.repeat(OWN_SETTINGS_MAX_BYTES)}` });
    for (const [dir, why] of [
      [linked, 'it is a link, and the host follows no link there'],
      [piped, 'it is not a plain file'],
      [large, `it is larger than ${OWN_SETTINGS_MAX_BYTES} bytes`],
    ] as const) {
      const start = startOwnSettings(op, dir);
      expect(start.check.recipe.agent.timezone).toBeUndefined();
      expect(start.note).toStartWith(`The host did not use your settings file _settings/own.json at this start: ${why}.`);
    }
  });

  test('without a workspace, the file on disk is applied, and the tool gives its path on disk (case 25)', () => {
    const op = operator({ ownSettings: 'all', modules: { workspace: false } });
    const dir = dataDir({ own: { 'agent.timezone': 'Europe/Berlin' } });
    expect(startOwnSettings(op, dir).check.recipe.agent.timezone).toBe('Europe/Berlin');
    expect(answer(op, dir)).toContain(`To change a setting, write it into ${ownFile(dir)}, on the host's disk: this host has no ` +
      'workspace, so a shell tool of yours can write it there, or your operator can:');
  });

  test('a recipe value from the environment shows as written, in the tool, the log and doctor (case 28)', () => {
    const op = operator({ ownSettings: 'all', agent: { timezone: '${TZ}' } }, { TZ: 'Asia/Tokyo' });
    expect(op.recipe.agent.timezone).toBe('Asia/Tokyo');
    const dir = dataDir({ own: { 'agent.timezone': 'Europe/Berlin' } });
    const start = startOwnSettings(op, dir);
    expect(start.log).toEqual(['[own-settings] agent.timezone is "Europe/Berlin" from the resident\'s file; the recipe\'s own value is ' +
      '"${TZ}", which the host fills from its environment.']);
    const tool = answer(op, dir, start.check);
    expect(tool).toContain('"${TZ}", which the host fills from its environment');
    expect(tool).not.toContain('Asia/Tokyo');
    const doctor = ownSettingsLines(op, dir).join('\n');
    expect(doctor).toContain('"${TZ}", which the host fills from its environment');
    expect(doctor).not.toContain('Asia/Tokyo');
  });

  test('a reference inside a recipe value, and the tool\'s example, show no value from the environment', () => {
    const env = { P: 'seconds', NAME: 'Secret-Name' };
    const op = operator({ ownSettings: ['agent.strategy.summaryParticipant', 'agent.clock'], agent: {
      clock: { intervalSeconds: 30, precision: '${P}' }, strategy: { summaryParticipant: '${NAME}' },
    } }, env);
    const tool = answer(op, dataDir());
    expect(tool).toContain('agent.clock: {"intervalSeconds":30,"precision":"${P}"}, which the host fills from its environment, from the recipe');
    expect(tool).toContain('such as {"agent.clock": {"intervalMinutes":30}}');
    expect(tool).not.toContain('Secret-Name');
    expect(tool).not.toContain('"seconds"');
  });

  test('a legacy saved recipe\'s strings show as values of the saved recipe', () => {
    const recipe = validateRecipe({ name: 'Ember', agent: { systemPrompt: 'hi', timezone: 'Asia/Tokyo' }, ownSettings: 'read' }, { kind: 'resolved' });
    const op: OperatorRecipe = { recipe, origin: { kind: 'resolved' } };
    const tool = answer(op, dataDir());
    expect(tool).toContain('agent.timezone: a value of the saved recipe, from the recipe.');
    expect(tool).not.toContain('Asia/Tokyo');
  });
});

describe('the tool', () => {
  test('on a file with one good entry and one wrong one, it names both and changes nothing on disk (case 19)', () => {
    const op = operator({ ownSettings: 'all' });
    const dir = dataDir();
    const start = startOwnSettings(op, dir).check;
    const content = JSON.stringify({ 'agent.timezone': 'Europe/Berlin', 'agent.clock': 'often' });
    writeFileSync(ownFile(dir), content);
    const text = answer(op, dir, start);
    expect(text).toStartWith('Pending: your file changes these at the next start, and they are not in force in this run.\n' +
      '- agent.timezone: "Europe/Berlin" at the next start');
    expect(text).toContain('Your file _settings/own.json now, as the next start applies it:\n- `agent.timezone` is "Europe/Berlin".\n' +
      '- `agent.clock` is not used: "often" is not a value that this setting takes.');
    expect([readFileSync(ownFile(dir), 'utf-8'), readdirSync(join(dir, 'own-settings'))]).toEqual([content, ['own.json']]);
  });

  test('"read": it shows all 23 with their values, and says that none may change (case 4)', () => {
    const op = operator({ ownSettings: 'read' });
    const text = answer(op, dataDir());
    for (const name of OWN_SETTING_NAMES) expect(text).toContain(`${name}: `);
    expect(text).toContain('agent.clock: {"intervalMinutes":10}, which the host sets, since neither the recipe nor your file sets it.');
    expect(text).toContain('Your operator\'s recipe lets you read these settings, and it lets you change none of them.');
  });

  test('a list shows only its own settings, and a parked file is named', () => {
    const op = operator({ ownSettings: ['agent.timezone'] });
    const dir = dataDir({ own: { 'agent.timezone': 'Europe/Berlin' }, parked: {} });
    const text = answer(op, dir);
    expect(text).toContain('agent.timezone: "Europe/Berlin", from your file');
    expect(text).not.toContain('agent.clock');
    expect(text).toContain('Your parked file _settings/own.not-used.json is there');
    const parkedOnly = dataDir({ parked: { 'agent.timezone': 'Asia/Tokyo' } });
    expect(answer(op, parkedOnly)).toContain('Your parked file _settings/own.not-used.json is there, and _settings/own.json is not: ' +
      'the next start puts it back as _settings/own.json, and applies it. If you write a new _settings/own.json first');
  });
});

describe('the settings module', () => {
  const ctx = () => {
    const added: Array<{ text: string; forAgent: string | undefined }> = [];
    const context = {
      getState: () => undefined,
      setState: () => {},
      addMessage: (_who: string, content: Array<{ text: string }>, _metadata: unknown, target?: { forAgent?: string }) => {
        added.push({ text: content[0]!.text, forAgent: target?.forAgent });
      },
    } as unknown as ModuleContext;
    return { added, context };
  };

  test('without the key, it offers no utility; with it, settings--own answers the resident, and refuses another caller (case 31)', async () => {
    expect(new SettingsModule().getUtilities()).toEqual([]);
    const mod = new SettingsModule('default', { note: undefined, resident: () => 'ember', answer: () => 'the answer' });
    expect(mod.getUtilities().map((tool) => tool.name)).toEqual(['own']);
    expect(await mod.handleToolCall({ id: 'call-1', name: 'own', input: {}, callerAgentName: 'ember' }))
      .toEqual({ success: true, data: 'the answer' });
    expect(await mod.handleToolCall({ id: 'call-2', name: 'own', input: {}, callerAgentName: 'ember-fork-1' })).toEqual({
      success: false, isError: true,
      error: 'settings--own shows ember\'s own settings, and answers ember alone, so nothing ran. A call again gives the same; ask ember for ' +
        'what you need from them.',
    });
  });

  test('the note comes to the resident alone, at the first start in the process, and not at a session switch\'s start', async () => {
    const mod = new SettingsModule('default', { note: 'a note', resident: () => 'ember', answer: null });
    const first = ctx();
    await mod.start(first.context);
    await mod.stop();
    const second = ctx();
    await mod.start(second.context);
    expect([first.added, second.added]).toEqual([[{ text: 'a note', forAgent: 'ember' }], []]);
  });
});

describe('connectome doctor\'s lines', () => {
  test('each entry that would be in force with its value, each that would not with its reason, and a parked file (case 22)', () => {
    const op = operator({ ownSettings: ['agent.timezone'] });
    const dir = dataDir({ own: { 'agent.timezone': 'Europe/Berlin', 'agent.clock': false }, parked: {} });
    expect(ownSettingsLines(op, dir)).toEqual([
      'agent.timezone would be "Europe/Berlin" from the resident\'s file; the recipe sets none.',
      'agent.clock in the resident\'s file would not be used: the recipe\'s ownSettings does not name it.',
      `${ownFile(dir, 'own.not-used.json')} is there too, and the start uses own.json.`,
    ]);
    expect(ownSettingsLines(operator({}), dataDir())).toEqual([]);
    expect(checkOwnSettings(op, dir).entries).toHaveLength(2);
  });
});
