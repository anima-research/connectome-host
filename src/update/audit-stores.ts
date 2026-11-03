/**
 * The store audit: whether this release opens every store its residents keep.
 * It opens each store in place, as a start of this release opens it, so it
 * runs only where something taken before it can put the stores back: a host
 * on trial runs it before its commit, and by hand `--audit-stores <data
 * directory>…` runs it in place of a host, right after the copy a hand
 * update takes ("Updating an install" and "Updating checkouts" in
 * docs/DEPLOYMENTS.md).
 *
 * An open is a load, so context-manager's load repair runs in the audit as at
 * a start, and writes what it repairs to the store. Each load repair that
 * dropped summaries holding text is said, since the start that opens the
 * store next finds nothing left to repair.
 */
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { resolveTimeZone, storedInjectionMarkOf, type ContextStrategy } from '@animalabs/agent-framework';
import { JsStore } from '@animalabs/chronicle';
import {
  ContextManager, StoreTopologyError, WindowedPassthroughStrategy, type StoredMessage,
} from '@animalabs/context-manager';
import type { Membrane } from '@animalabs/membrane';
import { resolveAgentName } from '../agent-name.js';
import { AUDIT_POINTER, loadRepairAlert, loadRepairLines, type LoadRepairReport } from '../web/load-repair-alert.js';
import { loadExtensions, type ExtensionRegistry } from '../extensions.js';
import { buildFrameworkStrategy } from '../framework-strategy.js';
import { fleetChildDataDir, fleetChildEnv, spawnErrorText } from '../modules/fleet-module.js';
import { DEFAULT_RECIPE, loadRecipeDetailed, loadSavedRecipe, recipeModel, type Recipe } from '../recipe.js';
import { SessionManager } from '../session-manager.js';
import {
  childrenFilePath, isChildEntry, ITEM_UPDATE_DIR, readRecord, realOrResolved, writeJsonAtomic, type ChildrenFile,
} from './contract.js';
import { StartRefusal } from './host.js';

/** The flag that runs the audit in place of a host: `<entry> --audit-stores
 *  [--recipe <recipe>] <data directory>…`, by hand after a copy. */
export const AUDIT_STORES_FLAG = '--audit-stores';
const RECIPE_OPTION = '--recipe';
/** Given only by an audit to the fleet child's audit it starts: audit this
 *  one directory and none of its recipe's fleet entries. */
const FLEET_CHILD_OPTION = '--fleet-child';
/** Given only by an audit on a trial to a fleet child's audit, once for each
 *  place the trial's fallback puts back, so the child's stores are held to
 *  the trial's places, not its own directory alone. */
const WITHIN_OPTION = '--within';
const FLEET_CHILD_FINISHED = '--fleet-child audit finished';
const FLEET_CHILD_LOAD_REPAIR = '--fleet-child load repair';
const FINISHED_LINE = new RegExp(`^${FLEET_CHILD_FINISHED}: ([01])$`);
const USAGE = `Usage: ${AUDIT_STORES_FLAG} [${RECIPE_OPTION} <recipe>] <data directory>…, with one data directory ` +
  `when a recipe is given`;

/** agent-framework's view of a resident's messages (createAgent): a message
 *  a tune-out diverted, or another agent's stored context injection, never
 *  enters it. agent-framework doesn't export it, so this is a copy. */
const residentView = (name: string) => (message: StoredMessage): boolean =>
  !message.metadata?.tuneOut && !isAnotherAgentsInjection(message.metadata, name);

/** agent-framework's view of the subconscious's messages
 *  (createSubconsciousAgent): its own namespace and the residents' slot
 *  merged, tuned-out rows included, less every other agent's stored context
 *  injection. agent-framework doesn't export it, so this is a copy. */
export const subconsciousView = (name: string) => (message: StoredMessage): boolean =>
  !isAnotherAgentsInjection(message.metadata, name);

function isAnotherAgentsInjection(metadata: unknown, name: string): boolean {
  const mark = storedInjectionMarkOf(metadata);
  return mark !== undefined && mark.agent !== name;
}

/** `then` isn't among its methods, so the membrane isn't a thenable, and a
 *  strategy that awaits it gets it back. */
function noModel(): { membrane: Membrane; called: () => boolean } {
  let called = false;
  const method = (property: string | symbol) => property !== 'then' && typeof property === 'string';
  const membrane = new Proxy({}, {
    get: (_target, property) => {
      if (!method(property)) return undefined;
      return () => {
        called = true;
        throw new Error('the store audit gives a strategy no model');
      };
    },
    has: (_target, property) => method(property),
  }) as Membrane;
  return { membrane, called: () => called };
}

/** Where the audit's lines go: one for each store under each agent name it's
 *  opened under, or one for a store it doesn't open or that isn't there (a
 *  store a trial's audit skips, the one its start has open, gets none), and
 *  one for each directory
 *  it couldn't audit, audits as a fleet child, or reads in another
 *  environment. `failed` marks a store or a directory it couldn't open or
 *  audit. */
export type Say = (line: string, failed: boolean) => void;

/**
 * The audit as the host's entry runs it, in place of a host: every line on
 * stderr. Resolves with its exit status once each line has been written,
 * since Bun drops what's still queued for a pipe at process.exit.
 */
