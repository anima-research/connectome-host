/**
 * The store audit (src/update/audit-stores.ts): each store a start of this
 * release would open, opened in place the way a start opens the agent's
 * namespace, each one it couldn't open said, and the audit a host on trial
 * runs before its commit (startFramework).
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import {
  appendFileSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync,
  symlinkSync, truncateSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import { AgentFramework, resolveTimeZone } from '@animalabs/agent-framework';
import { JsStore } from '@animalabs/chronicle';
import { AutobiographicalStrategy, ContextManager } from '@animalabs/context-manager';
import { Membrane, MockAdapter } from '@animalabs/membrane';
import { buildFrameworkAgentConfig, recipeModel } from '../src/framework-agent-config.js';
import { buildFrameworkStrategy, standardKvUnifiedConfig } from '../src/framework-strategy.js';
import { loadExtensions } from '../src/extensions.js';
import { DEFAULT_RECIPE, loadSavedRecipe, saveRecipe, validateRecipe } from '../src/recipe.js';
import { SessionManager } from '../src/session-manager.js';
import { startFramework } from '../src/start-framework.js';
import { auditStores, fleetChildRepair, type AuditOptions } from '../src/update/audit-stores.js';
import { AUDIT_POINTER, loadRepairAlert, loadRepairLines, type LoadRepairReport } from '../src/web/load-repair-alert.js';
import * as contract from '../src/update/contract.js';
import { makeRepairStore } from './load-repair-store.js';
import {
  appendJournal, childrenFilePath, copyItemName, copyLabelPath, installPaths, moveCurrent, readCurrent,
  writeJsonAtomic,
} from '../src/update/contract.js';
import { processEnded, waitForEnd } from './process-ended.js';

const MODEL = { complete: async () => ({ stopReason: 'end_turn', content: [{ type: 'text', text: 'x' }] }) } as never;
const INDEX_PATH = join(import.meta.dir, '..', 'src', 'index.ts');
// context-manager's own build, the `main` its package names: another copy of
// the library than the host's, which Bun loads from its source, as an
// extension's own would be. The package is found where Bun resolves it from
// here, in this checkout's node_modules or one above it, as a hoisted or
// linked install leaves it.
const CONTEXT_MANAGER = ((): string => {
  let dir = dirname(Bun.resolveSync('@animalabs/context-manager', import.meta.dir));
  while (!existsSync(join(dir, 'package.json')) && dirname(dir) !== dir) dir = dirname(dir);
  return join(dir, (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { main: string }).main);
})();
const REMEDY = 'AGENT-ONBOARDING.md §11.8 says what a store with crossed summaries needs.';
const MODEL_CALLED = 'its strategy called a model while opening it, and the audit gives a strategy none: only a start of this release can answer for this store';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'update-audit-')); });
/** Each test's last word on what it started: run after it, whether it
 *  passed, failed or timed out. */
const leftovers: Array<() => void> = [];
afterEach(() => {
  for (const end of leftovers.splice(0)) {
    try { end(); } catch { /* gone */ }
  }
  rmSync(root, { recursive: true, force: true });
});

/** A store whose namespace holds 40 messages. With `crossed`, it also holds a
 *  level-2 summary whose leaves aren't contiguous in store order, made as
 *  context-manager's own topology tests make one, so an open under the
 *  default topology policy refuses it. */
async function makeStore(path: string, namespace: string, crossed: boolean): Promise<void> {
  const seed = new AutobiographicalStrategy({ adaptiveResolution: true, hierarchical: true, autoTickOnNewMessage: false });
  const manager = await ContextManager.open({ path, namespace, strategy: seed, membrane: MODEL });
  const ids: string[] = [];
  for (let i = 0; i < 40; i++) {
    ids.push(manager.addMessage(i % 2 ? 'agent' : 'user', [{ type: 'text', text: `message ${i} ` + 'w '.repeat(20) }]));
  }
  if (crossed) {
    const summary = (id: string, level: number, sourceIds: string[], first: string, last: string, mergedInto?: string) => ({
      id, level, content: `s ${id}`, tokens: 50, sourceLevel: level - 1, sourceIds,
      sourceRange: { first, last }, created: 1, ...(mergedInto ? { mergedInto } : {}),
    });
    const slice = (a: number, b: number) => ids.slice(a, b + 1);
    const internals = seed as unknown as { store: { setStateJson(id: string, value: unknown): void }; summariesStateId: string };
    internals.store.setStateJson(internals.summariesStateId, [
      summary('L1-stray', 1, slice(3, 3), ids[3]!, ids[3]!, 'L2-x'),
      summary('L1-a', 1, slice(4, 13), ids[4]!, ids[13]!),
      summary('L1-c', 1, slice(24, 33), ids[24]!, ids[33]!, 'L2-x'),
      summary('L2-x', 2, ['L1-stray', 'L1-c'], ids[3]!, ids[33]!),
    ]);
  }
  manager.close();
}

/** A store of 120 messages in `agents/agent` whose summary L2-x merges an L1
 *  over 40..49 with one over 60..69, and no record owns 50..59 (Effie-2289's
 *  case, room-203 #164796). A start chunks that run before its topology
 *  check, which gives L2-x holes, unless the messages are ones a tune-out
 *  diverted (`tunedOut`), which a start's view leaves out. The seed opens with
 *  `auditOnly` only so that adding the messages makes no chunk records. */