export async function auditStoresFromEntry(args: string[]): Promise<number> {
  const stderr = process.stderr.write.bind(process.stderr);
  const written: Array<Promise<void>> = [];
  const say: Say = (line) => {
    written.push(new Promise<void>((done) => { stderr(`${line}\n`, () => done()); }));
  };
  let status: number;
  try {
    const options: AuditOptions = {};
    let dataDirs = args;
    for (;;) {
      if (dataDirs[0] === RECIPE_OPTION && dataDirs.length > 1) {
        options.recipe = dataDirs[1];
        dataDirs = dataDirs.slice(2);
      } else if (dataDirs[0] === FLEET_CHILD_OPTION) {
        options.fleetChild = true;
        dataDirs = dataDirs.slice(1);
      } else if (dataDirs[0] === WITHIN_OPTION && dataDirs.length > 1) {
        (options.within ??= []).push(dataDirs[1]!);
        dataDirs = dataDirs.slice(2);
      } else {
        break;
      }
    }
    if (options.fleetChild) {
      fleetChildOf = process.ppid;
      const begin = new Promise<void>((done) => {
        process.stdin.on('data', (chunk: Buffer) => { if (chunk.includes(10)) done(); });
      });
      process.stdin.on('end', endWithParent);
      process.stdin.resume();
      await begin;
    }
    status = dataDirs.some((arg) => arg.startsWith('--')) ? usage(say) : await auditStores(dataDirs, say, options);
  } catch (error) {
    say(`Couldn't audit: ${oneLine(error)}`, true);
    status = 1;
  }
  if (fleetChildOf !== undefined) say(`${FLEET_CHILD_FINISHED}: ${status}`, false);
  await Promise.all(written);
  if (fleetChildOf !== undefined && process.ppid !== fleetChildOf) endWithParent();
  return status;
}

let fleetChildOf: number | undefined;

function endWithParent(): never {
  try { process.kill(-process.pid, 'SIGKILL'); } catch { }
  process.exit(1);
}

function endIfOrphaned(): void {
  if (fleetChildOf !== undefined && process.ppid !== fleetChildOf) endWithParent();
}

function usage(say: Say): 1 {
  say(USAGE, true);
  return 1;
}

export function placesOnTrial(committed: string, places: () => string[] | null, opened = 'no store'): string[] {
  let within: string[] | null;
  try {
    within = places();
  } catch (error) {
    throw new StartRefusal(
      `This release couldn't tell which places its trial's fallback puts back, so it opened ${opened} and starts ` +
      `none of its agents: ${oneLine(error)}. The next start's fallback to ${committed} reads the same records; if ` +
      'it can\'t use them either, it says so and starts nothing.',
    );
  }
  if (within === null) {
    throw new StartRefusal(
      `No switch or Go back is under way by the install's journal, so this release opened ${opened} and starts none ` +
      `of its agents: nothing would put back what opening its stores before a commit changes. \`current\` still ` +
      `names ${committed}: start that release, or update to this one through the install's launcher, which starts ` +
      'it as a switch\'s trial.',
    );
  }
  return within;
}

export function checkActiveStore(store: string, committed: string, within: string[]): void {
  const reason = reachesPast(store, within, true, true);
  if (reason === undefined) return;
  throw new StartRefusal(
    `This release can't open its active session's store on its trial, so it opened no store, starts none of its ` +
    `agents, and the next start goes back to ${committed}:\nCouldn't audit ${store}: ${reason}`,
  );
}

export async function auditBeforeCommit(
  dataDir: string, activeStore: string, committed: string, places: () => string[] | null,
  notify: OpsNotify, extensions?: ExtensionRegistry,
): Promise<void> {
  const within = placesOnTrial(committed, places, "no other store than its active session's");
  const failures: string[] = [];
  await auditStores([dataDir], (line, failed) => {
    if (failed && line.startsWith("Couldn't audit ") && line.endsWith(`: ${MODEL_CALLED}`)) {
      console.error(`[update] ${line}; the trial doesn't hold its commit for it`);
      return;
    }
    console.error(`[update] ${line}`);
    if (failed) failures.push(line);
  }, {
    skip: [activeStore], within, listIn: childrenFilePath(resolve(dataDir)), ...(extensions ? { extensions } : {}),
    onLoadRepair: (report, agent, store) => {
      const alert = loadRepairAlert(report, agent, store, AUDIT_POINTER);
      notify(alert.kind, agent, alert.message, alert.data);
    },
  });
  if (failures.length === 0) return;
  throw new StartRefusal(
    `This release couldn't open every store it would open only after its commit, so it starts none of its ` +
    `agents, and the next start goes back to ${committed}:\n${failures.join('\n')}\n` +
    `To take this release, repair each refused store as AGENT-ONBOARDING.md §11.8 says, or correct what a line ` +
    `names, and update again; or stay on ${committed} until a release opens them.`,
  );
}

export type OpsNotify = (kind: string, agent: string, message: string, data?: Record<string, unknown>) => void;

export interface AuditRepair {
  report: LoadRepairReport;
  agent: string;
  store: string;
}

interface Resident {
  name: string;
  namespace: string;
  strategy: () => ContextStrategy;
  subconscious?: { name: string; namespace: string; reAnchorFraction?: number };
}