async function makeSpanStore(path: string, tunedOut: boolean): Promise<void> {
  const seed = new AutobiographicalStrategy({ adaptiveResolution: true, hierarchical: true, autoTickOnNewMessage: false, auditOnly: true });
  const manager = await ContextManager.open({ path, namespace: 'agents/agent', strategy: seed, membrane: MODEL });
  const ids: string[] = [];
  for (let i = 0; i < 120; i++) {
    const diverted = tunedOut && i >= 50 && i <= 59 ? { tuneOut: { epochId: 'test' } } : undefined;
    ids.push(manager.addMessage(i % 2 ? 'agent' : 'user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(60) }], diverted));
  }
  const summary = (id: string, level: number, sourceIds: string[], first: string, last: string, mergedInto?: string) => ({
    id, level, content: `s ${id}`, tokens: 50, sourceLevel: level - 1, sourceIds,
    sourceRange: { first, last }, created: 1, ...(mergedInto ? { mergedInto } : {}),
  });
  const internals = seed as unknown as { store: { setStateJson(id: string, value: unknown): void }; summariesStateId: string };
  internals.store.setStateJson(internals.summariesStateId, [
    summary('L1-a', 1, ids.slice(40, 50), ids[40]!, ids[49]!, 'L2-x'),
    summary('L1-b', 1, ids.slice(60, 70), ids[60]!, ids[69]!, 'L2-x'),
    summary('L2-x', 2, ['L1-a', 'L1-b'], ids[40]!, ids[69]!),
  ]);
  manager.close();
}

/** A store whose agent's namespace opens and whose subconscious's context
 *  log holds a null where an entry should be, which the subconscious's open
 *  can't index (context-manager ContextLog.rebuildSourceIndex). */
async function makeBrokenSubconsciousStore(path: string): Promise<void> {
  await makeStore(path, 'agents/agent', false);
  const store = JsStore.openOrCreate({ path });
  store.registerState({ id: 'subconscious/agent/context', strategy: 'append_log', deltaSnapshotEvery: 50, fullSnapshotEvery: 10 });
  store.appendToStateJson('subconscious/agent/context', null);
  store.close();
}

/** A data directory with one session per maker, the first of them active,
 *  each session's store made by its maker. */
async function makeDataDirWith(name: string, makers: Array<(store: string) => Promise<void>>): Promise<{ dir: string; stores: string[] }> {
  const dir = join(root, name);
  const manager = new SessionManager(dir);
  // An id of digits alone would be listed before the others, as an integer
  // key is, so the sessions' order would no longer be the makers'.
  const made = makers.map(() => {
    for (;;) {
      const session = manager.createSession();
      if (!/^\d+$/.test(session.id)) return session;
      const index = manager.load();
      delete index.sessions[session.id];
      manager.save(index);
    }
  });
  const index = manager.load();
  index.activeSessionId = made[0]!.id;
  manager.save(index);
  const stores: string[] = [];
  for (const [i, make] of makers.entries()) {
    const store = manager.getStorePath(made[i]!.id);
    await make(store);
    stores.push(store);
  }
  return { dir, stores };
}

/** A data directory with one session per entry, each store made as
 *  `makeStore` makes it. */
function makeDataDir(name: string, sessions: Array<{ namespace: string; crossed: boolean }>): Promise<{ dir: string; stores: string[] }> {
  return makeDataDirWith(name, sessions.map((session) => (store: string) => makeStore(store, session.namespace, session.crossed)));
}

/** The audit of `dirs` through auditStores: its status, every line it said,
 *  and the lines of what it couldn't open or audit. */
async function audit(dirs: string[], options: AuditOptions = {}): Promise<{ status: number; lines: string[]; failed: string[] }> {
  const lines: string[] = [];
  const failed: string[] = [];
  const status = await auditStores(dirs, (line, failure) => {
    lines.push(line);
    if (failure) failed.push(line);
  }, options);
  return { status, lines, failed };
}

/** The audit through the host's entry, with no provider credential, as its
 *  own process: its exit status and what it wrote. With `holdAfter`, its
 *  output is read only once that file exists and then it has exited or 3 s
 *  have passed. */
async function entry(dirs: string[], options: { holdAfter?: string; env?: Record<string, string | undefined> } = {}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const env: Record<string, string | undefined> = { ...process.env, ...options.env };
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_CREDENTIALS_FILE', 'DATA_DIR']) {
    if (!(options.env && key in options.env)) delete env[key];
  }
  const child = Bun.spawn(['bun', INDEX_PATH, '--audit-stores', ...dirs], { env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  if (options.holdAfter !== undefined) {
    const marker = options.holdAfter;
    for (let waited = 0; !existsSync(marker) && waited < 30_000; waited += 20) await Bun.sleep(20);
    expect(existsSync(marker), `${marker} never appeared`).toBe(true);
    await Promise.race([child.exited, Bun.sleep(3_000)]);
  }
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    Promise.race([child.exited, Bun.sleep(45_000).then(() => { child.kill('SIGKILL'); return null; })]),
  ]);
  return { status, stdout, stderr };
}

/** A recipe whose strategy extension `type` is made by the factory `source`
 *  gives, as a module's text, written to a file of the data directory's own,
 *  since a module is loaded once per path. */
function withStrategy(dir: string, type: string, source: string): void {
  const extension = join(root, `${basename(dir)}-${type}-strategy.ts`);
  writeFileSync(extension, source);
  saveRecipe(dir, {
    ...DEFAULT_RECIPE,
    extensions: { [type]: { kind: 'strategy', path: extension } },
    agent: { ...DEFAULT_RECIPE.agent, strategy: { type } },
  });
}

/** An audit's line for a store that reaches past what an update copies, as
 *  auditStores words it: on a trial, with setup's --extra-state among the
 *  ways on. */
function outsideLine(store: string, where: string, onTrial: boolean, pointable = true): string {
  return `Couldn't audit ${store}: it lies outside ${where}, where an update can't put back what opening it changes, so ` +
    `it wasn't opened. ${ways(onTrial, "move the store into its data directory, where its session's entry in " +
      'sessions.json names it', 'the store', "its session's entry in sessions.json naming it there", 'the directory it lies in',
      pointable)}`;
}
function linkLine(store: string, link: string, where: string, onTrial: boolean, pointable = true): string {
  const on = ways(onTrial, "keep the store's files inside it", 'what the link reaches', 'the link pointed at it there',
    'the place the link reaches', pointable);
  return `Couldn't audit ${store}: it holds ${link}, a link to what lies outside ${where}, which opening it could change ` +
    `where an update can't put it back, so it wasn't opened. ${on}`;
}
function ways(onTrial: boolean, first: string, carries: string, repointed: string, declared: string, pointable = true): string {
  const moved = `point the data directory itself at the other disk, with ${carries} moved into it and ${repointed}`;
  const declare = `declare ${declared} by running setup again with --extra-state PATH for it and for each place already ` +
    'recorded, so each update copies it';
  if (!pointable) return onTrial ? `To update, ${first}, or ${declare}.` : `To update, ${first}.`;
  return onTrial ? `To update, ${first}, ${moved}, or ${declare}.` : `To update, ${first}, or ${moved}.`;
}
/** The line for a session's store that is a link to nothing. */
function nothingLine(store: string): string {
  return `Couldn't audit ${store}: it's a link to nothing, so it wasn't opened. To update, point the link at the ` +
    "session's store, or remove it.";
}
/** The line for a store holding a link to nothing. */
function holdsNothingLine(store: string, link: string): string {
  return `Couldn't audit ${store}: it holds ${link}, a link to nothing, which opening it could make where an update ` +
    "can't take it away, so it wasn't opened. To update, point the link at a file inside the store, or remove it.";
}
/** The line, before every store's, for a store a fleet child's audit
 *  couldn't finish, whose fleet's host's data directory is `parent`. */
function unfinishedLine(dir: string, how: string, parent: string): string {
  return `Couldn't audit ${dir}: its audit ${how} before it said it had finished, so it isn't known that every store ` +
    `there was audited: ${byHand(parent)}, and shows where it stops, should it stop again.`;
}
const TRIAL_PLACES = "every place this trial's fallback puts back";

/** `text` as a regular expression matches it, literally. */
const literally = (text: string): string => text.replace(/[.*+?^$|()[\]{}\\]/g, '\\$&');

/** The advice a child's audit line gives: its parent's audit by hand. */
function byHand(parent: string): string {
  return `\`--audit-stores\` on ${parent}, after a copy of it and of each of its fleet children's directories, run as ` +
    'this host is started, with its recipe and its environment, audits this child as its fleet starts it';
}

/** A recipe file for a fleet child, with `fields` over the default one. */
function childRecipe(name: string, fields: Record<string, unknown> = {}): string {
  const path = join(root, `${name}.json`);
  writeFileSync(path, JSON.stringify({ ...DEFAULT_RECIPE, ...fields }));
  return path;
}

/** Whether the timer being armed now is the audit's own: the first frame of
 *  its stack past this file's that names a file is in the audit's source.
 *  Another timer of the same length armed meanwhile, such as an extension's
 *  or a library's, isn't; one the audit's own code arms is, whichever audit
 *  run arms it. */
function armedByAudit(): boolean {
  const frames = (new Error().stack ?? '').split('\n').slice(1);
  const caller = frames.find((frame) => frame.includes(sep) && !frame.includes(import.meta.path));
  return caller?.includes(join('src', 'update', 'audit-stores.ts')) ?? false;
}

/** A fleet child's audit limit made short: each timer of `limitMs` (the
 *  default, 5 minutes, unless given) the audit arms fires once `ready` holds
 *  and a second has passed, unless it was cleared first. `armed` counts the
 *  timers the audit armed; any other timer is armed as it asked. */
function limitWhen(ready: () => boolean, limitMs = 5 * 60_000): { armed: () => number; restore: () => void } {
  const later = globalThis.setTimeout;
  const cancel = globalThis.clearTimeout;
  const cleared = new Set<unknown>();
  let armed = 0;
  const arming = spyOn(globalThis, 'setTimeout').mockImplementation(((handler: () => void, ms?: number, ...rest: unknown[]) => {
    if (ms !== limitMs || !armedByAudit()) return later(handler, ms, ...rest);
    armed++;
    const timer = {};
    const poll = (): void => {
      if (cleared.has(timer)) return;
      if (ready()) later(() => { if (!cleared.has(timer)) handler(); }, 1_000);
      else later(poll, 50);
    };
    later(poll, 0);
    return timer;
  }) as typeof setTimeout);
  const clearing = spyOn(globalThis, 'clearTimeout').mockImplementation(((timer: unknown) => {
    cleared.add(timer);
    return cancel(timer as ReturnType<typeof setTimeout>);
  }) as typeof clearTimeout);
  return { armed: () => armed, restore: () => { arming.mockRestore(); clearing.mockRestore(); } };
}

/** An extension's first line: the pid of the process that started it, taken
 *  as it loads, before it marks anything a test waits on. */
const PARENT_AT_IMPORT = 'const parentAtImport = process.ppid;';

/** The source of an extension's work, without a turn of its event loop,
 *  until the process that started it has ended, and, given `release`, until
 *  that file is there too (PARENT_AT_IMPORT and existsSync in scope). */
function holdPastParent(release?: string): string[] {
  const released = release === undefined ? 'true' : `existsSync(${JSON.stringify(release)})`;
  return [
    'const cap = Date.now() + 30_000;',
    `while ((process.ppid === parentAtImport || !${released}) && Date.now() < cap) { /* held */ }`,
  ];
}

describe('the store audit', () => {
  test("a store this release would refuse is said, with §11.8 in place of the library's remedy, and the audit exits 1", async () => {
    const { dir, stores } = await makeDataDir('data', [{ namespace: 'agents/agent', crossed: true }]);
    const { status, lines, failed } = await audit([dir]);
    expect(status).toBe(1);
    expect(failed).toHaveLength(1);
    expect(lines).toEqual(failed);
    expect(failed[0]).toStartWith(`${stores[0]} (agents/agent): refused: store topology rejected: 1 summary owns non-contiguous leaves`);
    // The library's own remedy, a topologyPolicy the host's strategies take
    // from no recipe, gives way to §11.8.
    expect(failed[0]).toEndWith(`). ${REMEDY}`);
    expect(failed[0]).not.toContain('topologyPolicy');
    expect(failed[0]).not.toContain('\n');
  });

  test("a load repair the audit causes is said in the keeper's words and handed on, and it was written, so the next open finds nothing to repair", async () => {
    const { dir, stores } = await makeDataDirWith('data', [(store) => makeRepairStore(store)]);
    const lines: string[] = [];
    const got: Array<{ report: LoadRepairReport; agent: string; store: string; lastSaid: string | undefined }> = [];
    const status = await auditStores([dir], (line) => { lines.push(line); }, {
      onLoadRepair: (report, agent, store) => { got.push({ report, agent, store, lastSaid: lines[lines.length - 1] }); },
    });
    expect(status, lines.join('\n')).toBe(0);
    expect(got.map(({ report, agent, store }) => [agent, store, report.namespace, report.dropped.map((drop) => [drop.id, drop.reason])]))
      .toEqual([['agent', stores[0], 'agents/agent', [['L2-x', 'names-missing']]]]);
    const said = `${stores[0]} (agents/agent): ${loadRepairLines(got[0]!.report, 'agent', stores[0]!).join(' ')}`;
    expect(lines).toEqual([`${stores[0]} (agents/agent): opens`, said]);
    // Said before it's handed on, so a hand-on that throws can't keep it from
    // whoever runs the update.
    expect(got[0]!.lastSaid).toBe(said);
    const again = await audit([dir]);
    expect(again.lines).toEqual([`${stores[0]} (agents/agent): opens`]);
  });

  test("a load repair is said though the store then wouldn't close", async () => {
    const { dir, stores } = await makeDataDirWith('data', [(store) => makeRepairStore(store)]);
    const realClose = JsStore.prototype.close;
    const storeClose = spyOn(JsStore.prototype, 'close').mockImplementation(function (this: JsStore) {
      realClose.call(this);
      throw new Error('store close failed');
    });
    try {
      const { lines, failed } = await audit([dir]);
      expect(failed).toEqual([`Couldn't audit ${stores[0]}: it opened, and closing it failed: store close failed`]);
      expect(lines[1]).toStartWith(`${stores[0]} (agents/agent): agent's memory changed at load: `);
    } finally {
      storeClose.mockRestore();
    }
  });

  test("a fleet child's load repair reaches its parent's audit, which says it and hands it on as its own", async () => {
    const child = await makeDataDirWith('child', [(store) => makeRepairStore(store, 'agents/Kid')]);
    const kidRecipe = childRecipe('kid', { agent: { ...DEFAULT_RECIPE.agent, name: 'Kid' } });
    const parent = await makeDataDir('parent', [{ namespace: 'agents/agent', crossed: false }]);
    saveRecipe(parent.dir, {
      ...DEFAULT_RECIPE,
      modules: { ...DEFAULT_RECIPE.modules, fleet: { children: [{ name: 'kid', recipe: kidRecipe, dataDir: child.dir }] } },
    });
    const got: Array<{ report: LoadRepairReport; agent: string; store: string }> = [];
    const { status, lines } = await audit([parent.dir], { onLoadRepair: (report, agent, store) => { got.push({ report, agent, store }); } });
    expect(status, lines.join('\n')).toBe(0);
    expect(got.map(({ report, agent, store }) => [agent, store, report.dropped.map((drop) => drop.id)])).toEqual([['Kid', child.stores[0], ['L2-x']]]);
    // The read-back's coordinates come through whole.
    const { branch, stateId, sequenceBefore } = got[0]!.report;
    expect([branch, stateId]).toEqual(['main', 'agents/Kid/autobio:summaries']);
    expect(sequenceBefore).toBeGreaterThan(0);
    const said = `${child.stores[0]} (agents/Kid): ${loadRepairLines(got[0]!.report, 'Kid', child.stores[0]!).join(' ')}`;
    expect(lines.filter((line) => line === said)).toHaveLength(1);
    expect(lines.filter((line) => line.startsWith('--fleet-child'))).toEqual([]);
  }, 90_000);

  test("a fleet child's load repair line is taken only whole and of a report's shape; anything else is said as it came", () => {
    const range = { first: 'm1', last: 'm9', firstAt: null as string | null, lastAt: '2026-10-01T10:00:00.000Z' as string | null };
    const drop = { id: 'L2-x', level: 2 as number | null, tokens: 50 as number | null, reason: 'names-missing', sourceRange: range as typeof range | null };
    const report = {
      namespace: 'agents/Kid', branch: 'main', stateId: 'agents/Kid/autobio:summaries', sequenceBefore: 7, droppedTokens: 50, emptyDropped: 0,
      dropped: [drop],
    };
    const line = (said: unknown) => `--fleet-child load repair ${JSON.stringify(said)}`;
    const taken = (r: unknown) => fleetChildRepair(line({ store: '/s', agent: 'Kid', report: r }));
    expect(fleetChildRepair(line({ store: '/s', agent: 'Kid', report }))).toEqual({ store: '/s', agent: 'Kid', report } as never);
    // What context-manager may send: nulls where a value couldn't be read,
    // and fields a later version adds.
    for (const r of [
      { ...report, dropped: [{ ...drop, level: null, tokens: null, sourceRange: null }] },
      { ...report, dropped: [{ ...drop, sourceRange: { ...range, firstAt: null, lastAt: null } }] },
      { ...report, dropped: [{ ...drop, later: 1 }], later: 'x' },
    ]) expect(taken(r)?.report).toEqual(r as never);
    // Each field of the wrong type, one at a time.
    for (const key of Object.keys(report)) expect(taken({ ...report, [key]: true }), key).toBeUndefined();
    for (const key of Object.keys(drop)) expect(taken({ ...report, dropped: [{ ...drop, [key]: true }] }), key).toBeUndefined();
    for (const key of Object.keys(range)) expect(taken({ ...report, dropped: [{ ...drop, sourceRange: { ...range, [key]: true } }] }), key).toBeUndefined();
    expect(taken({ ...report, dropped: [null] })).toBeUndefined();
    expect(fleetChildRepair(line({ store: true, agent: 'Kid', report }))).toBeUndefined();
    expect(fleetChildRepair(line({ store: '/s', report }))).toBeUndefined();
    // Cut short, as a kill at the time limit leaves it.
    expect(fleetChildRepair(line({ store: '/s', agent: 'Kid', report }).slice(0, -5))).toBeUndefined();
    // Another line, even one holding a report.
    expect(fleetChildRepair(`/s (agents/Kid): opens`)).toBeUndefined();
    expect(fleetChildRepair(JSON.stringify({ store: '/s', agent: 'Kid', report }))).toBeUndefined();
  });

  test('a store that opens says so, and the audit exits 0', async () => {
    const { dir, stores } = await makeDataDir('data', [{ namespace: 'agents/agent', crossed: false }]);
    const { status, lines, failed } = await audit([dir]);
    expect(status).toBe(0);
    expect(failed).toEqual([]);
    expect(lines).toEqual([`${stores[0]} (agents/agent): opens`]);
  });

  test("each store's answer is the one agent-framework's own open of it gives", async () => {
    // The audit restates how agent-framework opens a resident's namespace
    // (createAgent), its view of the messages included, and the
    // subconscious's (createSubconsciousAgent). This opens a copy of each
    // store through agent-framework itself, with the same recipe, and
    // requires the same answer, so the two stay in step. The small windows
    // let a start chunk the span stores' unowned run.
    const recipe = { ...DEFAULT_RECIPE, agent: { ...DEFAULT_RECIPE.agent, strategy: { headWindowTokens: 500, recentWindowTokens: 1000 } } };
    const subconscious = { enabled: true, systemPrompt: 'attend to the agent' };
    const cases: Record<string, { make: (store: string) => Promise<void>; subconscious?: true; off?: true }> = {
      crossed: { make: (store) => makeStore(store, 'agents/agent', true) },
      plain: { make: (store) => makeStore(store, 'agents/agent', false) },
      'unowned run inside a span': { make: (store) => makeSpanStore(store, false) },
      'tuned-out run inside a span': { make: (store) => makeSpanStore(store, true) },
      'a subconscious that opens': { make: (store) => makeStore(store, 'agents/agent', false), subconscious: true },
      "a subconscious whose context a start can't read": { make: makeBrokenSubconsciousStore, subconscious: true },
      'the same store, its subconscious off': { make: makeBrokenSubconsciousStore, off: true },
    };
    const audited: Record<string, string> = {};
    const started: Record<string, string> = {};
    // What a refusal says, without the library's remedy, which the audit's
    // line replaces.
    const said: Record<string, { audit: string; start: string }> = {};
    for (const [index, [name, { make, subconscious: on, off }]] of Object.entries(cases).entries()) {
      const { dir, stores } = await makeDataDirWith(`case-${index}`, [make]);
      const caseRecipe = on ? { ...recipe, subconscious } : off ? { ...recipe, subconscious: { ...subconscious, enabled: false } } : recipe;
      saveRecipe(dir, caseRecipe);
      // agent-framework opens a copy, made before the audit opens the store
      // in place.
      const copy = join(root, `case-${index}-framework`);
      cpSync(stores[0]!, copy, { recursive: true });
      const { status, failed } = await audit([dir]);
      audited[name] = status === 1 && failed.length === 1 && failed[0]!.includes('): refused: ') ? 'refused' : status === 0 ? 'opens' : `status ${status}`;
      const validated = validateRecipe(structuredClone(caseRecipe));
      const model = recipeModel(validated, process.env.MODEL);
      const strategy = buildFrameworkStrategy(validated, model, resolveTimeZone(validated.agent.timezone));
      try {
        const framework = await AgentFramework.create({
          storePath: copy,
          membrane: new Membrane(new MockAdapter()),
          agents: [buildFrameworkAgentConfig(validated, 'agent', model, strategy)],
          modules: [],
          ...(validated.subconscious ? { subconscious: validated.subconscious } : {}),
        });
        await framework.stop();
        started[name] = 'opens';
      } catch (error) {
        started[name] = 'refused';
        said[name] = { audit: failed[0] ?? '', start: (error instanceof Error ? error.message : String(error)).split(' Repair the store')[0]! };
      }
    }
    expect(audited).toEqual(started);
    expect(started).toEqual({
      crossed: 'refused',
      plain: 'opens',
      'unowned run inside a span': 'refused',
      'tuned-out run inside a span': 'opens',
      'a subconscious that opens': 'opens',
      "a subconscious whose context a start can't read": 'refused',
      'the same store, its subconscious off': 'opens',
    });
    for (const [name, { audit: line, start }] of Object.entries(said)) {
      expect(line, name).toContain(start.replace(/\s*\n\s*/g, ' '));
    }
    expect(said["a subconscious whose context a start can't read"]!.audit).toContain(' (subconscious/agent): refused: ');
  }, 90_000);

  test("a crossed store opens under a resident's kv-unified block that keeps gap-bearing summaries, as at its start", async () => {
    const { dir, stores } = await makeDataDir('data', [{ namespace: 'agents/agent', crossed: true }]);
    const kvUnified = { ...standardKvUnifiedConfig(DEFAULT_RECIPE, 'claude-opus-4-6'), preserveGapBearingSummaries: true };
    saveRecipe(dir, { ...DEFAULT_RECIPE, agent: { ...DEFAULT_RECIPE.agent, strategy: { foldingStrategy: 'kv-unified', kvUnified } } });
    const { status, lines } = await audit([dir]);
    expect(lines).toEqual([`${stores[0]} (agents/agent): opens`]);
    expect(status).toBe(0);
  });

  test('every session is audited under the agent name a start resolves', async () => {
    // The first session's crossed namespace is one this recipe's agent never
    // opens; the second's is the agent's own.
    const { dir, stores } = await makeDataDir('data', [
      { namespace: 'agents/agent', crossed: true },
      { namespace: 'agents/Kid', crossed: true },
    ]);
    saveRecipe(dir, { ...DEFAULT_RECIPE, agent: { ...DEFAULT_RECIPE.agent, name: 'Kid' } });
    const { status, lines, failed } = await audit([dir]);
    expect(status).toBe(1);
    expect(failed.map((line) => line.slice(0, line.indexOf(': ')))).toEqual([`${stores[1]} (agents/Kid)`]);
    expect(lines[0]).toBe(`${stores[0]} (agents/Kid): opens`);
  });

  test("a store an import wrote under another name is opened under the recipe's name, as a start opens it", async () => {
    // The import record names Claude, whose crossed summaries the store holds;
    // the recipe names Kid, which a start opens, warning of the difference.
    const { dir, stores } = await makeDataDir('data', [{ namespace: 'agents/Claude', crossed: true }]);
    saveRecipe(dir, { ...DEFAULT_RECIPE, agent: { ...DEFAULT_RECIPE.agent, name: 'Kid' } });
    const manager = new SessionManager(dir);
    writeFileSync(join(dir, 'sessions', `${manager.load().activeSessionId}.import-source.json`), JSON.stringify({ agentName: 'Claude' }));
    const { status, lines } = await audit([dir]);
    expect(status).toBe(0);
    expect(lines).toEqual([`${stores[0]} (agents/Kid): opens`]);
  });

  test("a recipe that can't be loaded in the audit's environment leaves its directory not audited, naming the variable and no value, as a start fails on it", async () => {
    delete process.env.AUDIT_TEST_UNSET_WINDOW;
    process.env.AUDIT_TEST_SET_SECRET = 'sk-live-secret';
    try {
      const { dir } = await makeDataDir('data', [{ namespace: 'agents/agent', crossed: false }]);
      const module = join(root, 'configured.ts');
      writeFileSync(module, 'export function register() {}\n');
      saveRecipe(dir, {
        ...DEFAULT_RECIPE,
        extensions: { configured: { kind: 'module', path: module, config: { auth: '${AUDIT_TEST_SET_SECRET}:${AUDIT_TEST_UNSET_WINDOW}' } } },
      });
      const { status, lines, failed } = await audit([dir]);
      expect(status).toBe(1);
      expect(lines).toEqual(failed);
      expect(failed).toEqual([expect.stringMatching(new RegExp(`^Couldn't audit ${dir}: Recipe ".*" references environment variable \\$\\{AUDIT_TEST_UNSET_WINDOW\\} which is not set`))]);
      expect(failed[0]).not.toContain('sk-live-secret');
    } finally {
      delete process.env.AUDIT_TEST_SET_SECRET;
    }
  });

  test("an agent name the recipe takes from a variable is the one the audit's environment gives", async () => {
    const { dir, stores } = await makeDataDir('data', [{ namespace: 'agents/Kid', crossed: true }]);
    saveRecipe(dir, { ...DEFAULT_RECIPE, agent: { ...DEFAULT_RECIPE.agent, name: '${AUDIT_TEST_AGENT_NAME}' } });
    process.env.AUDIT_TEST_AGENT_NAME = 'Kid';
    try {
      const { status, failed } = await audit([dir]);
      expect(status).toBe(1);
      expect(failed.map((line) => line.slice(0, line.indexOf(': ')))).toEqual([`${stores[0]} (agents/Kid)`]);
    } finally {
      delete process.env.AUDIT_TEST_AGENT_NAME;
    }
  });

  test("a directory's fleet children are audited as the fleet launches them, under the recipe each entry names and in the environment the fleet starts it with, and a directory no entry names is said to be read in this one's", async () => {
    // The child's recipe, the one its entry names, takes its agent's name
    // from a variable only its fleet entry sets, which this environment
    // doesn't; the snapshot its last start saved names another agent.
    delete process.env.AUDIT_TEST_CHILD_NAME;
    const child = await makeDataDir('child', [{ namespace: 'agents/Kid', crossed: true }]);
    saveRecipe(child.dir, { ...DEFAULT_RECIPE, agent: { ...DEFAULT_RECIPE.agent, name: 'Snapshot' } });
    const kidRecipe = join(root, 'kid.json');
    // Its system prompt is at an address nothing serves, which a fetch
    // would fail on.
    writeFileSync(kidRecipe, JSON.stringify({
      ...DEFAULT_RECIPE, agent: { ...DEFAULT_RECIPE.agent, name: '${AUDIT_TEST_CHILD_NAME}', systemPrompt: 'http://127.0.0.1:9/prompt' },
    }));
    const parent = await makeDataDir('parent', [{ namespace: 'agents/agent', crossed: false }]);
    // A second entry whose child has never run, so it has no directory.
    saveRecipe(parent.dir, {
      ...DEFAULT_RECIPE,
      modules: {
        ...DEFAULT_RECIPE.modules,
        fleet: {
          children: [
            { name: 'kid', recipe: kidRecipe, dataDir: child.dir, env: { AUDIT_TEST_CHILD_NAME: 'Kid' } },
            { name: 'later', recipe: kidRecipe, dataDir: join(root, 'later') },
          ],
        },
      },
    });
    const other = await makeDataDir('other', [{ namespace: 'agents/agent', crossed: false }]);
    // Alone, the child is read under its snapshot, in this environment.
    const alone = await audit([child.dir]);
    expect(alone.status).toBe(0);
    expect(alone.lines).toEqual([`${child.stores[0]} (agents/Snapshot): opens`]);
    for (const given of [[parent.dir, other.dir], [parent.dir, child.dir, other.dir]]) {
      const { status, lines, failed } = await audit(given);
      expect(status).toBe(1);
      expect(failed.map((line) => line.slice(0, line.indexOf(': ')))).toEqual([`${child.stores[0]} (agents/Kid)`]);
      // The child's audit writes the libraries' lines to its stderr too,
      // which pass on with its own.
      expect(lines.filter((line) => line.startsWith(root) && !failed.includes(line))).toEqual([
        `${parent.stores[0]} (agents/agent): opens`,
        `${other.dir}: none of the fleet entries of the other directories given names it, so it's audited in this audit's own environment`,
        `${other.stores[0]} (agents/agent): opens`,
        `${child.dir}: audited as ${parent.dir}'s fleet child kid, under the recipe its entry names, in the environment the fleet starts it with`,
        `${join(root, 'later')}: ${parent.dir}'s fleet child later has no directory yet; its start makes one`,
      ]);
    }
  }, 90_000);

  test("with no agent name in the recipe, the active session's import record names it, as at a start", async () => {
    const { dir, stores } = await makeDataDir('data', [{ namespace: 'agents/Claude', crossed: true }]);
    const { name: _name, ...agent } = DEFAULT_RECIPE.agent;
    saveRecipe(dir, { ...DEFAULT_RECIPE, agent });
    const manager = new SessionManager(dir);
    writeFileSync(join(dir, 'sessions', `${manager.load().activeSessionId}.import-source.json`), JSON.stringify({ agentName: 'Claude' }));
    const { status, failed } = await audit([dir]);
    expect(status).toBe(1);
    expect(failed[0]).toStartWith(`${stores[0]} (agents/Claude): refused: `);
  });

  test("with no agent name in the recipe, each session's store is opened under the name every session gives", async () => {
    // The second session's import record names Bob, the third's Carol, and
    // the second's store holds crossed summaries under Carol's name: a start
    // with the third session active, and a switch from it to the second,
    // opens them there.
    const { dir, stores } = await makeDataDir('data', [
      { namespace: 'agents/agent', crossed: false },
      { namespace: 'agents/Carol', crossed: true },
      { namespace: 'agents/Carol', crossed: false },
    ]);
    const { name: _name, ...agent } = DEFAULT_RECIPE.agent;
    saveRecipe(dir, { ...DEFAULT_RECIPE, agent });
    const manager = new SessionManager(dir);
    const [, second, third] = Object.values(manager.load().sessions).map((meta) => meta.id);
    writeFileSync(join(dir, 'sessions', `${second}.import-source.json`), JSON.stringify({ agentName: 'Bob' }));
    writeFileSync(join(dir, 'sessions', `${third}.import-source.json`), JSON.stringify({ agentName: 'Carol' }));
    const { status, lines, failed } = await audit([dir]);
    expect(status).toBe(1);
    expect(lines.filter((line) => !failed.includes(line))).toEqual([
      `${stores[0]} (agents/agent): opens`, `${stores[0]} (agents/Bob): opens`, `${stores[0]} (agents/Carol): opens`,
      `${stores[1]} (agents/agent): opens`, `${stores[1]} (agents/Bob): opens`,
      `${stores[2]} (agents/agent): opens`, `${stores[2]} (agents/Bob): opens`, `${stores[2]} (agents/Carol): opens`,
    ]);
    expect(failed.map((line) => line.slice(0, line.indexOf(': ')))).toEqual([`${stores[1]} (agents/Carol)`]);
  });

  test("a store is opened under the name a session with no import record gives, though every session listed has one, since /session new makes one", async () => {
    const { dir, stores } = await makeDataDir('data', [{ namespace: 'agents/agent', crossed: true }]);
    const { name: _name, ...agent } = DEFAULT_RECIPE.agent;
    saveRecipe(dir, { ...DEFAULT_RECIPE, agent });
    const manager = new SessionManager(dir);
    writeFileSync(join(dir, 'sessions', `${manager.load().activeSessionId}.import-source.json`), JSON.stringify({ agentName: 'Claude' }));
    const { status, failed, lines } = await audit([dir]);
    expect(status).toBe(1);
    expect(failed.map((line) => line.slice(0, line.indexOf(': ')))).toEqual([`${stores[0]} (agents/agent)`]);
    expect(lines).toContain(`${stores[0]} (agents/Claude): opens`);
  });

  test("an active session the index doesn't list gives no name, since a start makes a new session in its place, which a switch opens each store from", async () => {
    // The listed session's own import record names Claude, so only the start's
    // new session gives the agent's name.
    const { dir, stores } = await makeDataDir('data', [{ namespace: 'agents/agent', crossed: true }]);
    const { name: _name, ...agent } = DEFAULT_RECIPE.agent;
    saveRecipe(dir, { ...DEFAULT_RECIPE, agent });
    const manager = new SessionManager(dir);
    const index = manager.load();
    const listed = index.activeSessionId!;
    index.activeSessionId = 'deadbeef';
    manager.save(index);
    writeFileSync(join(dir, 'sessions', 'deadbeef.import-source.json'), JSON.stringify({ agentName: 'Bob' }));
    writeFileSync(join(dir, 'sessions', `${listed}.import-source.json`), JSON.stringify({ agentName: 'Claude' }));
    const { status, failed, lines } = await audit([dir]);
    expect(status).toBe(1);
    expect(failed.map((line) => line.slice(0, line.indexOf(': ')))).toEqual([`${stores[0]} (agents/agent)`]);
    expect(lines).toContain(`${stores[0]} (agents/Claude): opens`);
    expect(lines.some((line) => line.includes('agents/Bob'))).toBe(false);
  });

  test("a session's store is found by the id its entry holds, as a start finds the active one's and its import record, and by its key", async () => {
    const { dir, stores } = await makeDataDir('data', [
      { namespace: 'agents/Claude', crossed: true },
      { namespace: 'agents/Claude', crossed: true },
    ]);
    const { name: _name, ...agent } = DEFAULT_RECIPE.agent;
    saveRecipe(dir, { ...DEFAULT_RECIPE, agent });
    const manager = new SessionManager(dir);
    const index = manager.load();
    const [first, second] = Object.keys(index.sessions);
    // The active entry under another key, its id kept: a start opens the store
    // the id names and reads the import record the id names.
    index.sessions['other-key'] = index.sessions[first!]!;
    delete index.sessions[first!];
    index.activeSessionId = 'other-key';
    writeFileSync(join(dir, 'sessions', `${first}.import-source.json`), JSON.stringify({ agentName: 'Claude' }));
    // The second entry's store is under its key, its id naming none, and its
    // import record is read by its id.
    index.sessions[second!] = { ...index.sessions[second!]!, id: 'names-no-store' };
    manager.save(index);
    writeFileSync(join(dir, 'sessions', 'names-no-store.import-source.json'), JSON.stringify({ agentName: 'Dana' }));
    const { status, failed, lines } = await audit([dir]);
    expect(lines).toContain(`${stores[1]} (agents/Dana): opens`);
    expect(status).toBe(1);
    expect(failed.map((line) => line.slice(0, line.indexOf(': '))).sort()).toEqual([`${stores[0]} (agents/Claude)`, `${stores[1]} (agents/Claude)`].sort());
  });

  test("a listed session with no store is said, and a store the audit can't reach is not audited", async () => {
    const { dir, stores } = await makeDataDir('data', [
      { namespace: 'agents/agent', crossed: false },
      { namespace: 'agents/agent', crossed: false },
    ]);
    rmSync(stores[1]!, { recursive: true });
    const first = await audit([dir]);
    expect(first.status).toBe(0);
    expect(first.lines).toEqual([
      `${stores[0]} (agents/agent): opens`,
      `${stores[1]} (agents/agent): the index lists its session, and no store is there; a start makes an empty one`,
    ]);
    // A file where a directory on a store's path should be: its lstat fails,
    // as it would for a directory the audit may not read.
    const manager = new SessionManager(dir);
    const index = manager.load();
    index.sessions['blocked/inner'] = { ...index.sessions[Object.keys(index.sessions)[0]!]!, id: 'blocked/inner' };
    manager.save(index);
    writeFileSync(join(dir, 'sessions', 'blocked'), 'not a directory');
    const second = await audit([dir]);
    expect(second.status).toBe(1);
    expect(second.failed).toEqual([expect.stringMatching(new RegExp(`^Couldn't audit ${join(dir, 'sessions', 'blocked', 'inner')}: it can't be reached: ENOTDIR`))]);
  });

  test('a recipe whose strategy cannot be built leaves its directory not audited, rather than its stores refused', async () => {
    const { dir } = await makeDataDir('data', [{ namespace: 'agents/agent', crossed: false }]);
    withStrategy(dir, 'broken', "export function register(api) { api.registerStrategy('broken', () => { throw new Error('cannot build'); }); }\n");
    const { status, failed } = await audit([dir]);
    expect(status).toBe(1);
    expect(failed).toEqual([`Couldn't audit ${dir}: cannot build`]);
  });

  test("each store's open gets a strategy of its own", async () => {
    const { dir } = await makeDataDir('data', [
      { namespace: 'agents/agent', crossed: false },
      { namespace: 'agents/agent', crossed: false },
    ]);
    withStrategy(dir, 'counting', [
      `import { PassthroughStrategy } from '${CONTEXT_MANAGER}';`,
      'let made = 0;',
      'export function register(api) {',
      "  api.registerStrategy('counting', () => {",
      '    const strategy = new PassthroughStrategy();',
      '    const id = ++made;',
      '    strategy.initialize = async () => { globalThis.auditTestOpens.push(id); };',
      '    return strategy;',
      '  });',
      '}',
    ].join('\n'));
    const opens: number[] = [];
    (globalThis as { auditTestOpens?: number[] }).auditTestOpens = opens;
    try {
      const { status } = await audit([dir]);
      expect(status).toBe(0);
      // The first is the one built to check the recipe; each open takes a new one.
      expect(opens).toEqual([2, 3]);
    } finally {
      delete (globalThis as { auditTestOpens?: number[] }).auditTestOpens;
    }
  });

  test('a system prompt the recipe gives as a URL is not fetched', async () => {
    const { dir, stores } = await makeDataDir('data', [{ namespace: 'agents/agent', crossed: true }]);
    // Nothing listens on port 1, so a fetch would fail the load.
    saveRecipe(dir, { ...DEFAULT_RECIPE, agent: { ...DEFAULT_RECIPE.agent, systemPrompt: 'http://127.0.0.1:1/prompt.md' } });
    const { status, failed } = await audit([dir]);
    expect(status).toBe(1);
    expect(failed[0]).toStartWith(`${stores[0]} (agents/agent): refused: `);
  });

  test("given the extensions a start loaded, the audit builds its strategy from them and runs no register() of its own", async () => {
    const { dir, stores } = await makeDataDir('data', [{ namespace: 'agents/agent', crossed: false }]);
    const calls = join(root, 'register-calls');
    withStrategy(dir, 'counted', [
      `import { PassthroughStrategy } from '${CONTEXT_MANAGER}';`,
      "import { appendFileSync } from 'node:fs';",
      `export function register(api) { appendFileSync(${JSON.stringify(calls)}, 'register\\n'); api.registerStrategy('counted', () => new PassthroughStrategy()); }`,
    ].join('\n'));
    const recipe = (await loadSavedRecipe(dir))!;
    const loaded = await loadExtensions(recipe);
    expect(readFileSync(calls, 'utf8')).toBe('register\n');
    const given = await audit([dir], { extensions: loaded });
    expect(given.status, given.failed.join('\n')).toBe(0);
    expect(given.lines).toEqual([`${stores[0]} (agents/agent): opens`]);
    expect(readFileSync(calls, 'utf8')).toBe('register\n');
    // Without them, the audit loads the recipe's own.
    expect((await audit([dir])).status).toBe(0);
    expect(readFileSync(calls, 'utf8')).toBe('register\nregister\n');
  });

  test("a module an extension registers isn't built by the audit, which builds only the strategy", async () => {
    const { dir, stores } = await makeDataDir('data', [{ namespace: 'agents/agent', crossed: false }]);
    const built = join(root, 'module-built');
    const registered = join(root, 'module-registered');
    const extension = join(root, 'with-module.ts');
    writeFileSync(extension, [
      "import { writeFileSync } from 'node:fs';",
      `export function register(api) { writeFileSync(${JSON.stringify(registered)}, ''); api.registerModule(() => { writeFileSync(${JSON.stringify(built)}, ''); throw new Error('built'); }); }`,
    ].join('\n'));
    saveRecipe(dir, { ...DEFAULT_RECIPE, extensions: { withModule: { kind: 'module', path: extension } } });
    const { status, lines } = await audit([dir]);
    expect(status).toBe(0);
    expect(lines).toEqual([`${stores[0]} (agents/agent): opens`]);
    expect(existsSync(registered), "the extension's register() never ran").toBe(true);
    expect(existsSync(built)).toBe(false);
  });

  test("an extension's strategy is the resident's, loaded as at a start, and whatever its open throws is one line", async () => {
    const { dir, stores } = await makeDataDir('data', [{ namespace: 'agents/agent', crossed: false }]);
    withStrategy(dir, 'refusing', [
      'export function register(api) {',
      "  api.registerStrategy('refusing', () => ({",
      "    initialize: async () => { throw new Error('this store\\nis not one I open'); },",
      '  }));',
      '}',
    ].join('\n'));
    const { status, failed } = await audit([dir]);
    expect(status).toBe(1);
    expect(failed).toEqual([`${stores[0]} (agents/agent): refused: this store is not one I open`]);
  });

  test("a store whose files this release can't read, such as a state.bin cut short, is refused", async () => {
    const { dir, stores } = await makeDataDir('data', [{ namespace: 'agents/agent', crossed: false }]);
    truncateSync(join(stores[0]!, 'state.bin'), 10);
    const { status, failed } = await audit([dir]);
    expect(status).toBe(1);
    expect(failed).toEqual([`${stores[0]} (agents/agent): refused: IO error: failed to fill whole buffer`]);
  });

  test('a strategy that calls a model while opening its store leaves the store not audited, whatever it does with the error', async () => {
    const calls: Record<string, string> = {
      complete: 'await ctx.membrane.complete({});',
      stream: 'await ctx.membrane.stream({});',
      streamYielding: 'ctx.membrane.streamYielding({});',
      caught: 'try { await ctx.membrane.complete({}); } catch {}',
    };
    for (const [kind, call] of Object.entries(calls)) {
      const { dir, stores } = await makeDataDir(kind, [{ namespace: 'agents/agent', crossed: false }]);
      withStrategy(dir, 'calling', `export function register(api) { api.registerStrategy('calling', () => ({ initialize: async (ctx) => { ${call} } })); }\n`);
      const { status, failed } = await audit([dir]);
      expect(status, kind).toBe(1);
      expect(failed, kind).toEqual([`Couldn't audit ${stores[0]}: ${MODEL_CALLED}`]);
    }
  });

  test("a strategy gets no answer from a model: the call throws, so nothing it would do with an answer happens", async () => {
    const { dir, stores } = await makeDataDir('data', [{ namespace: 'agents/agent', crossed: false }]);
    const answered = join(root, 'answered');
    withStrategy(dir, 'asks', [
      "import { writeFileSync } from 'node:fs';",
      "export function register(api) { api.registerStrategy('asks', () => ({ initialize: async (ctx) => {",
      '  await ctx.membrane.complete({});',
      `  writeFileSync(${JSON.stringify(answered)}, '');`,
      '} })); }',
    ].join('\n'));
    const { failed } = await audit([dir]);
    expect(failed).toEqual([`Couldn't audit ${stores[0]}: ${MODEL_CALLED}`]);
    expect(existsSync(answered)).toBe(false);
  });

  test("a store refused on its topology is refused, though its strategy also called a model", async () => {
    const { dir, stores } = await makeDataDir('data', [{ namespace: 'agents/agent', crossed: true }]);
    // The library's own strategy, whose open checks the store's topology,
    // after a model call it catches. It's another copy of the library than
    // the host's (Bun loads the host's from its source), as an extension's
    // own would be, so its error's class isn't the host's.
    const library = CONTEXT_MANAGER;
    withStrategy(dir, 'calling', [
      `import { AutobiographicalStrategy } from ${JSON.stringify(library)};`,
      "export function register(api) { api.registerStrategy('calling', () => {",
      '  const strategy = new AutobiographicalStrategy({ adaptiveResolution: true, hierarchical: true, autoTickOnNewMessage: false });',
      '  const initialize = strategy.initialize.bind(strategy);',
      '  strategy.initialize = async (ctx) => { try { await ctx.membrane.complete({}); } catch {} return initialize(ctx); };',
      '  return strategy;',
      '}); }',
    ].join('\n'));
    const { status, failed } = await audit([dir]);
    expect(status).toBe(1);
    expect(failed).toEqual([expect.stringMatching(new RegExp(`^${stores[0]} \\(agents/agent\\): refused: store topology rejected: `))]);
    // Its line says where to look, as the host's own copy's does, not what the
    // library suggests.
    expect(failed[0]).toEndWith('AGENT-ONBOARDING.md §11.8 says what a store with crossed summaries needs.');
    expect(failed[0]).not.toContain('topologyPolicy');
  });

  test("the model a strategy finds is each open's own: a store whose open checks for a method opens, and one store's call leaves the next store's open alone", async () => {
    const { dir, stores } = await makeDataDir('data', [
      { namespace: 'agents/agent', crossed: false },
      { namespace: 'agents/agent', crossed: false },
    ]);
    withStrategy(dir, 'once', [
      `import { PassthroughStrategy } from '${CONTEXT_MANAGER}';`,
      'let opens = 0;',
      'export function register(api) {',
      "  api.registerStrategy('once', () => {",
      '    const strategy = new PassthroughStrategy();',
      '    strategy.initialize = async (ctx) => {',
      "      if (!('complete' in ctx.membrane) || !('stream' in ctx.membrane)) throw new Error('needs a membrane');",
      '      if (++opens === 1) { try { await ctx.membrane.complete({}); } catch {} }',
      '    };',
      '    return strategy;',
      '  });',
      '}',
    ].join('\n'));
    const { status, lines } = await audit([dir]);
    // Whichever store is opened first, as the index lists its sessions, meets
    // the call; an id of digits alone is listed first.
    const [first, second] = lines[0]!.startsWith("Couldn't audit") ? [lines[0]!, lines[1]!] : [lines[1]!, lines[0]!];
    const called = stores.find((store) => first === `Couldn't audit ${store}: ${MODEL_CALLED}`);
    expect(called, lines.join('\n')).toBeDefined();
    expect(second).toBe(`${stores.find((store) => store !== called)} (agents/agent): opens`);
    expect(lines).toHaveLength(2);
    expect(status).toBe(1);
  });

  test("a strategy that can't be built for a later store leaves that store not audited, not refused", async () => {
    const { dir, stores } = await makeDataDir('data', [{ namespace: 'agents/agent', crossed: false }]);
    // The first build, which checks the recipe, works; the one for the store doesn't.
    withStrategy(dir, 'fickle', [
      `import { PassthroughStrategy } from '${CONTEXT_MANAGER}';`,
      'let built = 0;',
      "export function register(api) { api.registerStrategy('fickle', () => { if (++built > 1) throw new Error('not twice'); return new PassthroughStrategy(); }); }",
    ].join('\n'));
    const { status, failed } = await audit([dir]);
    expect(status).toBe(1);
    expect(failed).toEqual([`Couldn't audit ${stores[0]}: its strategy couldn't be built for it: not twice`]);
  });

  test("a store that opened and won't close isn't audited, and every store opened is closed, its answer standing", async () => {
    const { dir, stores } = await makeDataDir('data', [
      { namespace: 'agents/agent', crossed: false },
      { namespace: 'agents/agent', crossed: true },
    ]);
    const close = spyOn(ContextManager.prototype, 'close');
    try {
      expect((await audit([dir])).status).toBe(1);
      // The crossed store's namespace never opened, so only the other's closes.
      expect(close).toHaveBeenCalledTimes(1);
      close.mockImplementation(() => { throw new Error('close failed'); });
      const { failed } = await audit([dir]);
      expect(failed).toEqual([
        `Couldn't audit ${stores[0]}: it opened, and closing it failed: close failed`,
        expect.stringMatching(new RegExp(`^${stores[1]} \\(agents/agent\\): refused: store topology rejected: `)),
      ]);
    } finally {
      close.mockRestore();
    }
    // The store itself, which the audit opens as agent-framework does and
    // closes after the agent's namespace.
    // Each store closes, so the next audit can open it, and then says it failed.
    const realClose = JsStore.prototype.close;
    const storeClose = spyOn(JsStore.prototype, 'close').mockImplementation(function (this: JsStore) {
      realClose.call(this);
      throw new Error('store close failed');
    });
    try {
      const { failed } = await audit([dir]);
      expect(failed).toEqual([
        `Couldn't audit ${stores[0]}: it opened, and closing it failed: store close failed`,
        expect.stringMatching(new RegExp(`^${literally(stores[1]!)} \\(agents/agent\\): refused: store topology rejected: [^;]*[^.;]; closing it failed: store close failed$`)),
      ]);
      expect(storeClose).toHaveBeenCalledTimes(2);
      // A store not audited, whose close then fails, says both.
      withStrategy(dir, 'calls', "export function register(api) { api.registerStrategy('calls', () => ({ initialize: async (ctx) => { await ctx.membrane.complete({}); } })); }\n");
      const unaudited = await audit([dir]);
      expect(unaudited.failed).toEqual(stores.map((store) => `Couldn't audit ${store}: ${MODEL_CALLED}; closing it failed: store close failed`));
    } finally {
      storeClose.mockRestore();
    }
  });

  test('an index that is a link to nothing is no index, as for a start, which then takes the legacy store', async () => {
    const dir = join(root, 'legacy');
    await makeStore(join(dir, 'store'), 'agents/agent', true);
    symlinkSync(join(root, 'nowhere.json'), join(dir, 'sessions.json'));
    const { status, failed } = await audit([dir]);
    expect(status).toBe(1);
    expect(failed[0]).toStartWith(`${join(dir, 'store')} (agents/agent): refused: `);
  });

  test('a legacy store, from before sessions, is audited where a start would find it, and no index is made', async () => {
    const dir = join(root, 'legacy');
    await makeStore(join(dir, 'store'), 'agents/agent', true);
    const { status, failed } = await audit([dir]);
    expect(status).toBe(1);
    expect(failed[0]).toStartWith(`${join(dir, 'store')} (agents/agent): refused: `);
    expect(await Bun.file(join(dir, 'sessions.json')).exists()).toBe(false);
  });

  test("a directory it can't audit is said, every directory given is audited, and none given is the usage line", async () => {
    const unreadable = join(root, 'unreadable');
    mkdirSync(unreadable);
    writeFileSync(join(unreadable, '.recipe.json'), 'not json');
    const missing = join(root, 'missing');
    const file = join(root, 'a-file');
    writeFileSync(file, 'not a data directory');
    const badIndex = join(root, 'bad-index');
    mkdirSync(badIndex);
    writeFileSync(join(badIndex, 'sessions.json'), '{ not json');
    const { dir, stores } = await makeDataDir('data', [{ namespace: 'agents/agent', crossed: true }]);
    const { status, failed } = await audit([unreadable, missing, file, badIndex, dir]);
    expect(status).toBe(1);
    expect(failed).toEqual([
      `Couldn't audit ${unreadable}: it isn't JSON`,
      `Couldn't audit ${missing}: it isn't there`,
      `Couldn't audit ${file}: it isn't a directory`,
      expect.stringMatching(new RegExp(`^Couldn't audit ${badIndex}: its session index, sessions\\.json, can't be read: `)),
      expect.stringMatching(new RegExp(`^${stores[0]} \\(agents/agent\\): refused: `)),
    ]);
    const none = await audit([]);
    expect(none.status).toBe(1);
    expect(none.failed).toEqual(['Usage: --audit-stores [--recipe <recipe>] <data directory>…, with one data directory when a recipe is given']);
    // A recipe goes with one data directory, as a start's does.
    const two = await audit([dir, dir], { recipe: join(root, 'kid.json') });
    expect(two.status).toBe(1);
    expect(two.failed).toEqual(['Usage: --audit-stores [--recipe <recipe>] <data directory>…, with one data directory when a recipe is given']);
  });

  test("each line is one line, whatever the directory's path holds", async () => {
    const { dir, stores } = await makeDataDir('new\nline', [{ namespace: 'agents/agent', crossed: true }]);
    const { status, failed } = await audit([dir]);
    expect(status).toBe(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toStartWith(`${stores[0]!.replace('\n', ' ')} (agents/agent): refused: `);
  });

  test('a compression log the environment names gets nothing from the audit, and the variable is put back', async () => {
    const { dir } = await makeDataDir('data', [{ namespace: 'agents/agent', crossed: true }]);
    const log = join(root, 'compression.jsonl');
    process.env.CONTEXT_MANAGER_COMPRESSION_LOG = log;
    try {
      const { status } = await audit([dir]);
      expect(status).toBe(1);
      expect(await Bun.file(log).exists()).toBe(false);
      expect(process.env.CONTEXT_MANAGER_COMPRESSION_LOG).toBe(log);
    } finally {
      delete process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
    }
  });

  test("through the host's entry, with no provider credential: every line on stderr and the exit status, even when an extension keeps a timer", async () => {
    const { dir, stores } = await makeDataDir('data', [
      { namespace: 'agents/agent', crossed: true },
      { namespace: 'agents/agent', crossed: false },
    ]);
    // An extension whose import starts a timer, which would keep a process
    // that waits for its event loop to empty alive.
    const extension = join(root, 'lingering.ts');
    const started = join(root, 'timer-started');
    writeFileSync(extension, [
      "import { writeFileSync } from 'node:fs';",
      'setInterval(() => {}, 3_600_000);',
      `writeFileSync(${JSON.stringify(started)}, 'started');`,
      'export function register() {}',
    ].join('\n'));
    saveRecipe(dir, { ...DEFAULT_RECIPE, extensions: { lingering: { kind: 'module', path: extension } } });
    const env: Record<string, string | undefined> = { ...process.env };
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_CREDENTIALS_FILE', 'DATA_DIR']) delete env[key];
    const child = spawn('bun', [INDEX_PATH, '--audit-stores', dir], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.resume();
    // 'close' comes once the child has exited and its output is all read.
    const ended = new Promise<number | null>((done) => child.on('close', (code) => done(code)));
    const status = await Promise.race([ended, Bun.sleep(60_000).then(() => 'still running' as const)]);
    if (status === 'still running') child.kill('SIGKILL');
    expect(status, stderr).toBe(1);
    expect(existsSync(started)).toBe(true);
    expect(stderr).toMatch(new RegExp(`(^|\\n)${stores[0]} \\(agents/agent\\): refused: store topology rejected: `));
    expect(stderr).toContain(`${stores[1]} (agents/agent): opens\n`);
  }, 90_000);

  test("through the host's entry, a directory whose stores open exits 0, and none given exits 1 with the usage line", async () => {
    const { dir, stores } = await makeDataDir('data', [{ namespace: 'agents/agent', crossed: false }]);
    const clean = await entry([dir]);
    expect(clean.status, clean.stderr).toBe(0);
    expect(clean.stderr).toContain(`${stores[0]} (agents/agent): opens\n`);
    // A root that holds no release, which would stop a host's start, doesn't
    // stop the audit, whose dispatch comes first.
    const rootless = await entry([dir], { env: { CONNECTOME_INSTALL_ROOT: join(root, 'no-install') } });
    expect(rootless.status, rootless.stderr).toBe(0);
    expect(rootless.stderr).toContain(`${stores[0]} (agents/agent): opens\n`);
    const misplaced = await entry([dir, '--recipe', join(root, 'r.json')]);
    expect(misplaced.status).toBe(1);
    expect(misplaced.stderr).toContain('Usage: --audit-stores [--recipe <recipe>] <data directory>…');
    expect(misplaced.stderr).not.toContain(': opens');
    const none = await entry([]);
    expect(none.status).toBe(1);
    expect(none.stderr).toContain('Usage: --audit-stores [--recipe <recipe>] <data directory>…, with one data directory when a recipe is given');
  }, 60_000);

  test("through the host's entry, a line reaches stderr whole, though it's longer than a pipe holds and its reader starts late", async () => {
    // Bun 1.4.3 drops what's still queued for a pipe at process.exit: a probe
    // read 475,072 of 1,000,000 bytes from a child that wrote them and exited
    // while its reader held off.
    const { dir, stores } = await makeDataDir('data', [{ namespace: 'agents/agent', crossed: false }]);
    const refusing = join(root, 'refusing');
    withStrategy(dir, 'wordy', [
      "import { writeFileSync } from 'node:fs';",
      `export function register(api) { api.registerStrategy('wordy', () => ({ initialize: async () => { writeFileSync(${JSON.stringify(refusing)}, ''); throw new Error('x'.repeat(1_000_000)); } })); }`,
    ].join('\n'));
    // Held from the moment its strategy refuses, which comes just before the
    // line is written, until the audit exits or 3 s have passed.
    const { status, stderr } = await entry([dir], { holdAfter: refusing });
    expect(status, stderr.slice(-2000)).toBe(1);
    expect(stderr).toContain(`${stores[0]} (agents/agent): refused: ${'x'.repeat(1_000_000)}\n`);
  }, 60_000);
});

describe("what a strategy's open and an index can do", () => {
  test('a strategy that awaits its membrane while opening its store opens, and one that throws something other than an Error is refused on one line', async () => {
    const { dir: awaiting, stores: awaited } = await makeDataDir('awaiting', [{ namespace: 'agents/agent', crossed: false }]);
    withStrategy(awaiting, 'awaits', "export function register(api) { api.registerStrategy('awaits', () => ({ initialize: async (ctx) => { await ctx.membrane; } })); }\n");
    const opens = await audit([awaiting]);
    expect(opens.status, opens.lines.join('\n')).toBe(0);
    expect(opens.lines).toEqual([`${awaited[0]} (agents/agent): opens`]);
    const { dir: plain, stores: thrown } = await makeDataDir('plain', [{ namespace: 'agents/agent', crossed: false }]);
    withStrategy(plain, 'words', "export function register(api) { api.registerStrategy('words', () => ({ initialize: async () => { throw 'plain words\\nand a second line'; } })); }\n");
    const refused = await audit([plain]);
    expect(refused.failed).toEqual([`${thrown[0]} (agents/agent): refused: plain words and a second line`]);
  });

  test("a store an index names outside its data directory isn't opened", async () => {
    const { dir, stores } = await makeDataDir('data', [
      { namespace: 'agents/agent', crossed: false },
      { namespace: 'agents/agent', crossed: false },
    ]);
    // The second session's entry, as one naming a store two levels up.
    const index = JSON.parse(readFileSync(join(dir, 'sessions.json'), 'utf8'));
    // Not by position: a key of digits alone comes first in an object's keys.
    const second = Object.keys(index.sessions).find((key) => key !== index.activeSessionId);
    const escaped = '../../escaped';
    index.sessions[escaped] = { ...index.sessions[second!], id: escaped };
    delete index.sessions[second!];
    writeFileSync(join(dir, 'sessions.json'), JSON.stringify(index));
    const outside = new SessionManager(dir).getStorePath(escaped);
    await makeStore(outside, 'agents/agent', false);
    const opened: string[] = [];
    const openStore = JsStore.openOrCreate.bind(JsStore);
    const opening = spyOn(JsStore, 'openOrCreate').mockImplementation((config) => {
      opened.push(config.path);
      return openStore(config);
    });
    let result: Awaited<ReturnType<typeof audit>>;
    try {
      result = await audit([dir]);
    } finally {
      opening.mockRestore();
    }
    expect(opened).toEqual([stores[0]!]);
    expect(result.status).toBe(1);
    expect(result.failed).toEqual([outsideLine(outside, dir, false)]);
  });
});

describe("a fleet child's audit, in a process of its own", () => {
  /** A parent whose recipe names one child for each recipe given, each in a
   *  directory of its own with a store that opens. */
  async function parentOf(children: Array<{ name: string; extension?: string; dir?: string }>) {
    const parent = await makeDataDir('parent', [{ namespace: 'agents/agent', crossed: false }]);
    const entries = [];
    const dirs: Record<string, { dir: string; stores: string[] }> = {};
    for (const child of children) {
      dirs[child.name] = await makeDataDirWith(child.dir ?? child.name, [(store) => makeStore(store, 'agents/agent', false)]);
      const recipe = join(root, `${child.name}.json`);
      const extension = child.extension === undefined ? undefined : join(root, `${child.name}-extension.ts`);
      if (extension !== undefined) writeFileSync(extension, child.extension!);
      writeFileSync(recipe, JSON.stringify({
        ...DEFAULT_RECIPE, ...(extension === undefined ? {} : { extensions: { [child.name]: { kind: 'module', path: extension } } }),
      }));
      entries.push({ name: child.name, recipe, dataDir: dirs[child.name]!.dir });
    }
    saveRecipe(parent.dir, { ...DEFAULT_RECIPE, agent: { ...DEFAULT_RECIPE.agent, timezone: 'Pacific/Auckland' }, modules: { ...DEFAULT_RECIPE.modules, fleet: { children: entries } } });
    return { parent, dirs };
  }

  test("runs with the environment the fleet gives the child, and its exit status, a signal included, decides whether it failed", async () => {
    const receipt = join(root, 'receipt.json');
    const { parent, dirs } = await parentOf([
      {
        name: 'recorder',
        extension: [
          "import { writeFileSync } from 'node:fs';",
          `writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ dataDir: process.env.DATA_DIR, timeZone: process.env.AGENT_TIMEZONE, installRoot: process.env.CONNECTOME_INSTALL_ROOT ?? null }));`,
          'export function register() {}',
        ].join('\n'),
      },
      { name: 'quitter', extension: 'process.exit(3);\nexport function register() {}' },
      // 1 is the audit's own failure status, here with no line to explain it.
      { name: 'leaver', extension: 'process.exit(1);\nexport function register() {}' },
      // A line that reads as a failure, and then a status no audit gives.
      { name: 'partial', extension: "import { writeSync } from 'node:fs';\nwriteSync(2, \"Couldn't audit what this extension says\\n\");\nprocess.exit(3);\nexport function register() {}" },
      // A clean child whose extension writes a line that reads as a failure.
      { name: 'chatty', extension: "import { writeSync } from 'node:fs';\nwriteSync(2, \"Couldn't audit what this extension says\\n\");\nexport function register() {}" },
      { name: 'killed', extension: "process.kill(process.pid, 'SIGTERM');\nawait new Promise(() => {});\nexport function register() {}" },
      // A clean child whose lines hold what a failure's line holds.
      { name: 'odd', dir: "odd Couldn't audit dir" },
    ]);
    process.env.CONNECTOME_INSTALL_ROOT = join(root, 'an-install');
    let result: Awaited<ReturnType<typeof audit>>;
    try {
      result = await audit([parent.dir]);
    } finally {
      delete process.env.CONNECTOME_INSTALL_ROOT;
    }
    expect(JSON.parse(readFileSync(receipt, 'utf8'))).toEqual({ dataDir: dirs.recorder!.dir, timeZone: 'Pacific/Auckland', installRoot: null });
    expect(result.status).toBe(1);
    expect(result.failed).toEqual([
      unfinishedLine(dirs.quitter!.dir, 'exited with status 3', parent.dir),
      unfinishedLine(dirs.leaver!.dir, 'exited with status 1', parent.dir),
      "Couldn't audit what this extension says",
      unfinishedLine(dirs.partial!.dir, 'exited with status 3', parent.dir),
      unfinishedLine(dirs.killed!.dir, 'was ended by SIGTERM', parent.dir),
    ]);
    expect(result.lines).toContain(`${dirs.odd!.stores[0]} (agents/agent): opens`);
    expect(result.lines).toContain(`${dirs.chatty!.stores[0]} (agents/agent): opens`);
  }, 90_000);

  test("what a child's audit prints on stdout reaches no one, and its lines still come on stderr", async () => {
    const ran = join(root, 'printer-ran');
    const { parent, dirs } = await parentOf([{
      name: 'printer',
      extension: [
        "import { writeFileSync } from 'node:fs';",
        "console.log('printed by the extension');",
        "process.stdout.write('written by the extension\\n');",
        `writeFileSync(${JSON.stringify(ran)}, '');`,
        'export function register() {}',
      ].join('\n'),
    }]);
    const { status, stdout, stderr } = await entry([parent.dir]);
    expect(status, stderr).toBe(0);
    expect(existsSync(ran), "the child's audit never loaded its extension").toBe(true);
    expect(stdout).not.toContain('by the extension');
    expect(stderr).not.toContain('by the extension');
    expect(stderr).toContain(`${dirs.printer!.stores[0]} (agents/agent): opens\n`);
  }, 60_000);

  test("a child's audit that doesn't end within its limit is ended, with its group, and holds the commit", async () => {
    const pidFile = join(root, 'stuck.pid');
    const { parent, dirs } = await parentOf([{
      name: 'stuck',
      // An extension that waits at its import for good.
      extension: [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
        'setInterval(() => {}, 1_000);',
        'await new Promise(() => {});',
        'export function register() {}',
      ].join('\n'),
    }]);
    // The limit, 1 minute as the audit's environment sets it, made a second,
    // counted from the moment the child's extension has begun its wait.
    const before = process.env.CONNECTOME_FLEET_CHILD_AUDIT_MINUTES;
    leftovers.push(() => { if (before === undefined) delete process.env.CONNECTOME_FLEET_CHILD_AUDIT_MINUTES; else process.env.CONNECTOME_FLEET_CHILD_AUDIT_MINUTES = before; });
    process.env.CONNECTOME_FLEET_CHILD_AUDIT_MINUTES = '1';
    const limit = limitWhen(() => existsSync(pidFile), 60_000);
    // A timer of the same minute the audit didn't arm isn't its limit: it's
    // armed as it asked, not counted, and not fired early.
    let strayFired = false;
    let stray: ReturnType<typeof setTimeout> | undefined;
    const kill = process.kill.bind(process);
    const killed: number[] = [];
    const killing = spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      if (pid < 0 && signal === 'SIGKILL') killed.push(-pid);
      return kill(pid, signal);
    }) as typeof process.kill);
    let result: Awaited<ReturnType<typeof audit>>;
    try {
      stray = setTimeout(() => { strayFired = true; }, 60_000);
      result = await audit([parent.dir]);
    } finally {
      // The stray's real minute would outlast this test.
      clearTimeout(stray);
      limit.restore();
      killing.mockRestore();
      if (before === undefined) delete process.env.CONNECTOME_FLEET_CHILD_AUDIT_MINUTES;
      else process.env.CONNECTOME_FLEET_CHILD_AUDIT_MINUTES = before;
    }
    expect(result.status).toBe(1);
    expect(limit.armed()).toBe(1);
    expect(strayFired).toBe(false);
    // Its group was sent SIGKILL at the limit.
    expect(killed).toContain(Number(readFileSync(pidFile, 'utf8')));
    expect(result.failed).toEqual([`Couldn't audit ${dirs.stuck!.dir}: its audit didn't end within 1 minute, so it was ` +
      "sent SIGKILL, and it isn't known that every store there was audited. Something may have held it, such as an " +
      'extension that waits at its import, a recipe slow to load, or a store slow to open: ' +
      `${byHand(parent.dir)}, and shows where it stops, should it stop again. Where its stores need longer, ` +
      "CONNECTOME_FLEET_CHILD_AUDIT_MINUTES in this host's environment gives it more minutes."]);
    expect(existsSync(pidFile), "the child's audit never reached its extension").toBe(true);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(await waitForEnd(pid, 10_000)).toBe(true);
  }, 60_000);

  test("a child's audit that can't be started says why without the value its spawn refused", async () => {
    const parent = await makeDataDir('parent', [{ namespace: 'agents/agent', crossed: false }]);
    const child = await makeDataDir('kid', [{ namespace: 'agents/agent', crossed: false }]);
    const secret = 'top-secret-env-value';
    saveRecipe(parent.dir, {
      ...DEFAULT_RECIPE,
      modules: { ...DEFAULT_RECIPE.modules, fleet: { children: [
        { name: 'kid', recipe: childRecipe('kid'), dataDir: child.dir, env: { AUDIT_TEST_SECRET: `${secret}\0` } },
      ] } },
    });
    const { status, failed, lines } = await audit([parent.dir]);
    expect(status).toBe(1);
    expect(failed).toEqual([expect.stringMatching(new RegExp(
      `^Couldn't audit ${child.dir}: its audit couldn't be started: .*AUDIT_TEST_SECRET.*\\(ERR_INVALID_ARG_VALUE\\)$`))]);
    expect(lines.join('\n')).not.toContain(secret);
  }, 60_000);

  test("a child's audit ended after it said it had finished, by a signal or a status other than the one it said, a refusal's made 0 included, gives no answer to take", async () => {
    const { parent, dirs } = await parentOf([
      {
        name: 'ended',
        // Ended by a signal as it exits, after its last line.
        extension: "process.on('exit', () => { process.kill(process.pid, 'SIGKILL'); });\nexport function register() {}",
      },
      // A clean audit whose status is made one no audit gives as it exits,
      // after its last line.
      { name: 'other', extension: "process.on('exit', () => { process.exit(2); });\nexport function register() {}" },
      // An audit that refused a store, whose status is made 0 as it exits, as
      // an extension's own cleanup might.
      { name: 'cleaned', extension: "process.on('exit', () => { process.exit(0); });\nexport function register() {}" },
    ]);
    // The last child's store is one a start refuses.
    rmSync(dirs.cleaned!.stores[0]!, { recursive: true, force: true });
    await makeStore(dirs.cleaned!.stores[0]!, 'agents/agent', true);
    const { status, failed } = await audit([parent.dir]);
    expect(status).toBe(1);
    const setThat = "Something in its process, such as an extension's exit handler, set that status: " +
      `${byHand(parent.dir)}, and shows whether it happens again.`;
    expect(failed).toEqual([
      `Couldn't audit ${dirs.ended!.dir}: its audit ran to its end and said it had finished, but was then ended by ` +
        `SIGKILL, so its answer can't be taken: ${byHand(parent.dir)}.`,
      `Couldn't audit ${dirs.other!.dir}: its audit ran to its end and said it would exit with status 0, but exited ` +
        `with status 2, so its answer can't be taken. ${setThat}`,
      expect.stringMatching(new RegExp(`^${literally(dirs.cleaned!.stores[0]!)} \\(agents/agent\\): refused: `)),
      `Couldn't audit ${dirs.cleaned!.dir}: its audit ran to its end and said it would exit with status 1, but exited ` +
        `with status 0, so its answer can't be taken. ${setThat}`,
    ]);
  }, 60_000);

  test("a line that only resembles the finished line, prefixed or with a status no audit gives, doesn't change a child's answer", async () => {
    const { parent, dirs } = await parentOf([{
      name: 'echoes',
      extension: "import { writeSync } from 'node:fs';\nprocess.on('exit', () => { writeSync(2, 'echo: --fleet-child audit finished: 1\\n--fleet-child audit finished: 2\\n'); });\nexport function register() {}",
    }]);
    const { status, failed, lines } = await audit([parent.dir]);
    expect(status, lines.join('\n')).toBe(0);
    expect(failed).toEqual([]);
    expect(lines).toContain(`${dirs.echoes!.stores[0]} (agents/agent): opens`);
    expect(lines).toContain('echo: --fleet-child audit finished: 1');
    expect(lines).toContain('--fleet-child audit finished: 2');
  }, 60_000);

  test("a child's audit that finishes with 1 and says of no store why isn't taken as clean", async () => {
    const { parent, dirs } = await parentOf([{
      name: 'silent',
      // A clean audit whose status is made 1 as it exits, after a last line
      // that imitates the audit's own saying it ends with 1, which only such
      // an imitation can give without a line saying why.
      extension: "import { writeSync } from 'node:fs';\nprocess.on('exit', () => { writeSync(2, '--fleet-child audit finished: 1\\n'); process.exit(1); });\nexport function register() {}",
    }]);
    const { status, failed, lines } = await audit([parent.dir]);
    expect(status).toBe(1);
    expect(failed).toEqual([`Couldn't audit ${dirs.silent!.dir}: its audit answered 1 and said of no store why, so it can't be ` +
      `taken as clean: ${byHand(parent.dir)}.`]);
    expect(lines).toContain(`${dirs.silent!.stores[0]} (agents/agent): opens`);
  }, 60_000);

  test('ends once the child audit has exited, though a helper it started still holds its stderr', async () => {
    const pidFile = join(root, 'helper.pid');
    const { parent, dirs } = await parentOf([{
      name: 'helper',
      extension: [
        "import { spawn } from 'node:child_process';",
        "import { writeFileSync } from 'node:fs';",
        "const helper = spawn('sleep', ['60'], { stdio: ['ignore', 'ignore', 'inherit'] });",
        `writeFileSync(${JSON.stringify(pidFile)}, String(helper.pid));`,
        'export function register() {}',
      ].join('\n'),
    }]);
    const { status, lines } = await audit([parent.dir]);
    expect(status).toBe(0);
    expect(lines).toContain(`${dirs.helper!.stores[0]} (agents/agent): opens`);
    const helper = Number(readFileSync(pidFile, 'utf8'));
    let ended = false;
    try {
      // Ended with the audit's group.
      ended = await waitForEnd(helper, 10_000);
      expect(ended).toBe(true);
    } finally {
      // Only one that hasn't ended: an ended helper's pid may be another
      // process's by now.
      if (!ended) {
        try { process.kill(helper, 'SIGKILL'); } catch { /* it has ended since */ }
      }
    }
  }, 90_000);
});