interface Directory {
  stores: string[];
  names: string[];
  indexed: boolean;
  as: (name: string) => Resident;
}

interface Outcome {
  refused?: string;
  namespace?: string;
  unaudited?: string;
  absent?: true;
  repairs?: LoadRepairReport[];
}

export interface AuditOptions {
  skip?: string[];
  within?: string[];
  listIn?: string;
  recipe?: string;
  fleetChild?: true;
  onLoadRepair?: (report: LoadRepairReport, agent: string, store: string) => void;
  extensions?: ExtensionRegistry;
}

/**
 * Audit every store of each data directory, and of each fleet child its
 * recipe names whose directory exists, saying a line for each store under each
 * agent name, or one for a store it doesn't open or that isn't there. Returns 0
 * when no store was refused and every one that's there was audited, and 1
 * otherwise, or when a directory couldn't be audited.
 */
export async function auditStores(dataDirs: string[], say: Say, options: AuditOptions = {}): Promise<number> {
  if (dataDirs.length === 0 || ((options.recipe !== undefined || options.fleetChild) && dataDirs.length !== 1)) return usage(say);
  let failed = 0;
  const tell = (line: string, failure = false) => {
    if (failure) failed++;
    say(flat(line), failure);
  };
  const repaired = (store: string, agent: string, report: LoadRepairReport) => {
    if (options.fleetChild) {
      tell(`${FLEET_CHILD_LOAD_REPAIR} ${JSON.stringify({ store, agent, report })}`);
      return;
    }
    tell(`${store} (${report.namespace}): ${loadRepairLines(report, agent, store).join(' ')}`);
    options.onLoadRepair?.(report, agent, store);
  };
  const reads = new Map(await Promise.all(dataDirs.map(async (dataDir) =>
    [dataDir, await readRecipe(dataDir, options.recipe)] as const)));
  const env = { ...process.env };
  // A compression log the environment names belongs to a resident, so the
  // audit's opens stay out of it.
  const compressionLog = process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
  delete process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
  try {
    const entriesOf = new Map<string, FleetEntry[]>();
    for (const dataDir of options.fleetChild ? [] : dataDirs) {
      try {
        entriesOf.set(dataDir, fleetEntries(recipeOf(reads.get(dataDir)!)).filter((entry) => entry.dataDir !== resolve(dataDir)));
      } catch (error) {
        tell(`Couldn't audit ${dataDir}'s fleet children: ${oneLine(error)}`, true);
      }
    }
    const named = new Set([...entriesOf.values()].flat().map((entry) => entry.dataDir));
    const children: FleetChild[] = [];
    const parents = new Set<string>();
    for (const [parent, entries] of entriesOf) {
      if (named.has(resolve(parent)) || entries.length === 0) continue;
      parents.add(parent);
      children.push(...entries.map((entry) => ({ parent, ...entry })));
    }
    const childDirs = new Set(children.map((child) => child.dataDir));
    for (const dataDir of dataDirs) {
      if (childDirs.has(resolve(dataDir))) continue;
      if (parents.size > 0 && !parents.has(dataDir)) {
        tell(`${dataDir}: none of the fleet entries of the other directories given names it, so it's audited in ` +
          "this audit's own environment");
      }
      let dataDirIsAPlace = !options.fleetChild || options.within === undefined;
      try {
        dataDirIsAPlace ||= options.within!.some((place) => realOf(place) === realOf(dataDir));
      } catch { }
      let resident: Directory;
      try {
        resident = await residentOf(dataDir, reads.get(dataDir)!, options.extensions);
      } catch (error) {
        tell(`Couldn't audit ${dataDir}: ${oneLine(error)}`, true);
        continue;
      }
      const same = (path: string): string => {
        try {
          return realOf(path) ?? resolve(path);
        } catch {
          return resolve(path);
        }
      };
      const skip = new Set((options.skip ?? []).map(same));
      for (const store of resident.stores) {
        if (skip.has(same(store))) continue;
        const outside = reachesPast(store, options.within ?? [dataDir], options.within !== undefined, dataDirIsAPlace);
        if (outside !== undefined) {
          tell(`Couldn't audit ${store}: ${outside}`, true);
          continue;
        }
        for (const name of resident.names) {
          const here = resident.as(name);
          const outcome = await auditStore(store, here);
          if (outcome.refused !== undefined) {
            tell(`${store} (${outcome.namespace ?? here.namespace}): refused: ${outcome.refused}`, true);
          } else if (outcome.unaudited !== undefined) {
            tell(`Couldn't audit ${store}: ${outcome.unaudited}`, true);
          } else if (outcome.absent) {
            const listed = resident.indexed ? 'the index lists its session, and ' : '';
            tell(`${store} (${here.namespace}): ${listed}no store is there; a start makes an empty one`);
            break;
          } else {
            tell(`${store} (${here.namespace}): opens`);
          }
          for (const report of outcome.repairs ?? []) repaired(store, name, report);
        }
      }
    }
    for (const child of children) {
      const { dataDir } = child;
      const name = `${child.parent}'s fleet child ${child.name}`;
      let there: boolean;
      try {
        there = lstatSync(dataDir, { throwIfNoEntry: false }) !== undefined;
      } catch (error) {
        tell(`Couldn't audit ${dataDir}, ${name}'s directory: it can't be reached: ${oneLine(error)}`, true);
        continue;
      }
      let linkToNothing = false;
      let under = true;
      try {
        linkToNothing = there && realOf(dataDir) === null;
        under = options.within === undefined || inside(dataDir, options.within);
      } catch (error) {
        tell(`Couldn't audit ${dataDir}, ${name}'s directory: its real path can't be had: ${oneLine(error)}`, true);
        continue;
      }
      if (!there && under) {
        tell(`${dataDir}: ${name} has no directory yet; its start makes one`);
      } else if (linkToNothing) {
        tell(`Couldn't audit ${dataDir}, ${name}'s directory: it's a link to nothing, so it wasn't audited. To update, ` +
          "point the link at the child's directory, or remove it.", true);
      } else if (!under) {
        tell(`Couldn't audit ${dataDir}, ${name}'s directory: it lies outside every place this trial's fallback puts ` +
          `back, where an update can't put back what ${there ? 'opening its stores changes' : 'its start makes there'}, ` +
          `so it wasn't audited. To update, ${there ? `move it under ${child.parent} and point its fleet entry ` +
          'there, or declare it' : `point its fleet entry under ${child.parent}, or make the directory and declare ` +
          'it'} by running setup again with --extra-state PATH for it and for each place already recorded, so each ` +
          'update copies it.', true);
      } else {
        await auditAsFleetChild(dataDir, child, env, tell, repaired, options.listIn, options.within);
      }
    }
  } finally {
    if (compressionLog !== undefined) process.env.CONTEXT_MANAGER_COMPRESSION_LOG = compressionLog;
  }
  return failed > 0 ? 1 : 0;
}

function inside(path: string, places: string[]): boolean {
  const at = realOf(path);
  if (at === null) return false;
  return places.some((place) => {
    const root = realOf(place);
    if (root === null) return false;
    const from = relative(root, at);
    if (from === '') return true;
    if (from === '..' || from.startsWith(`..${sep}`) || isAbsolute(from)) return false;
    return !from.split(sep).includes(ITEM_UPDATE_DIR);
  });
}

function reachesPast(store: string, places: string[], onTrial: boolean, dataDirIsAPlace: boolean): string | undefined {
  const where = onTrial ? "every place this trial's fallback puts back" : places[0]!;
  try {
    if (realOf(store) === null) {
      return "it's a link to nothing, so it wasn't opened. To update, point the link at the session's store, or " +
        'remove it.';
    }
    if (!inside(store, places)) {
      return `it lies outside ${where}, where an update can't put back what opening it changes, so it wasn't ` +
        'opened. ' + goOn(onTrial, "move the store into its data directory, where its session's entry in " +
          'sessions.json names it', 'the store', "its session's entry in sessions.json naming it there",
          'the directory it lies in', dataDirIsAPlace);
    }
    return escapeFrom(store, places, where, onTrial, dataDirIsAPlace) ?? undefined;
  } catch (error) {
    return `it can't be read: ${oneLine(error)}, so it wasn't opened`;
  }
}

function goOn(onTrial: boolean, first: string, carries: string, repointed: string, declared: string,
  dataDirIsAPlace: boolean): string {
  const ways = [first];
  if (dataDirIsAPlace) ways.push(`point the data directory itself at the other disk, with ${carries} moved into it and ${repointed}`);
  if (onTrial) {
    ways.push(`declare ${declared} by running setup again with --extra-state PATH for it and for each place already ` +
      'recorded, so each update copies it');
  }
  return `To update, ${ways.length === 3 ? `${ways[0]}, ${ways[1]}, or ${ways[2]}` : ways.join(', or ')}.`;
}

function escapeFrom(store: string, places: string[], where: string, onTrial: boolean, dataDirIsAPlace: boolean): string | null {
  const walked = new Set<string>();
  const walk = (dir: string): string | null => {
    let real: string;
    try {
      real = realpathSync(dir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (dir === store && (code === 'ENOENT' || code === 'ENOTDIR')) return null;
      throw error;
    }
    if (walked.has(real) || !statSync(real).isDirectory()) return null;
    walked.add(real);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        if (realOf(path) === null) {
          return `it holds ${path}, a link to nothing, which opening it could make where an update can't take it ` +
            "away, so it wasn't opened. To update, point the link at a file inside the store, or remove it.";
        }
        if (!inside(path, places)) {
          return `it holds ${path}, a link to what lies outside ${where}, which opening it could change where an ` +
            "update can't put it back, so it wasn't opened. " +
            goOn(onTrial, "keep the store's files inside it", 'what the link reaches', 'the link pointed at it there',
              'the place the link reaches', dataDirIsAPlace);
        }
        if (statSync(path).isDirectory()) {
          const found = walk(path);
          if (found !== null) return found;
        }
      } else if (entry.isDirectory()) {
        const found = walk(path);
        if (found !== null) return found;
      }
    }
    return null;
  };
  return walk(store);
}

function realOf(p: string): string | null {
  let link = false;
  try {
    link = lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
  } catch { }
  if (link) {
    try {
      realpathSync(p);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      throw error;
    }
  }
  return realOrResolved(p);
}