describe("a fleet child's audit and what outlasts it", () => {
  test("a child's audit that writes after its finished line, as an extension's exit can, is still an answer", async () => {
    const parent = await makeDataDir('parent', [{ namespace: 'agents/agent', crossed: false }]);
    const child = await makeDataDir('kid', [{ namespace: 'agents/agent', crossed: false }]);
    const extension = join(root, 'says-goodbye.ts');
    writeFileSync(extension, "import { writeSync } from 'node:fs';\nprocess.on('exit', () => { writeSync(2, 'goodbye\\n'); });\nexport function register() {}\n");
    const recipe = childRecipe('kid', { extensions: { goodbye: { kind: 'module', path: extension } } });
    saveRecipe(parent.dir, { ...DEFAULT_RECIPE, modules: { ...DEFAULT_RECIPE.modules, fleet: { children: [{ name: 'kid', recipe, dataDir: child.dir }] } } });
    const { status, lines } = await audit([parent.dir]);
    expect(status, lines.join('\n')).toBe(0);
    expect(lines).toContain(`${child.stores[0]} (agents/agent): opens`);
    expect(lines).toContain('goodbye');
    expect(lines.filter((line) => line.includes('--fleet-child audit finished'))).toEqual([]);
  }, 60_000);

  /** A spy under which a SIGKILL to a process group reaches nothing, as for a
   *  process that outlasts one, with the groups it was sent to. */
  function groupKillsMissed(): { groups: number[]; restore: () => void } {
    const kill = process.kill.bind(process);
    const groups: number[] = [];
    const spy = spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      if (pid < 0 && signal === 'SIGKILL') {
        groups.push(-pid);
        return true;
      }
      return kill(pid, signal);
    }) as typeof process.kill);
    return { groups, restore: () => spy.mockRestore() };
  }
  const bootNow = (): string | null => {
    try {
      return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null;
    } catch {
      return null;
    }
  };

  test("on a trial, a child's audit whose group outlasts its SIGKILL stays listed, and the host says how to end it", async () => {
    const parent = await makeDataDir('parent', [{ namespace: 'agents/agent', crossed: false }]);
    const child = await makeDataDir('kid', [{ namespace: 'agents/agent', crossed: false }]);
    const file = childrenFilePath(parent.dir);
    const helperPid = join(root, 'helper.pid');
    const extension = join(root, 'leaves.ts');
    writeFileSync(extension, [
      "import { spawn } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      "const helper = spawn('sleep', ['60'], { stdio: 'ignore' });",
      `writeFileSync(${JSON.stringify(helperPid)}, String(helper.pid));`,
      'helper.unref();',
      'export function register() {}',
    ].join('\n'));
    const recipe = childRecipe('kid', { extensions: { leaves: { kind: 'module', path: extension } } });
    saveRecipe(parent.dir, { ...DEFAULT_RECIPE, modules: { ...DEFAULT_RECIPE.modules, fleet: { children: [{ name: 'kid', recipe, dataDir: child.dir }] } } });
    const missed = groupKillsMissed();
    const logged: string[] = [];
    const log = spyOn(console, 'error').mockImplementation((line) => { logged.push(String(line)); });
    let result: Awaited<ReturnType<typeof audit>>;
    try {
      result = await audit([parent.dir], { within: [root], listIn: file });
    } finally {
      missed.restore();
      log.mockRestore();
    }
    const [group] = missed.groups;
    try {
      expect(result.status, result.lines.join('\n')).toBe(0);
      expect(missed.groups).toHaveLength(1);
      expect(JSON.parse(readFileSync(file, 'utf8')).children).toEqual([
        { name: "kid's store audit", pid: group, bootId: bootNow(), dataDir: child.dir },
      ]);
      expect(logged).toContain(`[update] kid's store audit (pid ${group}) still has a process in its group after its ` +
        `SIGKILL, so it stays listed in ${file} while that group has one. ` +
        "Once sure that group is this audit's, whoever runs this host can end it, as a user allowed to signal it, with " +
        `\`kill -KILL -- -${group}\`; a process held in the kernel ends only once the kernel lets it go.`);
    } finally {
      try { process.kill(-group!, 'SIGKILL'); } catch { /* gone */ }
    }
  }, 60_000);

  test("a child's audit that said it finished but didn't end within its limit had run to its end, and its line says so", async () => {
    const parent = await makeDataDir('parent', [{ namespace: 'agents/agent', crossed: false }]);
    const child = await makeDataDir('held', [{ namespace: 'agents/agent', crossed: false }]);
    const heldFile = join(root, 'held.pid');
    const extension = join(root, 'held.ts');
    // Held as its process exits, after its last line, as an extension's exit
    // handler could hold it.
    writeFileSync(extension, [
      "import { writeFileSync } from 'node:fs';",
      `process.on('exit', () => { writeFileSync(${JSON.stringify(heldFile)}, String(process.pid)); for (;;) { /* held */ } });`,
      'export function register() {}',
    ].join('\n'));
    const recipe = childRecipe('held', { extensions: { held: { kind: 'module', path: extension } } });
    saveRecipe(parent.dir, { ...DEFAULT_RECIPE, modules: { ...DEFAULT_RECIPE.modules, fleet: { children: [{ name: 'held', recipe, dataDir: child.dir }] } } });
    // A setting under a minute, its line's figure not rounded to 0.
    const before = process.env.CONNECTOME_FLEET_CHILD_AUDIT_MINUTES;
    leftovers.push(() => { if (before === undefined) delete process.env.CONNECTOME_FLEET_CHILD_AUDIT_MINUTES; else process.env.CONNECTOME_FLEET_CHILD_AUDIT_MINUTES = before; });
    process.env.CONNECTOME_FLEET_CHILD_AUDIT_MINUTES = '0.01';
    const limit = limitWhen(() => existsSync(heldFile), 600);
    leftovers.push(() => { if (existsSync(heldFile)) process.kill(-Number(readFileSync(heldFile, 'utf8')), 'SIGKILL'); });
    let result: Awaited<ReturnType<typeof audit>>;
    try {
      result = await audit([parent.dir]);
    } finally {
      limit.restore();
      if (before === undefined) delete process.env.CONNECTOME_FLEET_CHILD_AUDIT_MINUTES;
      else process.env.CONNECTOME_FLEET_CHILD_AUDIT_MINUTES = before;
    }
    expect(result.status).toBe(1);
    expect(result.lines).toContain(`${child.stores[0]} (agents/agent): opens`);
    expect(limit.armed()).toBe(1);
    expect(result.failed).toEqual([`Couldn't audit ${child.dir}: its audit ran to its end and said it had finished, ` +
      "but didn't end within 0.01 minutes, so it was sent SIGKILL, and its answer can't be taken. Something held it after " +
      `its last store, such as an extension in its process: ${byHand(parent.dir)}. If it is held again, inspect the ` +
      "child's process."]);
    // The SIGKILL its limit sent ended it.
    const held = Number(readFileSync(heldFile, 'utf8'));
    expect(await waitForEnd(held, 10_000)).toBe(true);
  }, 60_000);

  test("a child's audit has the minutes the audit's environment gives it, and 5 where it gives none it can use", async () => {
    const parent = await makeDataDir('parent', [{ namespace: 'agents/agent', crossed: false }]);
    const child = await makeDataDir('kid', [{ namespace: 'agents/agent', crossed: false }]);
    // The child's entry gives a setting of its own, which is the child's, not
    // its audit's limit. The parent's strategy arms a long timer of its own,
    // as a library the audit calls can: only the audit's own timers count.
    const timing = join(root, 'timing-strategy.ts');
    writeFileSync(timing, [
      `import { PassthroughStrategy } from '${CONTEXT_MANAGER}';`,
      "export function register(api) { api.registerStrategy('timing', () => { setTimeout(() => {}, 60_000).unref(); return new PassthroughStrategy(); }); }",
    ].join('\n'));
    saveRecipe(parent.dir, {
      ...DEFAULT_RECIPE,
      extensions: { timing: { kind: 'strategy', path: timing } },
      agent: { ...DEFAULT_RECIPE.agent, strategy: { type: 'timing' } },
      modules: { ...DEFAULT_RECIPE.modules, fleet: { children: [{ name: 'kid', recipe: childRecipe('kid'), dataDir: child.dir, env: { CONNECTOME_FLEET_CHILD_AUDIT_MINUTES: '9' } }] } },
    });
    const before = process.env.CONNECTOME_FLEET_CHILD_AUDIT_MINUTES;
    leftovers.push(() => { if (before === undefined) delete process.env.CONNECTOME_FLEET_CHILD_AUDIT_MINUTES; else process.env.CONNECTOME_FLEET_CHILD_AUDIT_MINUTES = before; });
    const later = globalThis.setTimeout;
    const limits: number[] = [];
    let others = 0;
    const timers = spyOn(globalThis, 'setTimeout').mockImplementation(((handler: () => void, ms?: number, ...rest: unknown[]) => {
      if (typeof ms === 'number' && ms >= 60_000) {
        if (armedByAudit()) limits.push(ms);
        else others++;
      }
      return later(handler, ms, ...rest);
    }) as typeof setTimeout);
    try {
      for (const minutes of ['7.5', '1e9', 'Infinity', '0', '-1', 'soon', undefined]) {
        if (minutes === undefined) delete process.env.CONNECTOME_FLEET_CHILD_AUDIT_MINUTES;
        else process.env.CONNECTOME_FLEET_CHILD_AUDIT_MINUTES = minutes;
        const result = await audit([parent.dir]);
        expect(result.status, result.failed.join('\n')).toBe(0);
      }
    } finally {
      timers.mockRestore();
      if (before === undefined) delete process.env.CONNECTOME_FLEET_CHILD_AUDIT_MINUTES;
      else process.env.CONNECTOME_FLEET_CHILD_AUDIT_MINUTES = before;
    }
    // A billion minutes, or Infinity, is more than a timer holds, so it's the
    // longest one does.
    expect(limits).toEqual([7.5 * 60_000, 2 ** 31 - 1, 2 ** 31 - 1, 5 * 60_000, 5 * 60_000, 5 * 60_000, 5 * 60_000]);
    // At least one long timer armed from outside the audit was left out, as
    // the parent's strategy arms one each time it's built; the count doesn't
    // say which caller armed it.
    expect(others).toBeGreaterThan(0);
  }, 90_000);

  test("a child's audit past its limit whose SIGKILL ends nothing is settled without it, and stays listed", async () => {
    const parent = await makeDataDir('parent', [{ namespace: 'agents/agent', crossed: false }]);
    const child = await makeDataDir('stuck', [{ namespace: 'agents/agent', crossed: false }]);
    const file = childrenFilePath(parent.dir);
    const pidFile = join(root, 'stuck.pid');
    const extension = join(root, 'stuck.ts');
    // Stuck without a turn of its event loop, so nothing but a SIGKILL could
    // end it, its stdin's end included.
    writeFileSync(extension, [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      'for (;;) { /* stuck */ }',
      'export function register() {}',
    ].join('\n'));
    const recipe = childRecipe('stuck', { extensions: { stuck: { kind: 'module', path: extension } } });
    saveRecipe(parent.dir, { ...DEFAULT_RECIPE, modules: { ...DEFAULT_RECIPE.modules, fleet: { children: [{ name: 'stuck', recipe, dataDir: child.dir }] } } });
    const limit = limitWhen(() => existsSync(pidFile));
    const missed = groupKillsMissed();
    const log = spyOn(console, 'error').mockImplementation(() => {});
    // The busy child is ended after the test, however the audit went.
    leftovers.push(() => { if (existsSync(pidFile)) process.kill(-Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); });
    let result: Awaited<ReturnType<typeof audit>>;
    try {
      result = await audit([parent.dir], { within: [root], listIn: file });
    } finally {
      limit.restore();
      missed.restore();
      log.mockRestore();
    }
    const pid = Number(readFileSync(pidFile, 'utf8'));
    try {
      expect(result.status).toBe(1);
      expect(missed.groups).toEqual([pid]);
      expect(result.failed).toEqual([`Couldn't audit ${child.dir}: its audit didn't end within 5 minutes, so it was ` +
        "sent SIGKILL, and it isn't known that every store there was audited. Something may have held it, such as an " +
        'extension that waits at its import, a recipe slow to load, or a store slow to open: ' +
        `${byHand(parent.dir)}, and shows where it stops, should it stop again. Where its stores need longer, ` +
        "CONNECTOME_FLEET_CHILD_AUDIT_MINUTES in this host's environment gives it more minutes."]);
      expect(processEnded(pid)).toBe(false);
      expect(JSON.parse(readFileSync(file, 'utf8')).children).toEqual([
        { name: "stuck's store audit", pid, bootId: bootNow(), dataDir: child.dir },
      ]);
    } finally {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
    }
  }, 60_000);
});