async function auditStore(path: string, resident: Resident): Promise<Outcome> {
  try {
    if (lstatSync(path, { throwIfNoEntry: false }) === undefined) return { absent: true };
  } catch (error) {
    return { unaudited: `it can't be reached: ${oneLine(error)}` };
  }
  endIfOrphaned();
  let store: JsStore;
  try {
    store = JsStore.openOrCreate({ path });
  } catch (error) {
    return { refused: refusal(error) };
  }
  let outcome: Outcome = {};
  const repairs: LoadRepairReport[] = [];
  try {
    outcome = await auditNamespace(store, resident, repairs);
  } finally {
    try {
      store.close();
    } catch (error) {
      const closing = `closing it failed: ${oneLine(error)}`;
      if (outcome.refused !== undefined) outcome = { ...outcome, refused: withClosing(outcome.refused, closing) };
      else if (outcome.unaudited !== undefined) outcome = { unaudited: withClosing(outcome.unaudited, closing) };
      else outcome = { unaudited: `it opened, and ${closing}` };
    }
  }
  return repairs.length > 0 ? { ...outcome, repairs } : outcome;
}

function withClosing(line: string, closing: string): string {
  return `${line.replace(/\.$/, '')}; ${closing}`;
}

async function auditNamespace(store: JsStore, resident: Resident, repairs: LoadRepairReport[]): Promise<Outcome> {
  let strategy: ContextStrategy;
  try {
    strategy = resident.strategy();
  } catch (error) {
    return { unaudited: `its strategy couldn't be built for it: ${oneLine(error)}` };
  }
  // context-manager hands a report to a handler a microtask after its
  // load, which runs at the strategy's first await after it, before
  // that open resolves.
  const repairCapable = strategy as { setLoadRepairHandler?: (fn: (report: LoadRepairReport) => unknown) => void };
  if (typeof repairCapable.setLoadRepairHandler === 'function') {
    repairCapable.setLoadRepairHandler((report) => { repairs.push(report); });
  }
  const opens: Array<{ namespace: string; model: ReturnType<typeof noModel>; open: (membrane: Membrane) => Promise<ContextManager> }> = [{
    namespace: resident.namespace,
    model: noModel(),
    open: (membrane) => ContextManager.open({
      store, namespace: resident.namespace, strategy, membrane, viewFilter: residentView(resident.name),
    }),
  }];
  const { subconscious } = resident;
  if (subconscious !== undefined) {
    opens.push({
      namespace: subconscious.namespace,
      model: noModel(),
      open: (membrane) => ContextManager.open({
        store,
        namespace: subconscious.namespace,
        isolate: true,
        auxiliaryMessageViews: [{}],
        viewFilter: subconsciousView(subconscious.name),
        strategy: new WindowedPassthroughStrategy({
          reAnchorFraction: subconscious.reAnchorFraction,
          maxMessageTokens: (strategy as { maxMessageTokens?: number }).maxMessageTokens,
        }),
        membrane,
      }),
    });
  }
  const opened: ContextManager[] = [];
  const closeAll = (): string | undefined => {
    let failure: string | undefined;
    for (const manager of opened.reverse()) {
      try {
        manager.close();
      } catch (error) {
        failure ??= oneLine(error);
      }
    }
    return failure;
  };
  for (const { namespace, model, open } of opens) {
    endIfOrphaned();
    try {
      opened.push(await open(model.membrane));
    } catch (error) {
      if (model.called() && !topologyRefused(error)) continue;
      const closing = closeAll();
      const refused = closing === undefined
        ? refusal(error)
        : withClosing(refusal(error), `closing what it had opened failed: ${closing}`);
      return namespace === resident.namespace ? { refused } : { refused, namespace };
    }
  }
  const closing = closeAll();
  if (closing !== undefined) return { unaudited: `it opened, and closing it failed: ${closing}` };
  if (opens.some(({ model }) => model.called())) return { unaudited: MODEL_CALLED };
  return {};
}

const MODEL_CALLED = 'its strategy called a model while opening it, and the audit gives a strategy none: only a ' +
  'start of this release can answer for this store';

type RecipeRead = { recipe: Recipe | null } | { error: unknown };

async function readRecipe(dataDir: string, source: string | undefined): Promise<RecipeRead> {
  try {
    return source !== undefined
      ? { recipe: (await loadRecipeDetailed(source, { fetchSystemPrompt: false })).recipe }
      : { recipe: await loadSavedRecipe(dataDir, { fetchSystemPrompt: false }) };
  } catch (error) {
    return { error };
  }
}

function recipeOf(read: RecipeRead): Recipe | null {
  return 'error' in read ? null : read.recipe;
}

interface FleetEntry {
  name: string;
  dataDir: string;
  recipe: string;
  env?: Record<string, string>;
  timeZone: string;
}

function fleetEntries(recipe: Recipe | null): FleetEntry[] {
  const fleet = recipe?.modules?.fleet;
  if (recipe === null || typeof fleet !== 'object' || fleet === null || fleet.children === undefined) return [];
  const timeZone = resolveTimeZone(recipe.agent.timezone);
  return fleet.children.map((entry) => ({
    name: entry.name,
    dataDir: fleetChildDataDir(entry),
    recipe: entry.recipe,
    ...(entry.env !== undefined ? { env: entry.env } : {}),
    timeZone,
  }));
}

interface FleetChild extends FleetEntry {
  parent: string;
}

const HOST_ENTRY = join(import.meta.dir, '..', 'index.ts');

function failureLine(line: string): boolean {
  if (line.startsWith("Couldn't audit")) return true;
  if (line.endsWith('): opens') || line.endsWith('no store is there; a start makes an empty one')) return false;
  return line.includes('): refused: ');
}

function listAudit(file: string, entry: ChildrenFile['children'][number]): string | null {
  try {
    const held = readRecord<ChildrenFile>(file, "fleet's children file");
    if (held !== null && !Array.isArray(held.children)) return 'it has no list of children this release can read';
    writeJsonAtomic(file, { v: 1, children: [...(held?.children ?? []), entry] });
    return null;
  } catch (error) {
    return oneLine(error);
  }
}

function unlistAudit(file: string, name: string, pid: number, quiet = false): void {
  try {
    const held = readRecord<ChildrenFile>(file, "fleet's children file");
    if (held === null || !Array.isArray(held.children)) return;
    const children = held.children.filter((entry) => !(isChildEntry(entry) && entry.name === name && entry.pid === pid));
    if (children.length === held.children.length) return;
    writeJsonAtomic(file, { v: 1, children });
  } catch (error) {
    if (!quiet) console.error(`[update] couldn't take ${name} (pid ${pid}), which has ended, out of ${file}: ${oneLine(error)}`);
  }
}

async function groupGone(pid: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    }
    if (Date.now() >= until) return false;
    await new Promise((wait) => setTimeout(wait, 20));
  }
}

function bootId(): string | null {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null;
  } catch {
    return null;
  }
}

const STDERR_GRACE_MS = 2_000;

/** How long a fleet child's audit may run, unless the host's environment
 *  gives other minutes (CHILD_AUDIT_MINUTES_ENV): one that hasn't ended by
 *  then has its group ended and isn't audited. A child whose stores need
 *  longer gets it from the setting, which the line for a child that hadn't
 *  finished names. */
const CHILD_AUDIT_LIMIT_MS = 5 * 60_000;
export const CHILD_AUDIT_MINUTES_ENV = 'CONNECTOME_FLEET_CHILD_AUDIT_MINUTES';

/** A fleet child's audit's limit: the minutes `env` gives, when they're a
 *  number above 0, up to what a timer holds (Infinity included), or else
 *  CHILD_AUDIT_LIMIT_MS. */
export function childAuditLimitMs(env: NodeJS.ProcessEnv): number {
  const minutes = Number(env[CHILD_AUDIT_MINUTES_ENV]);
  return minutes > 0 ? Math.min(minutes * 60_000, 2 ** 31 - 1) : CHILD_AUDIT_LIMIT_MS;
}

export function fleetChildRepair(line: string): AuditRepair | undefined {
  if (!line.startsWith(`${FLEET_CHILD_LOAD_REPAIR} `)) return undefined;
  let said: unknown;
  try {
    said = JSON.parse(line.slice(FLEET_CHILD_LOAD_REPAIR.length + 1));
  } catch {
    return undefined;
  }
  const { store, agent, report } = (said ?? {}) as Partial<Record<'store' | 'agent' | 'report', unknown>>;
  return typeof store === 'string' && typeof agent === 'string' && isLoadRepairReport(report)
    ? { store, agent, report }
    : undefined;
}

function isLoadRepairReport(value: unknown): value is LoadRepairReport {
  const v = value as Partial<Record<keyof LoadRepairReport, unknown>> | null;
  const numberOrNull = (x: unknown) => x === null || typeof x === 'number';
  const timeOrNull = (x: unknown) => x === null || typeof x === 'string';
  return typeof v === 'object' && v !== null &&
    typeof v.namespace === 'string' && typeof v.branch === 'string' && typeof v.stateId === 'string' &&
    typeof v.sequenceBefore === 'number' && typeof v.droppedTokens === 'number' && typeof v.emptyDropped === 'number' &&
    Array.isArray(v.dropped) && v.dropped.every((d: unknown) => {
      const drop = d as Record<string, unknown> | null;
      if (typeof drop !== 'object' || drop === null) return false;
      const range = drop.sourceRange as Record<string, unknown> | null | undefined;
      return typeof drop.id === 'string' && numberOrNull(drop.level) && numberOrNull(drop.tokens) && typeof drop.reason === 'string' &&
        (range === null || (typeof range === 'object' && range !== undefined && typeof range.first === 'string' &&
          typeof range.last === 'string' && timeOrNull(range.firstAt) && timeOrNull(range.lastAt)));
    });
}