describe("which fleet children an audit follows, and how", () => {
  test("a child's own fleet entries aren't followed, so no audit reaches past one level, and a cycle ends", async () => {
    const parent = await makeDataDir('parent', [{ namespace: 'agents/agent', crossed: false }]);
    const child = await makeDataDir('child', [{ namespace: 'agents/agent', crossed: false }]);
    const grandchild = await makeDataDir('grandchild', [{ namespace: 'agents/agent', crossed: true }]);
    // The child's recipe names a child of its own, and the parent again.
    const recipe = childRecipe('kid', {
      modules: { ...DEFAULT_RECIPE.modules, fleet: { children: [
        { name: 'grand', recipe: childRecipe('grand'), dataDir: grandchild.dir },
        { name: 'back', recipe: childRecipe('back'), dataDir: parent.dir },
      ] } },
    });
    saveRecipe(parent.dir, { ...DEFAULT_RECIPE, modules: { ...DEFAULT_RECIPE.modules, fleet: { children: [{ name: 'kid', recipe, dataDir: child.dir }] } } });
    const { status, lines } = await audit([parent.dir]);
    expect(status, lines.join('\n')).toBe(0);
    expect(lines.filter((line) => line.startsWith(root))).toEqual([
      `${parent.stores[0]} (agents/agent): opens`,
      `${child.dir}: audited as ${parent.dir}'s fleet child kid, under the recipe its entry names, in the environment the fleet starts it with`,
      `${child.stores[0]} (agents/agent): opens`,
    ]);
  }, 90_000);

  test('each entry naming a directory is audited under its own recipe, and a directory given that an entry names is that child, whatever its own recipe declares', async () => {
    delete process.env.AUDIT_TEST_CHILD_NAME;
    const parent = await makeDataDir('parent', [{ namespace: 'agents/agent', crossed: false }]);
    const child = await makeDataDir('child', [{ namespace: 'agents/Kid', crossed: true }]);
    // Its saved recipe names a fleet of its own, which would make it a parent.
    saveRecipe(child.dir, { ...DEFAULT_RECIPE, modules: { ...DEFAULT_RECIPE.modules, fleet: { children: [{ name: 'x', recipe: childRecipe('x'), dataDir: join(root, 'x') }] } } });
    const plain = childRecipe('plain');
    const named = childRecipe('named', { agent: { ...DEFAULT_RECIPE.agent, name: '${AUDIT_TEST_CHILD_NAME}' } });
    saveRecipe(parent.dir, {
      ...DEFAULT_RECIPE,
      modules: { ...DEFAULT_RECIPE.modules, fleet: { children: [
        { name: 'plain', recipe: plain, dataDir: child.dir },
        { name: 'named', recipe: named, dataDir: child.dir, env: { AUDIT_TEST_CHILD_NAME: 'Kid' } },
      ] } },
    });
    const { status, lines, failed } = await audit([parent.dir, child.dir]);
    expect(status).toBe(1);
    // The plain entry opens the store under agents/agent, where it holds
    // nothing; the named one opens agents/Kid, which is crossed.
    expect(lines).toContain(`${child.dir}: audited as ${parent.dir}'s fleet child plain, under the recipe its entry names, in the environment the fleet starts it with`);
    expect(lines).toContain(`${child.dir}: audited as ${parent.dir}'s fleet child named, under the recipe its entry names, in the environment the fleet starts it with`);
    expect(lines).toContain(`${child.stores[0]} (agents/agent): opens`);
    expect(failed.map((line) => line.slice(0, line.indexOf(': ')))).toEqual([`${child.stores[0]} (agents/Kid)`]);
    expect(lines.some((line) => line.includes(join(root, 'x')))).toBe(false);
  }, 90_000);

  test("a parent whose recipe names its own directory as a child is audited as itself, and its other children are followed", async () => {
    const parent = await makeDataDir('parent', [{ namespace: 'agents/agent', crossed: false }]);
    const other = await makeDataDir('other', [{ namespace: 'agents/agent', crossed: true }]);
    saveRecipe(parent.dir, { ...DEFAULT_RECIPE, modules: { ...DEFAULT_RECIPE.modules, fleet: { children: [
      { name: 'self', recipe: childRecipe('self'), dataDir: parent.dir },
      { name: 'other', recipe: childRecipe('other'), dataDir: other.dir },
    ] } } });
    const { status, lines, failed } = await audit([parent.dir]);
    expect(status).toBe(1);
    expect(lines.filter((line) => line === `${parent.stores[0]} (agents/agent): opens`)).toHaveLength(1);
    expect(lines).not.toContain(`${parent.dir}: audited as ${parent.dir}'s fleet child self, under the recipe its entry names, in the environment the fleet starts it with`);
    expect(failed).toEqual([expect.stringMatching(new RegExp(`^${other.stores[0]} \\(agents/agent\\): refused: store topology rejected: `))]);
  }, 90_000);

  test("a child's recipe reads the audit's environment as it began, the compression log's variable included", async () => {
    const parent = await makeDataDir('parent', [{ namespace: 'agents/agent', crossed: false }]);
    const child = await makeDataDir('kid', [{ namespace: 'agents/agent', crossed: false }]);
    const recipe = childRecipe('kid', { agent: { ...DEFAULT_RECIPE.agent, systemPrompt: '${CONTEXT_MANAGER_COMPRESSION_LOG}' } });
    saveRecipe(parent.dir, { ...DEFAULT_RECIPE, modules: { ...DEFAULT_RECIPE.modules, fleet: { children: [{ name: 'kid', recipe, dataDir: child.dir }] } } });
    process.env.CONTEXT_MANAGER_COMPRESSION_LOG = join(root, 'compression.log');
    let result: Awaited<ReturnType<typeof audit>>;
    try {
      result = await audit([parent.dir]);
    } finally {
      delete process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
    }
    expect(result.status, result.lines.join('\n')).toBe(0);
    expect(result.lines).toContain(`${child.stores[0]} (agents/agent): opens`);
  }, 90_000);

  test("a child's opens line isn't a failure whatever its path holds, though another of its stores was refused", async () => {
    const parent = await makeDataDir('parent', [{ namespace: 'agents/agent', crossed: false }]);
    const child = await makeDataDirWith('kid ): refused: dir', [
      (store) => makeStore(store, 'agents/agent', false),
      (store) => makeStore(store, 'agents/agent', true),
    ]);
    saveRecipe(parent.dir, { ...DEFAULT_RECIPE, modules: { ...DEFAULT_RECIPE.modules, fleet: { children: [{ name: 'kid', recipe: childRecipe('kid'), dataDir: child.dir }] } } });
    const { status, lines, failed } = await audit([parent.dir]);
    expect(status).toBe(1);
    expect(lines).toContain(`${child.stores[0]} (agents/agent): opens`);
    expect(failed).toEqual([expect.stringMatching(new RegExp(`^${child.stores[1]!.replace(/[)(]/g, '\\$&')} \\(agents/agent\\): refused: store topology rejected: `))]);
  }, 90_000);

  test("a child's directory that is a link to nothing can't be audited, and isn't read as one that isn't there yet", async () => {
    const parent = await makeDataDir('parent', [{ namespace: 'agents/agent', crossed: false }]);
    const link = join(root, 'kid');
    symlinkSync(join(root, 'nowhere'), link);
    saveRecipe(parent.dir, { ...DEFAULT_RECIPE, modules: { ...DEFAULT_RECIPE.modules, fleet: { children: [{ name: 'kid', recipe: childRecipe('kid'), dataDir: link }] } } });
    const { status, failed } = await audit([parent.dir]);
    expect(status).toBe(1);
    expect(failed).toEqual([`Couldn't audit ${link}, ${parent.dir}'s fleet child kid's directory: it's a link to nothing, ` +
      "so it wasn't audited. To update, point the link at the child's directory, or remove it."]);
  }, 90_000);

  test("a child's directory that is a loop of links is there, and its real path can't be had", async () => {
    const parent = await makeDataDir('parent', [{ namespace: 'agents/agent', crossed: false }]);
    const loop = join(root, 'kid');
    symlinkSync(loop, loop);
    saveRecipe(parent.dir, { ...DEFAULT_RECIPE, modules: { ...DEFAULT_RECIPE.modules, fleet: { children: [{ name: 'kid', recipe: childRecipe('kid'), dataDir: loop }] } } });
    const { status, failed } = await audit([parent.dir]);
    expect(status).toBe(1);
    expect(failed).toEqual([expect.stringMatching(new RegExp(`^Couldn't audit ${loop}, ${parent.dir}'s fleet child kid's directory: its real path can't be had: ELOOP`))]);
  });

  test("a child's directory the audit can't reach, such as one under a file, can't be audited", async () => {
    const parent = await makeDataDir('parent', [{ namespace: 'agents/agent', crossed: false }]);
    writeFileSync(join(root, 'a-file'), '');
    const under = join(root, 'a-file', 'kid');
    saveRecipe(parent.dir, { ...DEFAULT_RECIPE, modules: { ...DEFAULT_RECIPE.modules, fleet: { children: [{ name: 'kid', recipe: childRecipe('kid'), dataDir: under }] } } });
    const { status, failed } = await audit([parent.dir]);
    expect(status).toBe(1);
    expect(failed).toEqual([expect.stringMatching(new RegExp(`^Couldn't audit ${under}, ${parent.dir}'s fleet child kid's directory: it can't be reached: ENOTDIR`))]);
  });

  test("a fleet child's audit ends when the audit that started it does, since its stdin closes", async () => {
    const { dir } = await makeDataDir('kid', [{ namespace: 'agents/agent', crossed: false }]);
    // An extension whose import waits, so the audit is still running.
    const extension = join(root, 'waiting.ts');
    const held = join(root, 'held');
    writeFileSync(extension, [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(held)}, '');`,
      'await new Promise((done) => setTimeout(done, 60_000));',
      'export function register() {}',
    ].join('\n'));
    const recipe = childRecipe('kid', { extensions: { waiting: { kind: 'module', path: extension } } });
    const env: Record<string, string | undefined> = { ...process.env };
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_CREDENTIALS_FILE', 'DATA_DIR']) delete env[key];
    // It leads its own group, as the audit that starts it makes it.
    const child = spawn('bun', [INDEX_PATH, '--audit-stores', '--fleet-child', '--recipe', recipe, dir], { env, stdio: ['pipe', 'ignore', 'pipe'], detached: true });
    // Told to begin, as the audit that starts it tells it.
    child.stdin!.write('\n');
    let stderr = '';
    child.stderr!.on('data', (chunk) => { stderr += chunk; });
    const ended = new Promise<string>((done) => child.on('exit', (code, signal) => done(signal ?? `status ${code}`)));
    for (let waited = 0; !existsSync(held) && waited < 30_000; waited += 20) await Bun.sleep(20);
    expect(existsSync(held), 'the extension never began its wait').toBe(true);
    child.stdin!.end();
    const how = await Promise.race([ended, Bun.sleep(20_000).then(() => 'still running')]);
    if (how === 'still running') process.kill(-child.pid!, 'SIGKILL');
    expect(how).toBe('SIGKILL');
    // It ended mid-audit, before any store's line.
    expect(stderr).not.toContain(': opens');
  }, 60_000);

  test("on a trial, a child's audit is listed in the children file while it runs, and taken out after, the file's other entries kept", async () => {
    const parent = await makeDataDir('parent', [{ namespace: 'agents/agent', crossed: false }]);
    const child = await makeDataDir('kid', [{ namespace: 'agents/agent', crossed: false }]);
    const file = childrenFilePath(parent.dir);
    const other = { name: 'other', pid: null, bootId: null, dataDir: join(root, 'other') };
    // An entry of the same name with another pid, such as another session's
    // audit of the same child, isn't this audit's to take out.
    const sameName = { name: "kid's store audit", pid: process.pid, bootId: null, dataDir: join(root, 'kid') };
    writeJsonAtomic(file, { v: 1, children: [other, 'not a child', sameName] });
    // An extension that records, as the child's audit loads it, its own pid
    // and what the children file holds then.
    const seen = join(root, 'seen.json');
    const extension = join(root, 'looks.ts');
    writeFileSync(extension, [
      "import { readFileSync, writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ pid: process.pid, file: JSON.parse(readFileSync(${JSON.stringify(file)}, 'utf8')) }));`,
      'export function register() {}',
    ].join('\n'));
    const recipe = childRecipe('kid', { extensions: { looks: { kind: 'module', path: extension } } });
    saveRecipe(parent.dir, { ...DEFAULT_RECIPE, modules: { ...DEFAULT_RECIPE.modules, fleet: { children: [{ name: 'kid', recipe, dataDir: child.dir }] } } });
    const { status, lines } = await audit([parent.dir], { within: [root], listIn: file });
    expect(status, lines.join('\n')).toBe(0);
    const { pid, file: during } = JSON.parse(readFileSync(seen, 'utf8'));
    let boot: string | null = null;
    try { boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null; } catch { /* none */ }
    expect(during).toEqual({ v: 1, children: [other, 'not a child', sameName, { name: "kid's store audit", pid, bootId: boot, dataDir: child.dir }] });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ v: 1, children: [other, 'not a child', sameName] });
  }, 60_000);

  test("on a trial, a child's audit is listed with no boot id where the machine gives none, and goes on", async () => {
    const parent = await makeDataDir('parent', [{ namespace: 'agents/agent', crossed: false }]);
    const child = await makeDataDir('kid', [{ namespace: 'agents/agent', crossed: false }]);
    const file = childrenFilePath(parent.dir);
    const seen = join(root, 'seen.json');
    const extension = join(root, 'looks.ts');
    writeFileSync(extension, `import { copyFileSync } from 'node:fs';\ncopyFileSync(${JSON.stringify(file)}, ${JSON.stringify(seen)});\nexport function register() {}\n`);
    const recipe = childRecipe('kid', { extensions: { looks: { kind: 'module', path: extension } } });
    saveRecipe(parent.dir, { ...DEFAULT_RECIPE, modules: { ...DEFAULT_RECIPE.modules, fleet: { children: [{ name: 'kid', recipe, dataDir: child.dir }] } } });
    // As on macOS, where there's no boot id to read.
    const read = fs.readFileSync;
    const noBoot = spyOn(fs, 'readFileSync').mockImplementation(((path: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (String(path) === '/proc/sys/kernel/random/boot_id') throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
      return (read as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof fs.readFileSync);
    let result: Awaited<ReturnType<typeof audit>>;
    try {
      result = await audit([parent.dir], { within: [root], listIn: file });
    } finally {
      noBoot.mockRestore();
    }
    expect(result.status, result.lines.join('\n')).toBe(0);
    expect(JSON.parse(readFileSync(seen, 'utf8')).children).toEqual([expect.objectContaining({ name: "kid's store audit", bootId: null })]);
  }, 60_000);

  test("on a trial, a child's audit stays listed while it runs on after its host ends mid-open, and ends once that open does", async () => {
    const parent = await makeDataDir('parent', [{ namespace: 'agents/agent', crossed: false }]);
    const child = await makeDataDir('kid', [{ namespace: 'agents/agent', crossed: false }]);
    const file = childrenFilePath(parent.dir);
    const opening = join(root, 'opening');
    const release = join(root, 'release');
    // A strategy whose open of the child's store works, without a turn of
    // the event loop, until its host has ended and the test lets it go, once
    // it has marked that the open began.
    const extension = join(root, 'slow-open.ts');
    writeFileSync(extension, [
      PARENT_AT_IMPORT,
      "import { existsSync, writeFileSync } from 'node:fs';",
      "export function register(api) { api.registerStrategy('slow', () => ({",
      '  initialize: async () => {',
      `    writeFileSync(${JSON.stringify(opening)}, String(process.pid));`,
      ...holdPastParent(release).map((line) => `    ${line}`),
      '  },',
      '})); }',
    ].join('\n'));
    const recipe = childRecipe('kid', {
      extensions: { slow: { kind: 'strategy', path: extension } },
      agent: { ...DEFAULT_RECIPE.agent, strategy: { type: 'slow' } },
    });
    saveRecipe(parent.dir, { ...DEFAULT_RECIPE, modules: { ...DEFAULT_RECIPE.modules, fleet: { children: [{ name: 'kid', recipe, dataDir: child.dir }] } } });
    // The host on trial, which ends as soon as the child's open has begun.
    const host = join(root, 'host.ts');
    writeFileSync(host, [
      "import { existsSync } from 'node:fs';",
      `import { auditStores } from ${JSON.stringify(join(import.meta.dir, '..', 'src', 'update', 'audit-stores.ts'))};`,
      `const wait = () => existsSync(${JSON.stringify(opening)}) ? process.exit(0) : setTimeout(wait, 5);`,
      'wait();',
      `await auditStores([${JSON.stringify(parent.dir)}], () => {}, { within: [${JSON.stringify(root)}], listIn: ${JSON.stringify(file)} });`,
    ].join('\n'));
    const env: Record<string, string | undefined> = { ...process.env };
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_CREDENTIALS_FILE', 'DATA_DIR']) delete env[key];
    const hostProcess = spawn('bun', [host], { env, stdio: 'ignore' });
    await new Promise((done) => hostProcess.on('exit', done));
    expect(existsSync(opening), "the child's open never began").toBe(true);
    const pid = Number(readFileSync(opening, 'utf8'));
    try {
      // The host has ended, and its child's audit, still in its open, is
      // listed as running, which the launcher's fallback waits for.
      expect(processEnded(pid), "the child's audit ended with its host, before its open did").toBe(false);
      const listed = JSON.parse(readFileSync(file, 'utf8')).children;
      expect(listed).toContainEqual(expect.objectContaining({ name: "kid's store audit", pid, dataDir: child.dir }));
      writeFileSync(release, '');
      expect(await waitForEnd(pid, 20_000), "the child's audit went on after its open").toBe(true);
    } finally {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
    }
  }, 60_000);

  test("a child's audit whose host ended mid-open ends its process group as it ends, so a helper its extension started there writes nothing", async () => {
    const parent = await makeDataDir('parent', [{ namespace: 'agents/agent', crossed: false }]);
    const child = await makeDataDir('kid', [{ namespace: 'agents/agent', crossed: false }]);
    const file = childrenFilePath(parent.dir);
    const opening = join(root, 'opening');
    const helperPid = join(root, 'helper.pid');
    const late = join(child.dir, 'helper-wrote');
    const go = join(root, 'go');
    // A strategy whose open of the child's store works, without a turn of
    // the event loop, until its host has ended, once it has marked that the
    // open began.
    const extension = join(root, 'slow-open.ts');
    writeFileSync(extension, [
      PARENT_AT_IMPORT,
      "import { spawn } from 'node:child_process';",
      "import { existsSync, writeFileSync } from 'node:fs';",
      // A helper in the audit's own group, which writes in the child's data
      // directory once the test lets it.
      `const helper = spawn('sh', ['-c', 'while [ ! -e ${go} ]; do sleep 0.05; done; echo late > ${late}'], { stdio: 'ignore' });`,
      `writeFileSync(${JSON.stringify(helperPid)}, String(helper.pid));`,
      'helper.unref();',
      "export function register(api) { api.registerStrategy('slow', () => ({",
      '  initialize: async () => {',
      `    writeFileSync(${JSON.stringify(opening)}, String(process.pid));`,
      ...holdPastParent().map((line) => `    ${line}`),
      '  },',
      '})); }',
    ].join('\n'));
    const recipe = childRecipe('kid', {
      extensions: { slow: { kind: 'strategy', path: extension } },
      agent: { ...DEFAULT_RECIPE.agent, strategy: { type: 'slow' } },
    });
    saveRecipe(parent.dir, { ...DEFAULT_RECIPE, modules: { ...DEFAULT_RECIPE.modules, fleet: { children: [{ name: 'kid', recipe, dataDir: child.dir }] } } });
    // The host on trial, which ends as soon as the child's open has begun.
    const host = join(root, 'host.ts');
    writeFileSync(host, [
      "import { existsSync } from 'node:fs';",
      `import { auditStores } from ${JSON.stringify(join(import.meta.dir, '..', 'src', 'update', 'audit-stores.ts'))};`,
      `const wait = () => existsSync(${JSON.stringify(opening)}) ? process.exit(0) : setTimeout(wait, 5);`,
      'wait();',
      `await auditStores([${JSON.stringify(parent.dir)}], () => {}, { within: [${JSON.stringify(root)}], listIn: ${JSON.stringify(file)} });`,
    ].join('\n'));
    const env: Record<string, string | undefined> = { ...process.env };
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_CREDENTIALS_FILE', 'DATA_DIR']) delete env[key];
    const hostProcess = spawn('bun', [host], { env, stdio: 'ignore' });
    await new Promise((done) => hostProcess.on('exit', done));
    expect(existsSync(opening), "the child's open never began").toBe(true);
    const pid = Number(readFileSync(opening, 'utf8'));
    const helper = Number(readFileSync(helperPid, 'utf8'));
    try {
      expect(await waitForEnd(pid, 20_000), "the child's audit went on after its open").toBe(true);
      // The group's SIGKILL, sent as the child's audit ended, lands on the
      // helper in its own time.
      expect(await waitForEnd(helper, 10_000), "the helper outlived the child's audit").toBe(true);
      // Let it write, were it there.
      writeFileSync(go, '');
      await Bun.sleep(500);
      expect(existsSync(late), 'the helper wrote in the data directory').toBe(false);
    } finally {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
      try { process.kill(helper, 'SIGKILL'); } catch { /* gone */ }
    }
  }, 60_000);

  test("a fleet child's audit does nothing until the audit that started it says to begin, and ends if that one ends first", async () => {
    const { dir } = await makeDataDir('kid', [{ namespace: 'agents/agent', crossed: false }]);
    const extension = join(root, 'marks.ts');
    writeFileSync(extension, "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.AUDIT_TEST_MARK!, '');\nexport function register() {}\n");
    const recipe = childRecipe('kid', { extensions: { marks: { kind: 'module', path: extension } } });
    const env: Record<string, string | undefined> = { ...process.env };
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_CREDENTIALS_FILE', 'DATA_DIR']) delete env[key];
    const start = (mark: string) => spawn('bun', [INDEX_PATH, '--audit-stores', '--fleet-child', '--recipe', recipe, dir], {
      env: { ...env, AUDIT_TEST_MARK: mark }, stdio: ['pipe', 'ignore', 'pipe'], detached: true,
    });
    // Told to begin at once, a child loads its extension: how long that takes
    // here sets how long the next one is given.
    const toldMark = join(root, 'told');
    const began = Date.now();
    const told = start(toldMark);
    told.stdin!.write('\n');
    const toldEnded = new Promise((done) => told.on('exit', done));
    for (let waited = 0; !existsSync(toldMark) && waited < 30_000; waited += 20) await Bun.sleep(20);
    expect(existsSync(toldMark), 'a child told to begin never loaded its extension').toBe(true);
    const took = Date.now() - began;
    await toldEnded;
    const loaded = join(root, 'loaded');
    const child = start(loaded);
    let stderr = '';
    child.stderr!.on('data', (chunk) => { stderr += chunk; });
    const ended = new Promise<string>((done) => child.on('exit', (code, signal) => done(signal ?? `status ${code}`)));
    // Never told to begin: given three times as long, it has loaded none.
    await Bun.sleep(Math.max(1_500, 3 * took));
    expect(existsSync(loaded)).toBe(false);
    child.stdin!.end();
    const how = await Promise.race([ended, Bun.sleep(20_000).then(() => 'still running')]);
    if (how === 'still running') process.kill(-child.pid!, 'SIGKILL');
    expect(how).toBe('SIGKILL');
    expect(existsSync(loaded)).toBe(false);
    expect(stderr).not.toContain(': opens');
  }, 60_000);

  test("on a trial, a child's audit that can't be listed, as when the children file can't be read, is ended and can't be audited, and the file is left as it is", async () => {
    const parent = await makeDataDir('parent', [{ namespace: 'agents/agent', crossed: false }]);
    const child = await makeDataDir('kid', [{ namespace: 'agents/agent', crossed: true }]);
    const file = childrenFilePath(parent.dir);
    writeFileSync(file, 'not json');
    saveRecipe(parent.dir, { ...DEFAULT_RECIPE, modules: { ...DEFAULT_RECIPE.modules, fleet: { children: [{ name: 'kid', recipe: childRecipe('kid'), dataDir: child.dir }] } } });
    const { status, lines, failed } = await audit([parent.dir], { within: [root], listIn: file });
    expect(status).toBe(1);
    expect(failed).toEqual([
      `Couldn't audit ${child.dir}: its audit couldn't be listed in ${file}, which an update reads to see which processes may still be running, so it was ended: The fleet's children file at ${file} isn't JSON, so this release can't read it.`,
    ]);
    // Ended before it opened the store, whose refusal would have said so.
    expect(lines.some((line) => line.includes('refused'))).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe('not json');
  }, 60_000);

  test("on a trial, a child's audit isn't listed in a children file with no list of children, nor where the write fails, and is ended", async () => {
    const parent = await makeDataDir('parent', [{ namespace: 'agents/agent', crossed: false }]);
    const child = await makeDataDir('kid', [{ namespace: 'agents/agent', crossed: true }]);
    const file = childrenFilePath(parent.dir);
    saveRecipe(parent.dir, { ...DEFAULT_RECIPE, modules: { ...DEFAULT_RECIPE.modules, fleet: { children: [{ name: 'kid', recipe: childRecipe('kid'), dataDir: child.dir }] } } });
    const listing = `Couldn't audit ${child.dir}: its audit couldn't be listed in ${file}, which an update reads to see which processes may still be running, so it was ended: `;
    writeFileSync(file, JSON.stringify({ v: 1 }));
    const noList = await audit([parent.dir], { within: [root], listIn: file });
    expect(noList.failed).toEqual([`${listing}it has no list of children this release can read`]);
    expect(readFileSync(file, 'utf8')).toBe(JSON.stringify({ v: 1 }));
    rmSync(file);
    const write = spyOn(contract, 'writeJsonAtomic').mockImplementation(() => { throw new Error('no space left on device'); });
    let failing: Awaited<ReturnType<typeof audit>>;
    try {
      failing = await audit([parent.dir], { within: [root], listIn: file });
    } finally {
      write.mockRestore();
    }
    expect(failing.failed).toEqual([`${listing}no space left on device`]);
    // A write that replaced the file and then failed, as when the sync of
    // its directory does: the entry it left is taken out.
    const real = contract.writeJsonAtomic;
    const landed = spyOn(contract, 'writeJsonAtomic').mockImplementationOnce((path, value) => {
      real(path, value);
      throw new Error('the directory sync failed');
    });
    let after: Awaited<ReturnType<typeof audit>>;
    try {
      after = await audit([parent.dir], { within: [root], listIn: file });
    } finally {
      landed.mockRestore();
    }
    expect(after.failed).toEqual([`${listing}the directory sync failed`]);
    expect(JSON.parse(readFileSync(file, 'utf8')).children).toEqual([]);
    for (const result of [noList, failing, after]) expect(result.lines.some((line) => line.includes('refused'))).toBe(false);
  }, 60_000);

  test("on a trial, a child's audit holds its stores to the trial's places, not its own directory alone", async () => {
    const parent = await makeDataDir('parent', [{ namespace: 'agents/agent', crossed: false }]);
    const child = await makeDataDir('kid', [{ namespace: 'agents/agent', crossed: false }]);
    // The child's log lives in the parent's data directory, which the trial
    // copies as one of its places.
    const log = join(child.stores[0]!, 'records.log');
    const moved = join(parent.dir, 'kid-records.log');
    renameSync(log, moved);
    symlinkSync(moved, log);
    saveRecipe(parent.dir, { ...DEFAULT_RECIPE, modules: { ...DEFAULT_RECIPE.modules, fleet: { children: [{ name: 'kid', recipe: childRecipe('kid'), dataDir: child.dir }] } } });
    const onTrial = await audit([parent.dir], { within: [parent.dir, child.dir] });
    expect(onTrial.status, onTrial.lines.join('\n')).toBe(0);
    expect(onTrial.lines).toContain(`${child.stores[0]} (agents/agent): opens`);
    // By hand, the child's directory is its stores' place, and the link leaves it.
    const byHand = await audit([parent.dir]);
    expect(byHand.status).toBe(1);
    expect(byHand.failed).toEqual([linkLine(child.stores[0]!, log, child.dir, false)]);
  }, 90_000);

  test("on a trial, a child's audit offers pointing its directory at the other disk only where the trial took that directory as a place of its own", async () => {
    const parent = await makeDataDir('parent', [{ namespace: 'agents/agent', crossed: false }]);
    const child = await makeDataDir('kid', [{ namespace: 'agents/agent', crossed: false }]);
    const elsewhere = mkdtempSync(join(tmpdir(), 'audit-elsewhere-'));
    try {
      const log = join(child.stores[0]!, 'records.log');
      const moved = join(elsewhere, 'records.log');
      renameSync(log, moved);
      symlinkSync(moved, log);
      saveRecipe(parent.dir, { ...DEFAULT_RECIPE, modules: { ...DEFAULT_RECIPE.modules, fleet: { children: [{ name: 'kid', recipe: childRecipe('kid'), dataDir: child.dir }] } } });
      for (const [within, pointable] of [[[parent.dir, child.dir], true], [[root], false]] as const) {
        const { status, failed } = await audit([parent.dir], { within: [...within] });
        expect(status).toBe(1);
        expect(failed).toEqual([linkLine(child.stores[0]!, log, TRIAL_PLACES, true, pointable)]);
      }
      // A child's directory named through a link is the place it reaches.
      const alias = join(root, 'kid-alias');
      symlinkSync(child.dir, alias);
      saveRecipe(parent.dir, { ...DEFAULT_RECIPE, modules: { ...DEFAULT_RECIPE.modules, fleet: { children: [{ name: 'kid', recipe: childRecipe('kid'), dataDir: alias }] } } });
      const aliased = join(alias, relative(child.dir, child.stores[0]!));
      const throughAlias = await audit([parent.dir], { within: [parent.dir, child.dir] });
      expect(throughAlias.failed).toEqual([linkLine(aliased, join(aliased, 'records.log'), TRIAL_PLACES, true, true)]);
      // A store the child's index names outside every place gets no pointing
      // either, where its directory isn't one of them.
      renameSync(moved, log);
      saveRecipe(parent.dir, { ...DEFAULT_RECIPE, modules: { ...DEFAULT_RECIPE.modules, fleet: { children: [{ name: 'kid', recipe: childRecipe('kid'), dataDir: child.dir }] } } });
      const index = JSON.parse(readFileSync(join(child.dir, 'sessions.json'), 'utf8'));
      const away = relative(join(child.dir, 'sessions'), join(elsewhere, 'away'));
      index.sessions[away] = { ...index.sessions[index.activeSessionId], id: away };
      writeFileSync(join(child.dir, 'sessions.json'), JSON.stringify(index));
      const outsideStore = new SessionManager(child.dir).getStorePath(away);
      await makeStore(outsideStore, 'agents/agent', false);
      const outside = await audit([parent.dir], { within: [root] });
      expect(outside.status).toBe(1);
      expect(outside.failed).toEqual([outsideLine(outsideStore, TRIAL_PLACES, true, false)]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  }, 90_000);

  test("a child's audit that exits 0 before it finished, as an extension's import can make it, can't be audited", async () => {
    const parent = await makeDataDir('parent', [{ namespace: 'agents/agent', crossed: false }]);
    const child = await makeDataDir('kid', [{ namespace: 'agents/agent', crossed: true }]);
    const extension = join(root, 'exits.ts');
    writeFileSync(extension, 'process.exit(0);\nexport function register() {}\n');
    const recipe = childRecipe('kid', { extensions: { exits: { kind: 'module', path: extension } } });
    saveRecipe(parent.dir, { ...DEFAULT_RECIPE, modules: { ...DEFAULT_RECIPE.modules, fleet: { children: [{ name: 'kid', recipe, dataDir: child.dir }] } } });
    const { status, failed } = await audit([parent.dir]);
    expect(status).toBe(1);
    expect(failed).toEqual([unfinishedLine(child.dir, 'exited with status 0', parent.dir)]);
  }, 60_000);

  test("a fleet child's audit opens no store once the audit that started it has ended, though its event loop was held up", async () => {
    const { dir, stores } = await makeDataDir('kid', [{ namespace: 'agents/agent', crossed: false }]);
    // Three torn bytes after the store's last record, which its open would cut.
    const log = join(stores[0]!, 'records.log');
    appendFileSync(log, 'xyz');
    const size = statSync(log).size;
    const started = join(root, 'started');
    const built = join(root, 'built');
    // A strategy whose import works, without a turn of the event loop,
    // until the audit that started it has ended, and which marks an open of
    // the store, which initializes it.
    const extension = join(root, 'busy.ts');
    writeFileSync(extension, [
      PARENT_AT_IMPORT,
      "import { existsSync, writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(started)}, '');`,
      ...holdPastParent(),
      "export function register(api) { api.registerStrategy('busy', () => ({",
      `  initialize: async () => { writeFileSync(${JSON.stringify(built)}, ''); },`,
      '})); }',
    ].join('\n'));
    const recipe = childRecipe('kid', {
      extensions: { busy: { kind: 'strategy', path: extension } },
      agent: { ...DEFAULT_RECIPE.agent, strategy: { type: 'busy' } },
    });
    // The audit that starts it, which ends as soon as the import has begun.
    const starter = join(root, 'starter.ts');
    const pidFile = join(root, 'kid.pid');
    const stderrFile = join(root, 'kid.stderr');
    writeFileSync(starter, [
      "import { spawn } from 'node:child_process';",
      "import { existsSync, openSync, writeFileSync } from 'node:fs';",
      `const child = spawn(process.execPath, [${JSON.stringify(INDEX_PATH)}, '--audit-stores', '--fleet-child', '--recipe', ${JSON.stringify(recipe)}, ${JSON.stringify(dir)}], { stdio: ['pipe', 'ignore', openSync(${JSON.stringify(stderrFile)}, 'w')], detached: true });`,
      `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
      "child.stdin.write('\\n');",
      `const wait = () => existsSync(${JSON.stringify(started)}) ? process.exit(0) : setTimeout(wait, 10);`,
      'wait();',
    ].join('\n'));
    const env: Record<string, string | undefined> = { ...process.env };
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_CREDENTIALS_FILE', 'DATA_DIR']) delete env[key];
    const starterProcess = spawn('bun', [starter], { env, stdio: 'ignore' });
    await new Promise((done) => starterProcess.on('exit', done));
    expect(existsSync(started), 'the import never began').toBe(true);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    try {
      expect(await waitForEnd(pid, 20_000), 'the child audit is still running').toBe(true);
      expect(statSync(log).size, "the store was opened, which cut its torn tail").toBe(size);
      expect(existsSync(built), 'the store was opened').toBe(false);
      expect(readFileSync(stderrFile, 'utf8')).not.toContain(': opens');
    } finally {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
    }
  }, 60_000);

  test("ends once the child's audit has exited, though a helper outside its group still holds its stderr", async () => {
    const pidFile = join(root, 'helper.pid');
    const parent = await makeDataDir('parent', [{ namespace: 'agents/agent', crossed: false }]);
    const child = await makeDataDir('kid', [{ namespace: 'agents/agent', crossed: false }]);
    const extension = join(root, 'helper.ts');
    writeFileSync(extension, [
      "import { spawn } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      "const helper = spawn('sleep', ['60'], { detached: true, stdio: ['ignore', 'ignore', 'inherit'] });",
      'helper.unref();',
      `writeFileSync(${JSON.stringify(pidFile)}, String(helper.pid));`,
      'export function register() {}',
    ].join('\n'));
    const recipe = childRecipe('kid', { extensions: { helper: { kind: 'module', path: extension } } });
    saveRecipe(parent.dir, { ...DEFAULT_RECIPE, modules: { ...DEFAULT_RECIPE.modules, fleet: { children: [{ name: 'kid', recipe, dataDir: child.dir }] } } });
    try {
      const { status, lines } = await Promise.race([
        audit([parent.dir]),
        Bun.sleep(40_000).then(() => { throw new Error('the audit was still waiting'); }),
      ]);
      expect(status).toBe(0);
      expect(lines).toContain(`${child.stores[0]} (agents/agent): opens`);
      // The helper left the group and still holds the pipe, so it was the
      // grace that ended the wait.
      expect(() => process.kill(Number(readFileSync(pidFile, 'utf8')), 0)).not.toThrow();
    } finally {
      try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* gone */ }
    }
  }, 60_000);
});

describe('which stores an audit opens, by where they lie', () => {
  test("a session's store that is a link out of its data directory isn't opened, nor is one that is a link to nothing, which isn't made either", async () => {
    const { dir, stores } = await makeDataDir('data', [
      { namespace: 'agents/agent', crossed: false },
      { namespace: 'agents/agent', crossed: false },
      { namespace: 'agents/agent', crossed: false },
    ]);
    // The second session's store moves out, and a link takes its place; the
    // third's is a link to where nothing is.
    const outside = join(root, 'moved-out');
    renameSync(stores[1]!, outside);
    symlinkSync(outside, stores[1]!);
    rmSync(stores[2]!, { recursive: true });
    const nowhere = join(root, 'not-there');
    symlinkSync(nowhere, stores[2]!);
    const { status, failed } = await audit([dir]);
    expect(status).toBe(1);
    expect(failed.sort()).toEqual([
      outsideLine(stores[1]!, dir, false),
      nothingLine(stores[2]!),
    ].sort());
    expect(existsSync(nowhere)).toBe(false);
  });

  test("a store a session names that isn't there, under a data directory reached through a link, gets a line and no failure, on a trial and by hand", async () => {
    const real = await makeDataDirWith('real', [
      (store) => makeStore(store, 'agents/agent', false),
      (store) => makeStore(store, 'agents/agent', false),
    ]);
    // The data directory is reached through a link, and the second session's
    // store isn't there.
    const linked = join(root, 'linked');
    symlinkSync(real.dir, linked);
    const index = JSON.parse(readFileSync(join(real.dir, 'sessions.json'), 'utf8'));
    const second = Object.keys(index.sessions).find((key) => key !== index.activeSessionId)!;
    const missing = new SessionManager(linked).getStorePath(second);
    rmSync(missing, { recursive: true });
    const present = new SessionManager(linked).getStorePath(index.activeSessionId);
    for (const options of [{}, { within: [real.dir] }] as AuditOptions[]) {
      const { status, lines } = await audit([linked], options);
      expect(status, lines.join('\n')).toBe(0);
      expect(lines.sort()).toEqual([
        `${missing} (agents/agent): the index lists its session, and no store is there; a start makes an empty one`,
        `${present} (agents/agent): opens`,
      ].sort());
    }
  });

  test("a store holding a link to what lies outside the places isn't opened, so nothing outside changes, and one whose link stays inside opens", async () => {
    const { dir, stores } = await makeDataDir('data', [
      { namespace: 'agents/agent', crossed: false },
      { namespace: 'agents/agent', crossed: false },
    ]);
    // The first store's log moves out of the data directory, with three torn
    // bytes after its last record, which an open would cut; the second's moves
    // within it. A link takes each one's place.
    const out = join(root, 'outside-log');
    renameSync(join(stores[0]!, 'records.log'), out);
    symlinkSync(out, join(stores[0]!, 'records.log'));
    appendFileSync(out, 'xyz');
    const size = statSync(out).size;
    const within = join(dir, 'moved-log');
    renameSync(join(stores[1]!, 'records.log'), within);
    symlinkSync(within, join(stores[1]!, 'records.log'));
    for (const options of [{}, { within: [dir] }] as AuditOptions[]) {
      const { status, lines, failed } = await audit([dir], options);
      const where = options.within === undefined ? dir : "every place this trial's fallback puts back";
      expect(status).toBe(1);
      expect(failed).toEqual([
        linkLine(stores[0]!, join(stores[0]!, 'records.log'), where, options.within !== undefined),
      ]);
      expect(lines).toContain(`${stores[1]} (agents/agent): opens`);
      expect(statSync(out).size).toBe(size);
    }
  });

  test("a link deeper inside a store, to what lies outside its data directory, keeps the store from being opened", async () => {
    const { dir, stores } = await makeDataDir('data', [{ namespace: 'agents/agent', crossed: false }]);
    const nested = join(stores[0]!, 'nested', 'deeper');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, 'outside-file'), '');
    symlinkSync(join(root, 'outside-file'), join(nested, 'link'));
    const { status, failed } = await audit([dir]);
    expect(status).toBe(1);
    expect(failed).toEqual([
      linkLine(stores[0]!, join(nested, 'link'), dir, false),
    ]);
  });

  test("a store whose log has another name outside the places is audited: the fallback restores the store's path, not the other name", async () => {
    const { dir, stores } = await makeDataDir('data', [{ namespace: 'agents/agent', crossed: false }]);
    linkSync(join(stores[0]!, 'records.log'), join(root, 'other-name'));
    for (const options of [{}, { within: [dir] }] as AuditOptions[]) {
      const { status, lines } = await audit([dir], options);
      expect(status, lines.join('\n')).toBe(0);
      expect(lines).toEqual([`${stores[0]} (agents/agent): opens`]);
    }
  });

  test("a store whose entries can't be read isn't opened uninspected", async () => {
    const { dir, stores } = await makeDataDir('data', [
      { namespace: 'agents/agent', crossed: false },
      { namespace: 'agents/agent', crossed: false },
      { namespace: 'agents/agent', crossed: false },
    ]);
    const real = realpathSync(stores[1]!);
    // A directory in a store whose own path can't be read through.
    const inner = join(stores[2]!, 'inner');
    mkdirSync(inner);
    const statSync = fs.statSync;
    const realpath = fs.realpathSync;
    const failing = spyOn(fs, 'statSync').mockImplementation(((path: fs.PathLike, options?: fs.StatSyncOptions) => {
      if (String(path) === real) throw Object.assign(new Error(`EIO: i/o error, stat '${real}'`), { code: 'EIO' });
      return statSync(path, options);
    }) as typeof fs.statSync);
    const unreadable = spyOn(fs, 'realpathSync').mockImplementation(((path: fs.PathLike, options?: fs.EncodingOption) => {
      if (String(path) === inner) throw Object.assign(new Error(`EIO: i/o error, realpath '${inner}'`), { code: 'EIO' });
      return realpath(path, options);
    }) as typeof fs.realpathSync);
    const opened: string[] = [];
    const openStore = JsStore.openOrCreate.bind(JsStore);
    const opening = spyOn(JsStore, 'openOrCreate').mockImplementation((config) => {
      opened.push(config.path);
      return openStore(config);
    });
    let result: Awaited<ReturnType<typeof audit>>;
    try {
      result = await audit([dir]);
    } finally {
      failing.mockRestore();
      unreadable.mockRestore();
      opening.mockRestore();
    }
    expect(opened).toEqual([stores[0]!]);
    expect(result.status).toBe(1);
    expect(result.failed).toEqual([
      `Couldn't audit ${stores[1]}: it can't be read: EIO: i/o error, stat '${real}', so it wasn't opened`,
      `Couldn't audit ${stores[2]}: it can't be read: EIO: i/o error, realpath '${inner}', so it wasn't opened`,
    ]);
    expect(result.lines).toContain(`${stores[0]} (agents/agent): opens`);
  });

  test("a link in a store to a directory inside the places is walked, so a link out of it below keeps the store from being opened", async () => {
    const { dir, stores } = await makeDataDir('data', [{ namespace: 'agents/agent', crossed: false }]);
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(root, 'outside-file'), '');
    symlinkSync(join(root, 'outside-file'), join(elsewhere, 'out'));
    symlinkSync(elsewhere, join(stores[0]!, 'inward'));
    // And one back to the store itself, which the walk passes once.
    symlinkSync(stores[0]!, join(elsewhere, 'back'));
    const { status, failed } = await audit([dir]);
    expect(status).toBe(1);
    expect(failed).toEqual([
      linkLine(stores[0]!, join(stores[0]!, 'inward', 'out'), dir, false),
    ]);
  });

  test("a link in a store into the launcher's own directory in a place, at any depth, leads out of it, since the launcher's copy leaves that out", async () => {
    const { dir, stores } = await makeDataDir('data', [
      { namespace: 'agents/agent', crossed: false },
      { namespace: 'agents/agent', crossed: false },
    ]);
    const reserved = [join(dir, '.connectome-update', 'set-aside', 'm-1'), join(dir, 'notes', '.connectome-update', 'kept')];
    for (const [i, at] of reserved.entries()) {
      mkdirSync(at, { recursive: true });
      const moved = join(at, 'records.log');
      renameSync(join(stores[i]!, 'records.log'), moved);
      symlinkSync(moved, join(stores[i]!, 'records.log'));
    }
    for (const options of [{}, { within: [dir] }] as AuditOptions[]) {
      const onTrial = options.within !== undefined;
      const { status, failed } = await audit([dir], options);
      expect(status).toBe(1);
      expect(failed).toEqual(stores.map((store) => linkLine(store, join(store, 'records.log'), onTrial ? TRIAL_PLACES : dir, onTrial)));
    }
  });

  test("a store holding a link to nothing isn't opened, nor made through it, and one holding a loop of links can't be read", async () => {
    const { dir, stores } = await makeDataDir('data', [
      { namespace: 'agents/agent', crossed: false },
      { namespace: 'agents/agent', crossed: false },
    ]);
    const nowhere = join(root, 'nowhere-log');
    rmSync(join(stores[0]!, 'records.log'));
    symlinkSync(nowhere, join(stores[0]!, 'records.log'));
    const loop = join(stores[1]!, 'loop');
    symlinkSync(loop, loop);
    const { status, failed } = await audit([dir]);
    expect(status).toBe(1);
    expect(failed).toEqual([
      holdsNothingLine(stores[0]!, join(stores[0]!, 'records.log')),
      expect.stringMatching(new RegExp(`^Couldn't audit ${stores[1]}: it can't be read: ELOOP`)),
    ]);
    expect(existsSync(nowhere)).toBe(false);
  });

  test("a store holding a link back to itself, and nothing that leads out, opens: the walk passes each directory once", async () => {
    const { dir, stores } = await makeDataDir('data', [{ namespace: 'agents/agent', crossed: false }]);
    mkdirSync(join(stores[0]!, 'inner'));
    symlinkSync(stores[0]!, join(stores[0]!, 'inner', 'back'));
    const { status, lines } = await audit([dir]);
    expect(status, lines.join('\n')).toBe(0);
    expect(lines).toEqual([`${stores[0]} (agents/agent): opens`]);
  });

  test("a store whose path runs through a loop of links can't be audited, on a trial and by hand, and the others are", async () => {
    const { dir, stores } = await makeDataDir('data', [
      { namespace: 'agents/agent', crossed: false },
      { namespace: 'agents/agent', crossed: false },
    ]);
    // A session whose store lies under a directory that is a link to itself.
    const manager = new SessionManager(dir);
    const index = manager.load();
    index.sessions['loop/inner'] = { ...index.sessions[Object.keys(index.sessions)[0]!]!, id: 'loop/inner' };
    manager.save(index);
    const loop = join(dir, 'sessions', 'loop');
    symlinkSync(loop, loop);
    const looped = join(loop, 'inner');
    for (const options of [{}, { skip: [stores[0]!], within: [dir] }] as AuditOptions[]) {
      const { status, lines, failed } = await audit([dir], options);
      expect(status).toBe(1);
      expect(failed).toEqual([expect.stringMatching(new RegExp(`^Couldn't audit ${looped}: it can't be read: ELOOP`))]);
      expect(lines).toContain(`${stores[1]} (agents/agent): opens`);
    }
  });

  test("on a trial, a store under a place whose name starts with '..' lies under it", async () => {
    const { dir, stores } = await makeDataDirWith('..data', [
      (store) => makeStore(store, 'agents/agent', false),
      (store) => makeStore(store, 'agents/agent', false),
    ]);
    const { status, lines } = await audit([dir], { skip: [stores[0]!], within: [root] });
    expect(status, lines.join('\n')).toBe(0);
    expect(lines).toEqual([`${stores[1]} (agents/agent): opens`]);
  });
});

describe('a host on trial, before its commit', () => {
  let install: string;
  beforeEach(() => {
    install = join(root, 'install');
    mkdirSync(join(install, 'releases', '0.10.2'), { recursive: true });
    mkdirSync(join(install, 'releases', '0.11.0'), { recursive: true });
    moveCurrent(install, '0.10.2');
  });

  /** A framework as startFramework uses one, counting its starts and stops. */
  function counting() {
    const counts = { started: 0, stopped: 0 };
    const framework = {
      start: () => { counts.started++; }, stop: async () => { counts.stopped++; }, getModule: () => null, listMcplServers: () => [],
      notifyOps: () => {},
      getHostModeStatus: () => ({ quiesced: false }),
    } as never;
    return { framework, counts };
  }

  /** startFramework on trial for 0.11.0, with the stores it opened and what
   *  it threw. */
  async function trial(dir: string, activeStore: string, places: () => string[] | null) {
    const { framework, counts } = counting();
    const opened: string[] = [];
    const openStore = JsStore.openOrCreate.bind(JsStore);
    const opening = spyOn(JsStore, 'openOrCreate').mockImplementation((config) => {
      opened.push(config.path);
      return openStore(config);
    });
    let error: unknown;
    try {
      await startFramework(framework, { root: install, release: '0.11.0' }, { dataDir: dir, activeStore, places });
    } catch (thrown) {
      error = thrown;
    } finally {
      opening.mockRestore();
    }
    return { ...counts, opened, message: error === undefined ? undefined : error instanceof Error ? error.message : String(error) };
  }

  test("audits every store it would open only after its commit under a place its fallback undoes, leaves its active session to its own start, and a store it can't open ends the start with `current` as it was", async () => {
    // The active session opens and the other is crossed; the recipe's
    // child, inside the data directory, is crossed too, though no children
    // file lists it.
    const { dir, stores } = await makeDataDir('data', [
      { namespace: 'agents/agent', crossed: false },
      { namespace: 'agents/agent', crossed: true },
    ]);
    const child = await makeDataDirWith(join('data', 'kid'), [(store) => makeStore(store, 'agents/agent', true)]);
    // A child whose directory is under no place the fallback undoes: left
    // unopened, and its line holds the commit.
    const outside = await makeDataDir('outside', [{ namespace: 'agents/agent', crossed: true }]);
    const kidRecipe = join(root, 'kid.json');
    writeFileSync(kidRecipe, JSON.stringify(DEFAULT_RECIPE));
    saveRecipe(dir, {
      ...DEFAULT_RECIPE,
      modules: {
        ...DEFAULT_RECIPE.modules,
        fleet: { children: [
          { name: 'kid', recipe: kidRecipe, dataDir: child.dir },
          { name: 'far', recipe: kidRecipe, dataDir: outside.dir },
          // Not there yet, outside the places: its start would make it there.
          { name: 'new', recipe: kidRecipe, dataDir: join(root, 'not-yet') },
        ] },
      },
    });
    const logged: string[] = [];
    const log = spyOn(console, 'error').mockImplementation((line) => { logged.push(String(line)); });
    let result: Awaited<ReturnType<typeof trial>>;
    try {
      // The active store by a link to it.
      const link = join(root, 'active-link');
      symlinkSync(stores[0]!, link);
      result = await trial(dir, link, () => [join(root, 'elsewhere'), dir]);
    } finally {
      log.mockRestore();
    }
    expect(result.started).toBe(0);
    expect(result.stopped).toBe(1);
    expect(readCurrent(install)).toBe('0.10.2');
    // The child's stores are opened by its own process, not this one.
    expect(result.opened).toEqual([stores[1]!]);
    const farLine = `Couldn't audit ${outside.dir}, ${dir}'s fleet child far's directory: it lies outside every place ` +
      "this trial's fallback puts back, where an update can't put back what opening its stores changes, so it wasn't " +
      `audited. To update, move it under ${dir} and point its fleet entry there, or declare it by running ` +
      'setup again with --extra-state PATH for it and for each place already recorded, so each update copies it.';
    expect(logged).toContain(`[update] ${farLine}`);
    const newLine = `Couldn't audit ${join(root, 'not-yet')}, ${dir}'s fleet child new's directory: it lies outside every ` +
      "place this trial's fallback puts back, where an update can't put back what its start makes there, so it wasn't " +
      `audited. To update, point its fleet entry under ${dir}, or make the directory and declare it by ` +
      'running setup again with --extra-state PATH for it and for each place already recorded, so each update copies it.';
    expect(logged).toContain(`[update] ${newLine}`);
    expect(existsSync(join(root, 'not-yet'))).toBe(false);
    const message = result.message!;
    expect(message).toStartWith("This release couldn't open every store it would open only after its commit, so it starts none of its agents, and the next start goes back to 0.10.2:\n");
    expect(message).toContain(`\n${stores[1]} (agents/agent): refused: store topology rejected: `);
    expect(message).toContain(`\n${child.stores[0]} (agents/agent): refused: store topology rejected: `);
    expect(message).toContain(`\n${farLine}\n`);
    expect(message).toEndWith('To take this release, repair each refused store as AGENT-ONBOARDING.md §11.8 says, or correct what a line names, and update again; or stay on 0.10.2 until a release opens them.');
  }, 90_000);

  test("opens no store when it can't tell which places its fallback undoes, or when no trial is under way, and says why", async () => {
    const { dir, stores } = await makeDataDir('data', [
      { namespace: 'agents/agent', crossed: false },
      { namespace: 'agents/agent', crossed: false },
    ]);
    for (const [places, said] of [
      [() => { throw new Error('the label is damaged'); }, "This release couldn't tell which places its trial's fallback puts back, so it opened no other store than its active session's and starts none of its agents: the label is damaged. The next start's fallback to 0.10.2 reads the same records; if it can't use them either, it says so and starts nothing."],
      [() => null, "No switch or Go back is under way by the install's journal, so this release opened no other store than its active session's and starts none of its agents: nothing would put back what opening its stores before a commit changes. `current` still names 0.10.2: start that release, or update to this one through the install's launcher, which starts it as a switch's trial."],
    ] as const) {
      const log = spyOn(console, 'error').mockImplementation(() => {});
      let result: Awaited<ReturnType<typeof trial>>;
      try {
        result = await trial(dir, stores[0]!, places);
      } finally {
        log.mockRestore();
      }
      expect(result.opened).toEqual([]);
      expect(result.started).toBe(0);
      expect(result.stopped).toBe(1);
      expect(result.message).toBe(said);
      expect(readCurrent(install)).toBe('0.10.2');
    }
  });

  test("a store an index names outside every place the fallback undoes isn't opened, and ends the trial", async () => {
    const { dir, stores } = await makeDataDir('data', [
      { namespace: 'agents/agent', crossed: false },
      { namespace: 'agents/agent', crossed: false },
    ]);
    const log = spyOn(console, 'error').mockImplementation(() => {});
    let result: Awaited<ReturnType<typeof trial>>;
    try {
      result = await trial(dir, stores[0]!, () => [join(root, 'elsewhere')]);
    } finally {
      log.mockRestore();
    }
    expect(result.opened).toEqual([]);
    expect(result.message).toContain(`\n${outsideLine(stores[1]!, TRIAL_PLACES, true)}\n`);
  });

  test("a refusal whose closing of what it had opened fails says so", async () => {
    const { dir, stores } = await makeDataDirWith('data', [makeBrokenSubconsciousStore]);
    saveRecipe(dir, { ...DEFAULT_RECIPE, subconscious: { enabled: true, systemPrompt: 'attend to the agent' } });
    const closing = spyOn(ContextManager.prototype, 'close').mockImplementation(() => { throw new Error('the close failed'); });
    let result: Awaited<ReturnType<typeof audit>>;
    try {
      result = await audit([dir]);
    } finally {
      closing.mockRestore();
    }
    expect(result.status).toBe(1);
    expect(result.failed).toEqual([expect.stringMatching(new RegExp(
      `^${literally(stores[0]!)} \\(subconscious/agent\\): refused: [^;]*[^.;]; closing what it had opened failed: the close failed$`))]);
  });

  test("a model call beside a manager's close that fails isn't excused, since only a model call alone is", async () => {
    const { dir, stores } = await makeDataDir('data', [{ namespace: 'agents/agent', crossed: false }]);
    withStrategy(dir, 'calling', "export function register(api) { api.registerStrategy('calling', () => ({ initialize: async (ctx) => { globalThis.auditTestModelCalled = true; try { await ctx.membrane.complete({}); } catch { /* as a strategy might */ } } })); }\n");
    const closing = spyOn(ContextManager.prototype, 'close').mockImplementation(() => { throw new Error('the close failed'); });
    const called = globalThis as { auditTestModelCalled?: boolean };
    delete called.auditTestModelCalled;
    let result: Awaited<ReturnType<typeof audit>>;
    try {
      result = await audit([dir]);
    } finally {
      closing.mockRestore();
    }
    expect(result.status).toBe(1);
    expect(called.auditTestModelCalled).toBe(true);
    expect(result.failed).toEqual([`Couldn't audit ${stores[0]}: it opened, and closing it failed: the close failed`]);
  });

  test("a model call in the agent's open, caught or not, doesn't excuse the subconscious's own refusal, which holds the commit", async () => {
    for (const [kind, call] of [['caught', 'try { await ctx.membrane.complete({}); } catch { /* as a strategy might */ }'], ['thrown', 'await ctx.membrane.complete({});']]) {
      const { dir, stores } = await makeDataDirWith(`data-${kind}`, [makeBrokenSubconsciousStore]);
      const extension = join(root, `asks-${kind}.ts`);
      writeFileSync(extension, `export function register(api) { api.registerStrategy('asks', () => ({ initialize: async (ctx) => { ${call} } })); }\n`);
      saveRecipe(dir, {
        ...DEFAULT_RECIPE,
        extensions: { asks: { kind: 'strategy', path: extension } },
        agent: { ...DEFAULT_RECIPE.agent, strategy: { type: 'asks' } },
        subconscious: { enabled: true, systemPrompt: 'attend to the agent' },
      });
      const { status, failed } = await audit([dir]);
      expect(status, kind).toBe(1);
      expect(failed, kind).toEqual([expect.stringMatching(new RegExp(`^${stores[0]} \\(subconscious/agent\\): refused: `))]);
    }
  });

  test("a store whose strategy calls a model is said, and doesn't hold the commit", async () => {
    const { dir, stores } = await makeDataDir('data', [
      { namespace: 'agents/agent', crossed: false },
      { namespace: 'agents/agent', crossed: false },
    ]);
    withStrategy(dir, 'asks', "export function register(api) { api.registerStrategy('asks', () => ({ initialize: async (ctx) => { await ctx.membrane.complete({}); } })); }\n");
    const logged: string[] = [];
    const log = spyOn(console, 'error').mockImplementation((line) => { logged.push(String(line)); });
    let result: Awaited<ReturnType<typeof trial>>;
    try {
      result = await trial(dir, stores[0]!, () => [dir]);
    } finally {
      log.mockRestore();
    }
    expect(result.message).toBeUndefined();
    expect(result.started).toBe(1);
    expect(readCurrent(install)).toBe('0.11.0');
    expect(logged).toContain(`[update] Couldn't audit ${stores[1]}: ${MODEL_CALLED}; the trial doesn't hold its commit for it`);
  });

  test("a model call whose store then fails to close holds the commit, since only a model call alone is excused", async () => {
    const { dir, stores } = await makeDataDir('data', [
      { namespace: 'agents/agent', crossed: false },
      { namespace: 'agents/agent', crossed: false },
    ]);
    withStrategy(dir, 'asks', "export function register(api) { api.registerStrategy('asks', () => ({ initialize: async (ctx) => { await ctx.membrane.complete({}); } })); }\n");
    const realClose = JsStore.prototype.close;
    const storeClose = spyOn(JsStore.prototype, 'close').mockImplementation(function (this: JsStore) {
      realClose.call(this);
      throw new Error('store close failed');
    });
    const log = spyOn(console, 'error').mockImplementation(() => {});
    let result: Awaited<ReturnType<typeof trial>>;
    try {
      result = await trial(dir, stores[0]!, () => [dir]);
    } finally {
      log.mockRestore();
      storeClose.mockRestore();
    }
    expect(result.started).toBe(0);
    expect(result.message).toContain(`\nCouldn't audit ${stores[1]}: ${MODEL_CALLED}; closing it failed: store close failed\n`);
  });

  /** This checkout as the install's 0.11.0, started through its entry on the
   *  trial the launcher leaves: the data's copy, labelled, and the
   *  `trial-start` line. Resolves with how it ended and what it wrote on
   *  stderr. */
  async function startOnTrial(dir: string, { journal = true, extension }: { journal?: boolean; extension?: string } = {}): Promise<{ status: number | null; stderr: string }> {
    rmSync(join(install, 'releases', '0.11.0'), { recursive: true });
    symlinkSync(join(import.meta.dir, '..'), join(install, 'releases', '0.11.0'));
    const { copy } = installPaths(install);
    const name = copyItemName(0, dir);
    cpSync(dir, join(copy, name), { recursive: true });
    const at = new Date().toISOString();
    writeJsonAtomic(copyLabelPath(copy), { v: 1, from: '0.10.2', at, items: [{ path: dir, name }], mark: 'm-1' });
    if (journal) appendJournal(install, { at, step: 'trial-start', from: '0.10.2', to: '0.11.0', outcome: 'ok', mark: 'm-1' });
    const recipe = join(root, 'host.json');
    writeFileSync(recipe, JSON.stringify({
      ...DEFAULT_RECIPE, mcpServers: {},
      modules: { ...DEFAULT_RECIPE.modules, subagents: false, lessons: false, retrieval: false, wake: false, workspace: false },
      ...(extension === undefined ? {} : { extensions: { counted: { kind: 'module', path: extension } } }),
    }));
    const env: Record<string, string | undefined> = {
      ...process.env, ANTHROPIC_API_KEY: 'sk-test-update-audit', DATA_DIR: dir, CONNECTOME_INSTALL_ROOT: install,
    };
    const host = Bun.spawn(['bun', join(install, 'releases', '0.11.0', 'src', 'index.ts'), recipe, '--headless'], {
      cwd: root, env, stdin: 'ignore', stdout: 'ignore', stderr: 'pipe',
    });
    const [stderr, status] = await Promise.all([
      new Response(host.stderr).text(),
      Promise.race([host.exited, Bun.sleep(60_000).then(() => { host.kill('SIGKILL'); return null; })]),
    ]);
    return { status, stderr };
  }

  test('through the host\'s entry, on a trial the launcher left: a crossed store in another session ends the start before its commit', async () => {
    const { dir, stores } = await makeDataDir('data', [
      { namespace: 'agents/agent', crossed: false },
      { namespace: 'agents/agent', crossed: true },
    ]);
    const { status, stderr } = await startOnTrial(dir);
    expect(status, stderr.slice(-3000)).toBe(1);
    expect(stderr).toContain("This release couldn't open every store it would open only after its commit, so it starts none of its agents, and the next start goes back to 0.10.2:\n");
    expect(stderr).toContain(`\n${stores[1]} (agents/agent): refused: store topology rejected: `);
    expect(readCurrent(install)).toBe('0.10.2');
  }, 90_000);

  test("through the host's entry, on a trial: the audit builds its strategies from the extensions the start loaded, so none registers twice", async () => {
    const { dir, stores } = await makeDataDir('data', [
      { namespace: 'agents/agent', crossed: false },
      { namespace: 'agents/agent', crossed: true },
    ]);
    // Each register() call adds a line, as an extension's own allocation
    // there would add one, released only by its module's stop; the module it
    // registers adds one as it's built.
    const calls = join(root, 'register-calls');
    const extension = join(root, 'counted.ts');
    writeFileSync(extension, [
      "import { appendFileSync } from 'node:fs';",
      'export function register(api) {',
      `  appendFileSync(${JSON.stringify(calls)}, 'register\\n');`,
      '  api.registerModule(() => {',
      `    appendFileSync(${JSON.stringify(calls)}, 'module\\n');`,
      "    return { name: 'counted', getTools() { return []; }, async start() {}, async stop() {},",
      "      async handleToolCall() { return { success: false, error: 'no tools' }; }, async onProcess() { return {}; } };",
      '  });',
      '}',
    ].join('\n'));
    const { status, stderr } = await startOnTrial(dir, { extension });
    expect(status, stderr.slice(-3000)).toBe(1);
    // The audit ran, and refused the crossed store, with the start's one
    // register(), whose module the start's framework was built with.
    expect(stderr).toContain(`\n${stores[1]} (agents/agent): refused: store topology rejected: `);
    expect(readFileSync(calls, 'utf8')).toBe('register\nmodule\n');
  }, 90_000);

  test("through the host's entry, on a trial: an active session's store holding a link out of the places ends the start before anything opens it", async () => {
    const { dir, stores } = await makeDataDir('data', [{ namespace: 'agents/agent', crossed: false }]);
    // The active store's log moves out of the data directory, with three torn
    // bytes after its last record, which an open would cut.
    const out = join(root, 'outside-log');
    renameSync(join(stores[0]!, 'records.log'), out);
    symlinkSync(out, join(stores[0]!, 'records.log'));
    appendFileSync(out, 'xyz');
    const size = statSync(out).size;
    const { status, stderr } = await startOnTrial(dir);
    expect(status, stderr.slice(-3000)).toBe(1);
    expect(stderr).toContain("This release can't open its active session's store on its trial, so it opened no store, starts none of its agents, and the next start goes back to 0.10.2:\n");
    expect(stderr).toContain(linkLine(stores[0]!, join(stores[0]!, 'records.log'), TRIAL_PLACES, true));
    expect(statSync(out).size).toBe(size);
    expect(readCurrent(install)).toBe('0.10.2');
  }, 90_000);

  test("through the host's entry, with no trial under way: a release `current` doesn't name ends its start having opened no store", async () => {
    const { dir, stores } = await makeDataDir('data', [{ namespace: 'agents/agent', crossed: false }]);
    // Three torn bytes after the active store's last record, which an open
    // would cut.
    const log = join(stores[0]!, 'records.log');
    appendFileSync(log, 'xyz');
    const size = statSync(log).size;
    const { status, stderr } = await startOnTrial(dir, { journal: false });
    expect(status, stderr.slice(-3000)).toBe(1);
    expect(stderr).toContain("No switch or Go back is under way by the install's journal, so this release opened no store and starts none of its agents: ");
    expect(statSync(log).size).toBe(size);
    expect(readCurrent(install)).toBe('0.10.2');
  }, 90_000);

  test("a child's audit that exits 1 before it said it had finished holds the commit, though the only line it left wouldn't", async () => {
    const { dir, stores } = await makeDataDir('data', [{ namespace: 'agents/agent', crossed: false }]);
    const child = await makeDataDir(join('data', 'kid'), [
      { namespace: 'agents/agent', crossed: false },
      { namespace: 'agents/agent', crossed: false },
    ]);
    // Its strategy calls a model as it opens the child's first store, which
    // leaves that store's line one that doesn't hold the commit, and its
    // extension exits 1 as the second store opens.
    const extension = join(root, 'asks-then-exits.ts');
    writeFileSync(extension, [
      'let opens = 0;',
      "export function register(api) { api.registerStrategy('asks', () => ({ initialize: async (ctx) => {",
      '  opens += 1;',
      '  if (opens > 1) process.exit(1);',
      '  try { await ctx.membrane.complete({}); } catch { /* as a strategy might */ }',
      '} })); }',
    ].join('\n'));
    const recipe = childRecipe('kid', {
      extensions: { asks: { kind: 'strategy', path: extension } },
      agent: { ...DEFAULT_RECIPE.agent, strategy: { type: 'asks' } },
    });
    saveRecipe(dir, { ...DEFAULT_RECIPE, modules: { ...DEFAULT_RECIPE.modules, fleet: { children: [{ name: 'kid', recipe, dataDir: child.dir }] } } });
    const log = spyOn(console, 'error').mockImplementation(() => {});
    let result: Awaited<ReturnType<typeof trial>>;
    try {
      result = await trial(dir, stores[0]!, () => [dir]);
    } finally {
      log.mockRestore();
    }
    expect(result.started).toBe(0);
    expect(readCurrent(install)).toBe('0.10.2');
    expect(result.message).toContain(`\n${unfinishedLine(child.dir, 'exited with status 1', dir)}\n`);
  }, 90_000);

  test("lists each child's audit in the host's children file while it runs, and takes it out after", async () => {
    const { dir, stores } = await makeDataDir('data', [{ namespace: 'agents/agent', crossed: false }]);
    const child = await makeDataDir(join('data', 'kid'), [{ namespace: 'agents/agent', crossed: false }]);
    const file = childrenFilePath(dir);
    const seen = join(root, 'seen.json');
    const extension = join(root, 'looks.ts');
    writeFileSync(extension, `import { copyFileSync } from 'node:fs';\ncopyFileSync(${JSON.stringify(file)}, ${JSON.stringify(seen)});\nexport function register() {}\n`);
    const recipe = childRecipe('kid', { extensions: { looks: { kind: 'module', path: extension } } });
    saveRecipe(dir, { ...DEFAULT_RECIPE, modules: { ...DEFAULT_RECIPE.modules, fleet: { children: [{ name: 'kid', recipe, dataDir: child.dir }] } } });
    const log = spyOn(console, 'error').mockImplementation(() => {});
    let result: Awaited<ReturnType<typeof trial>>;
    try {
      result = await trial(dir, stores[0]!, () => [dir]);
    } finally {
      log.mockRestore();
    }
    expect(result.message).toBeUndefined();
    expect(JSON.parse(readFileSync(seen, 'utf8')).children).toEqual([expect.objectContaining({ name: "kid's store audit", dataDir: child.dir })]);
    expect(JSON.parse(readFileSync(file, 'utf8')).children).toEqual([]);
  }, 90_000);

  test("a read of `current` that fails ends the start, though a later read would succeed, so a trial never commits unaudited", async () => {
    const { dir, stores } = await makeDataDir('data', [
      { namespace: 'agents/agent', crossed: false },
      { namespace: 'agents/agent', crossed: true },
    ]);
    const { framework, counts } = counting();
    const reading = spyOn(contract, 'readCurrent').mockImplementationOnce(() => {
      throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
    });
    try {
      await expect(startFramework(framework, { root: install, release: '0.11.0' }, { dataDir: dir, activeStore: stores[0]!, places: () => [dir] }))
        .rejects.toThrow(`This host couldn't read which release the install at ${install} runs on, so none of its agents started: EIO: i/o error.`);
    } finally {
      reading.mockRestore();
    }
    expect(counts.started).toBe(0);
    expect(readCurrent(install)).toBe('0.10.2');
  });

  test("each load repair the trial's audit causes is also sent through the framework's ops path, and the trial commits", async () => {
    const { dir, stores } = await makeDataDirWith('data', [
      (store) => makeStore(store, 'agents/agent', false),
      (store) => makeRepairStore(store),
      (store) => makeRepairStore(store),
    ]);
    const sent: Array<{ kind: string; agent: string; message: string; data?: Record<string, unknown> }> = [];
    const framework = {
      start: () => {}, stop: async () => {}, getModule: () => null, listMcplServers: () => [],
      getHostModeStatus: () => ({ quiesced: false }),
      // A method reading its own object, as agent-framework's is.
      sent,
      notifyOps(kind: string, agent: string, message: string, data?: Record<string, unknown>) { this.sent.push({ kind, agent, message, data }); },
    } as never;
    await startFramework(framework, { root: install, release: '0.11.0' }, { dataDir: dir, activeStore: stores[0]!, places: () => [dir] });
    expect(readCurrent(install)).toBe('0.11.0');
    expect(sent.map(({ kind, agent, data }) => [kind, agent, data!.store]).sort())
      .toEqual([['memory-load-repair', 'agent', stores[1]], ['memory-load-repair', 'agent', stores[2]]].sort());
    for (const { agent, message, data } of sent) {
      // The Health tab and /healthz never hold a report the audit's own strategy made.
      expect(message).toBe(loadRepairAlert(data as unknown as LoadRepairReport, agent, data!.store as string, AUDIT_POINTER).message);
      expect(message).toEndWith("The message is in failures.log and among the update's audit lines.");
      expect((data as unknown as LoadRepairReport).dropped.map((drop) => drop.id)).toEqual(['L2-x']);
    }
  }, 60_000);

  test("a trial whose commit is refused after its audit has still sent the load repair the audit caused, since the release it goes back to may not report it", async () => {
    const { dir, stores } = await makeDataDirWith('data', [
      (store) => makeStore(store, 'agents/agent', false),
      (store) => makeRepairStore(store),
    ]);
    const sent: string[] = [];
    const framework = {
      start: () => {}, stop: async () => {}, getModule: () => null,
      // Every store the audit opens opens, so the audit ends with its repair;
      // a server that didn't connect then refuses the commit.
      listMcplServers: () => [{ id: 'discord', connected: false }],
      notifyOps: (kind: string) => { sent.push(kind); },
    } as never;
    await expect(startFramework(framework, { root: install, release: '0.11.0' }, { dataDir: dir, activeStore: stores[0]!, places: () => [dir] }))
      .rejects.toThrow("couldn't connect the MCPL server discord");
    expect(readCurrent(install)).toBe('0.10.2');
    expect(sent).toEqual(['memory-load-repair']);
  }, 60_000);

  test('commits once every store opens, a start already committed audits nothing, one with no `current` is refused, and one whose `current` can\'t be read ends before any audit', async () => {
    const { dir, stores } = await makeDataDir('data', [
      { namespace: 'agents/agent', crossed: false },
      { namespace: 'agents/agent', crossed: false },
    ]);
    const { framework, counts } = counting();
    const places = () => [dir];
    await startFramework(framework, { root: install, release: '0.11.0' }, { dataDir: dir, activeStore: stores[0]!, places });
    expect(counts.started).toBe(1);
    expect(readCurrent(install)).toBe('0.11.0');
    // Committed, and with its other session crossed now: no audit stops it.
    await makeStore(stores[1]!, 'agents/agent', true);
    const opening = spyOn(JsStore, 'openOrCreate');
    try {
      await startFramework(framework, { root: install, release: '0.11.0' }, { dataDir: dir, activeStore: stores[0]!, places });
      // An install with no `current`, which the launcher wouldn't start.
      rmSync(join(install, 'current'));
      await expect(startFramework(framework, { root: install, release: '0.11.0' }, { dataDir: dir, activeStore: stores[0]!, places }))
        .rejects.toThrow('has no `current` to say which release it runs on');
      // A `current` that isn't a link, which can't be read.
      writeFileSync(join(install, 'current'), '0.10.2');
      await expect(startFramework(framework, { root: install, release: '0.11.0' }, { dataDir: dir, activeStore: stores[0]!, places }))
        .rejects.toThrow(new RegExp(`^This host couldn't read which release the install at ${install} runs on, so none of its agents started: EINVAL: .*\\. Each start reads \`current\` again before any agent starts\\.$`));
      expect(opening).not.toHaveBeenCalled();
    } finally {
      opening.mockRestore();
    }
    expect(counts.started).toBe(2);
    expect(counts.stopped).toBe(2);
  }, 60_000);
});