async function auditAsFleetChild(
  dataDir: string, child: FleetChild, env: NodeJS.ProcessEnv, tell: (line: string, failure?: boolean) => void,
  repaired: (store: string, agent: string, report: LoadRepairReport) => void,
  listIn?: string, within?: string[],
): Promise<void> {
  const listing = `${child.name}'s store audit`;
  let maybeListed: number | undefined;
  let unlisted: string | undefined;
  tell(`${dataDir}: audited as ${child.parent}'s fleet child ${child.name}, under the recipe its entry names, in the ` +
    'environment the fleet starts it with');
  let timedOut = false;
  const limitMs = childAuditLimitMs(env);
  const { stderr, status, signal, error } = await new Promise<{
    stderr: string; status: number | null; signal: NodeJS.Signals | null; error?: unknown;
  }>((done) => {
    let audit: ReturnType<typeof spawn>;
    try {
      const places = (within ?? []).flatMap((place) => [WITHIN_OPTION, place]);
      const args = [HOST_ENTRY, AUDIT_STORES_FLAG, FLEET_CHILD_OPTION, ...places, RECIPE_OPTION, child.recipe, dataDir];
      audit = spawn(process.execPath, args, {
        env: fleetChildEnv(env, child.env, child.timeZone, dataDir),
        stdio: ['pipe', 'ignore', 'pipe'],
        detached: true,
      });
    } catch (thrown) {
      done({ stderr: '', status: null, signal: null, error: thrown });
      return;
    }
    audit.stdin!.on('error', () => {});
    if (audit.pid !== undefined) {
      if (listIn !== undefined) maybeListed = audit.pid;
      const why = listIn === undefined ? null : listAudit(listIn, { name: listing, pid: audit.pid, bootId: bootId(), dataDir });
      if (why === null) {
        audit.stdin!.write('\n');
      } else {
        unlisted = why;
        try { process.kill(-audit.pid, 'SIGKILL'); } catch { }
      }
    }
    const chunks: Buffer[] = [];
    let exit: { status: number | null; signal: NodeJS.Signals | null } | undefined;
    let settled = false;
    let limit: ReturnType<typeof setTimeout> | undefined;
    const settle = (result: { stderr: string; status: number | null; signal: NodeJS.Signals | null; error?: unknown }) => {
      if (settled) return;
      settled = true;
      clearTimeout(limit);
      audit.stdin?.destroy();
      done(result);
    };
    audit.stderr!.on('data', (chunk: Buffer) => chunks.push(chunk));
    limit = setTimeout(() => {
      timedOut = true;
      try { process.kill(-audit.pid!, 'SIGKILL'); } catch { }
      setTimeout(() => settle({ stderr: Buffer.concat(chunks).toString(), status: null, signal: 'SIGKILL' }), STDERR_GRACE_MS).unref();
    }, limitMs);
    audit.on('error', (thrown) => settle({ stderr: Buffer.concat(chunks).toString(), status: null, signal: null, error: thrown }));
    audit.on('exit', (code, sig) => {
      clearTimeout(limit);
      exit = { status: code, signal: sig };
      try { process.kill(-audit.pid!, 'SIGKILL'); } catch { }
      setTimeout(() => {
        audit.stderr!.destroy();
        settle({ stderr: Buffer.concat(chunks).toString(), ...exit! });
      }, STDERR_GRACE_MS).unref();
    });
    audit.on('close', () => settle({ stderr: Buffer.concat(chunks).toString(), ...(exit ?? { status: null, signal: null }) }));
  });
  if (maybeListed !== undefined) {
    if (await groupGone(maybeListed, STDERR_GRACE_MS)) unlistAudit(listIn!, listing, maybeListed, unlisted !== undefined);
    else {
      console.error(`[update] ${listing} (pid ${maybeListed}) still has a process in its group after its SIGKILL, ` +
        (unlisted === undefined
          ? `so it stays listed in ${listIn} while that group has one. `
          : `and it couldn't be listed in ${listIn}, so an update reading it may not see it. `) +
        'Once sure that group is this audit\'s, whoever runs this host can end it, as a user allowed to signal it, ' +
        `with \`kill -KILL -- -${maybeListed}\`; a process held in the kernel ends only once the kernel lets it go.`);
    }
  }
  if (error !== undefined) {
    tell(`Couldn't audit ${dataDir}: its audit couldn't be started: ${flat(spawnErrorText(error))}`, true);
    return;
  }
  if (unlisted !== undefined) {
    tell(`Couldn't audit ${dataDir}: its audit couldn't be listed in ${listIn}, which an update reads to see which ` +
      `processes may still be running, so it was ended: ${unlisted}`, true);
    return;
  }
  const lines = stderr.split('\n').filter((line) => line !== '');
  let at = lines.length - 1;
  while (at >= 0 && !FINISHED_LINE.test(lines[at]!)) at--;
  const finished = at !== -1;
  const said = finished ? Number(FINISHED_LINE.exec(lines[at]!)![1]) : undefined;
  if (finished) lines.splice(at, 1);
  const answered = !timedOut && finished && signal === null && status === said;
  const failed = !answered || status !== 0;
  let failures = 0;
  for (const line of lines) {
    const repair = fleetChildRepair(line);
    if (repair) {
      repaired(repair.store, repair.agent, repair.report);
      continue;
    }
    const failure = failed && failureLine(line);
    if (failure) failures++;
    tell(line, failure);
  }
  const byHand = `\`--audit-stores\` on ${child.parent}, after a copy of it and of each of its fleet children's ` +
    'directories, run as this host is started, with its recipe and its environment, audits this child as its fleet ' +
    'starts it';
  const minutes = limitMs / 60_000;
  const figure = Number(minutes >= 1 ? minutes.toFixed(1) : minutes.toPrecision(2));
  const limit = `${figure} ${figure === 1 ? 'minute' : 'minutes'}`;
  if (timedOut) {
    tell(finished
      ? `Couldn't audit ${dataDir}: its audit ran to its end and said it had finished, but didn't end within ` +
        `${limit}, so it was sent SIGKILL, and its answer can't be taken. Something held it after its last store, ` +
        `such as an extension in its process: ${byHand}. If it is held again, inspect the child's process.`
      : `Couldn't audit ${dataDir}: its audit didn't end within ${limit}, so it was sent SIGKILL, and it isn't known ` +
        'that every store there was audited. Something may have held it, such as an extension that waits at its ' +
        `import, a recipe slow to load, or a store slow to open: ${byHand}, and shows where it stops, should it stop ` +
        `again. Where its stores need longer, ${CHILD_AUDIT_MINUTES_ENV} in this host's environment gives it more ` +
        'minutes.', true);
  } else if (!answered) {
    tell(!finished
      ? `Couldn't audit ${dataDir}: its audit ${signal !== null ? `was ended by ${signal}` : `exited with status ${status}`} ` +
        `before it said it had finished, so it isn't known that every store there was audited: ${byHand}, and ` +
        'shows where it stops, should it stop again.'
      : signal !== null
        ? `Couldn't audit ${dataDir}: its audit ran to its end and said it had finished, but was then ended by ` +
          `${signal}, so its answer can't be taken: ${byHand}.`
        : `Couldn't audit ${dataDir}: its audit ran to its end and said it would exit with status ${said}, but ` +
          `exited with status ${status}, so its answer can't be taken. Something in its process, such as an ` +
          `extension's exit handler, set that status: ${byHand}, and shows whether it happens again.`, true);
  } else if (status === 1 && failures === 0) {
    tell(`Couldn't audit ${dataDir}: its audit answered 1 and said of no store why, so it can't be taken as clean: ` +
      `${byHand}.`, true);
  }
}

async function residentOf(dataDir: string, read: RecipeRead, loaded?: ExtensionRegistry): Promise<Directory> {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(dataDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error("it isn't there");
    throw error;
  }
  if (!stat.isDirectory()) throw new Error("it isn't a directory");
  if ('error' in read) throw read.error;
  const recipe = read.recipe ?? DEFAULT_RECIPE;
  const sessions = new SessionManager(dataDir);
  const indexed = existsSync(join(dataDir, 'sessions.json'));
  let index: ReturnType<SessionManager['load']>;
  try {
    index = sessions.load();
  } catch (error) {
    throw new Error(`its session index, sessions.json, can't be read: ${oneLine(error)}`);
  }
  const nameOf = (id?: string): string => resolveAgentName({
    explicit: recipe.agent.name,
    sidecar: id === undefined ? undefined : sessions.getImportSource(id)?.agentName,
    default: 'agent',
  }).name;
  const names = [...new Set([nameOf(), ...Object.values(index.sessions).map((meta) => nameOf(meta.id))])];
  const stores = indexed
    ? [...new Set(Object.entries(index.sessions).flatMap(([key, meta]) => [key, meta.id]))]
        .map((id) => sessions.getStorePath(id))
    : [join(dataDir, 'store')];
  const extensions = loaded ?? await loadExtensions(recipe);
  const model = recipeModel(recipe, process.env.MODEL);
  const timeZone = resolveTimeZone(recipe.agent.timezone);
  const strategy = () => buildFrameworkStrategy(recipe, model, timeZone, extensions);
  assertBuilds(strategy);
  const { subconscious } = recipe;
  return {
    stores,
    names,
    indexed,
    as: (name) => ({
      name,
      namespace: `agents/${name}`,
      strategy,
      // Reader forks read the resident's own context and open no subconscious namespace.
      ...(subconscious?.enabled && subconscious.reader !== 'forks'
        ? {
            subconscious: {
              // agent-framework's default name, as the recipe's doc says.
              name: ('name' in subconscious ? subconscious.name : undefined) ?? 'Subconscious',
              namespace: `subconscious/${name}`,
              ...('reAnchorFraction' in subconscious && subconscious.reAnchorFraction !== undefined
                ? { reAnchorFraction: subconscious.reAnchorFraction }
                : {}),
            },
          }
        : {}),
    }),
  };
}

/** Whether an open's error is a store's topology refusal: context-manager's
 *  StoreTopologyError, from this host's copy of the library or from one a
 *  strategy's extension brought with it, whose class is its own. */
function assertBuilds(build: () => unknown): void {
  build();
}

function topologyRefused(error: unknown): boolean {
  return error instanceof StoreTopologyError ||
    (error instanceof Error && error.message.startsWith('store topology rejected:'));
}

/** context-manager's StoreTopologyError, from any copy of the library, ends
 *  "Repair the store or set topologyPolicy: 'report' to open it for
 *  inspection.", an option the host's built-in strategies take from no
 *  recipe, so the line names §11.8 in its place. */
function refusal(error: unknown): string {
  const line = oneLine(error);
  if (!topologyRefused(error)) return line;
  const remedy = line.lastIndexOf(' Repair the store');
  return `${remedy >= 0 ? line.slice(0, remedy) : line} AGENT-ONBOARDING.md §11.8 says what a store with crossed summaries needs.`;
}

function oneLine(error: unknown): string {
  return flat(error instanceof Error ? error.message : String(error));
}

function flat(text: string): string {
  return text.replace(/\s*[\r\n]\s*/g, ' ');
}
