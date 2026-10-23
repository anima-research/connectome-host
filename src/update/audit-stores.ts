/**
 * The store audit: whether this release opens every store its residents keep.
 * It opens each store in place, as a start of this release opens it, so it
 * runs only where something taken before it can put the stores back:
 * - a host on trial runs it before its commit (auditBeforeCommit, from
 *   startFramework), over every store it would otherwise open only after the
 *   commit: its own sessions but the active one, which its start has open
 *   already, and its recipe's fleet children. It opens only stores under a
 *   place the trial's fallback puts back or takes away. A store it can't open
 *   ends the trial, and the fallback undoes what the trial changed;
 * - by hand, `--audit-stores <data directory>…` runs it in place of a host,
 *   right after the copy a hand update takes ("Updating an install" and
 *   "Updating checkouts" in docs/DEPLOYMENTS.md).
 *
 * In each store, the audit opens what a start of this release opens through
 * context-manager: the agent's namespace as agent-framework's createAgent
 * opens it, and, when the recipe enables the subconscious, its namespace as
 * createSubconsciousAgent does, while the agent's is open. It does so for
 * each session the directory's index lists, since a session switch opens the
 * others too, under `agents/<name>` with each name a start can resolve, since
 * a start keeps its name through switches (residentOf), with the
 * resident's own strategy, built from the recipe a start would load as a
 * start builds it, and with the framework's view of the resident's messages.
 * agent-framework's own state in the store isn't read. Each fleet entry of a
 * directory's recipe whose directory exists is that directory's child, and
 * its audit runs in a process of its own, as the fleet launches the child:
 * under the recipe its entry names and in the environment the fleet starts it
 * with (fleetChildEnv). What an open throws is a refusal; a strategy that
 * calls a model, which the audit gives it none of, leaves the store not
 * audited, unless its open refused the store on its topology all the same,
 * or another namespace's open refused it.
 * Each store is read at its current branch, as an open reads it.
 */
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { resolveTimeZone, type ContextStrategy } from '@animalabs/agent-framework';
import { JsStore } from '@animalabs/chronicle';
import {
  ContextManager, StoreTopologyError, WindowedPassthroughStrategy, type StoredMessage,
} from '@animalabs/context-manager';
import type { Membrane } from '@animalabs/membrane';
import { resolveAgentName } from '../agent-name.js';
import { loadExtensions, type ExtensionRegistry } from '../extensions.js';
import { recipeModel } from '../framework-agent-config.js';
import { buildFrameworkStrategy } from '../framework-strategy.js';
import { fleetChildDataDir, fleetChildEnv, spawnErrorText } from '../modules/fleet-module.js';
import { DEFAULT_RECIPE, loadRecipeDetailed, loadSavedRecipe, type Recipe } from '../recipe.js';
import { SessionManager } from '../session-manager.js';
import {
  childrenFilePath, isChildEntry, ITEM_UPDATE_DIR, readRecord, realOrResolved, writeJsonAtomic, type ChildrenFile,
} from './contract.js';

/** The flag that runs the audit in place of a host: `<entry> --audit-stores
 *  [--recipe <recipe>] <data directory>…`, by hand after a copy, and for each
 *  fleet child an audit finds, with the recipe its entry names. */
export const AUDIT_STORES_FLAG = '--audit-stores';
const RECIPE_OPTION = '--recipe';
/** Given only by an audit to the fleet child's audit it starts: audit this one
 *  directory and none of its recipe's fleet entries, since a fleet child has
 *  no children of its own (the fleet refuses to launch one whose recipe
 *  declares a fleet), so no audit reaches past one level. */
const FLEET_CHILD_OPTION = '--fleet-child';
/** Given only by an audit on a trial to a fleet child's audit, once for each
 *  place the trial's fallback puts back, so the child's stores are held to
 *  the trial's places, not its own directory alone. */
const WITHIN_OPTION = '--within';
/** A fleet child's audit's last line, which says it ran to its end, having
 *  said what it found of each store, and gives the status it ends with:
 *  `--fleet-child audit finished: 0` or `: 1`. */
const FLEET_CHILD_FINISHED = '--fleet-child audit finished';
/** A fleet child's finished line, with the status it gives. */
const FINISHED_LINE = new RegExp(`^${FLEET_CHILD_FINISHED}: ([01])$`);
const USAGE = `Usage: ${AUDIT_STORES_FLAG} [${RECIPE_OPTION} <recipe>] <data directory>…, with one data directory ` +
  `when a recipe is given`;

/** agent-framework's view of a resident's messages (createAgent, in
 *  framework.ts): a message a tune-out diverted never enters it, so the
 *  strategy never chunks one into its pyramid. agent-framework 0.24.0
 *  doesn't export it, so this is a copy, and test/update-audit-stores.test.ts
 *  opens the same stores through agent-framework's own path to keep the two
 *  in step. */
const residentView = (message: StoredMessage): boolean => !message.metadata?.tuneOut;

/** A membrane for one open that gives no model: each of its methods a
 *  strategy calls, complete, stream, streamYielding or any other, throws, so
 *  the strategy can't go on as if it had an answer, and `called` says whether
 *  one was called. An open whose strategy called a model can't be audited,
 *  whether the open then threw or the strategy caught the error, unless the
 *  open refused the store on its topology, which stands, as does another
 *  namespace's refusal. It isn't a thenable,
 *  so a strategy that awaits it gets it back. */
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
    // So a strategy that checks for a method finds it, as on a membrane.
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
 * stderr. Resolves with its exit status once each line has been written:
 * Bun drops what's still queued for a pipe at process.exit, and an empty
 * write's callback doesn't wait for the writes before it, so each line's own
 * write is waited for, a failure the audit itself throws included.
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
    // A fleet child's audit ends when the audit that started it does, however
    // that one ends: at once, when its pipe to this one's stdin closes, and
    // before each store it would open, by its parent, should this process's
    // event loop be held up meanwhile. It begins only once that audit says
    // to, with a line on that pipe, which on a trial comes once it has listed
    // this one in the children file, so nothing it does, an extension's
    // import included, comes before the listing: only this release's own
    // modules load first.
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
  // The audit that started it takes its status as its answer only after this
  // line, and only as the status the line gives, so an exit before the
  // audit's end, or a status set as it exits, such as by an extension, isn't
  // one.
  if (fleetChildOf !== undefined) say(`${FLEET_CHILD_FINISHED}: ${status}`, false);
  await Promise.all(written);
  // The audit that started it ends its group once it has exited; one that
  // has ended first can't, so whatever this one's extensions started in its
  // group ends with it here.
  if (fleetChildOf !== undefined && process.ppid !== fleetChildOf) endWithParent();
  return status;
}

/** The audit that started this one as a fleet child's, while this process
 *  is that; its pid, which this process's parent stays while it runs. */
let fleetChildOf: number | undefined;

/** A fleet child's audit whose parent has ended ends too, with whatever it
 *  started: it leads its own group when an audit started it. */
function endWithParent(): never {
  try { process.kill(-process.pid, 'SIGKILL'); } catch { /* not a group's leader */ }
  process.exit(1);
}

/** Before each open of a fleet child's audit: it opens nothing once the
 *  audit that started it has ended, whatever held up its event loop, since
 *  its parent is then another. */
function endIfOrphaned(): void {
  if (fleetChildOf !== undefined && process.ppid !== fleetChildOf) endWithParent();
}

function usage(say: Say): 1 {
  say(USAGE, true);
  return 1;
}

/**
 * The places a host on trial may open stores under: every place its
 * fallback puts back or takes away (`places`, from trialPlaces). Read before
 * the start opens any store, its active session's included, since the
 * fallback can undo only what changes there. When it can't tell, or no trial
 * is under way, it throws, saying what the start has `opened`, so it ends
 * there. `committed` is the release `current` still names, which the next
 * start goes back to: on a Go back's trial, the newer one.
 */
export function placesOnTrial(committed: string, places: () => string[] | null, opened = 'no store'): string[] {
  let within: string[] | null;
  try {
    within = places();
  } catch (error) {
    throw new Error(
      `This release couldn't tell which places its trial's fallback puts back, so it opened ${opened} and starts ` +
      `none of its agents: ${oneLine(error)}. The next start's fallback to ${committed} reads the same records; if ` +
      'it can\'t use them either, it says so and starts nothing.',
    );
  }
  if (within === null) {
    throw new Error(
      `No switch or Go back is under way by the install's journal, so this release opened ${opened} and starts none ` +
      `of its agents: nothing would put back what opening its stores before a commit changes. \`current\` still ` +
      `names ${committed}: start that release, or update to this one through the install's launcher, which starts ` +
      'it as a switch\'s trial.',
    );
  }
  return within;
}

/**
 * Before a host on trial opens its active session's store, which its start
 * does as it creates the framework: the store has to lie under `within`, and
 * hold no link past it, as every store the audit opens does, since that open
 * writes in place too. Throws otherwise, so the start ends having opened
 * nothing.
 */
export function checkActiveStore(store: string, committed: string, within: string[]): void {
  const reason = reachesPast(store, within, true, true);
  if (reason === undefined) return;
  throw new Error(
    `This release can't open its active session's store on its trial, so it opened no store, starts none of its ` +
    `agents, and the next start goes back to ${committed}:\nCouldn't audit ${store}: ${reason}`,
  );
}

/**
 * The audit a host on trial runs before its commit (startFramework): every
 * store this release would otherwise open only after the commit. That's this
 * host's own sessions but `activeStore`, which its start has open already,
 * and which chronicle wouldn't open twice, and its recipe's fleet children.
 * Only a store under a place `places` gives (placesOnTrial) is opened. A
 * store whose only line is that its strategy called a model while opening it
 * is said, and doesn't hold the commit. When any other store isn't opened,
 * it throws, naming each, so the trial ends before its commit.
 */
export async function auditBeforeCommit(
  dataDir: string, activeStore: string, committed: string, places: () => string[] | null,
  extensions?: ExtensionRegistry,
): Promise<void> {
  const within = placesOnTrial(committed, places, "no other store than its active session's");
  const failures: string[] = [];
  await auditStores([dataDir], (line, failed) => {
    // A store no audit can answer for doesn't hold the commit: holding it
    // would hold every update, and its start is what answers.
    if (failed && line.startsWith("Couldn't audit ") && line.endsWith(`: ${MODEL_CALLED}`)) {
      console.error(`[update] ${line}; the trial doesn't hold its commit for it`);
      return;
    }
    console.error(`[update] ${line}`);
    if (failed) failures.push(line);
  }, { skip: [activeStore], within, listIn: childrenFilePath(resolve(dataDir)), ...(extensions ? { extensions } : {}) });
  if (failures.length === 0) return;
  throw new Error(
    `This release couldn't open every store it would open only after its commit, so it starts none of its ` +
    `agents, and the next start goes back to ${committed}:\n${failures.join('\n')}\n` +
    `To take this release, repair each refused store as AGENT-ONBOARDING.md §11.8 says, or correct what a line ` +
    `names, and update again; or stay on ${committed} until a release opens them.`,
  );
}

/** What the audit opens in a store: the agent's namespace, its strategy, and
 *  the subconscious's namespace, when the recipe enables it. */
interface Resident {
  namespace: string;
  strategy: () => ContextStrategy;
  subconscious?: { namespace: string; reAnchorFraction?: number };
}

/** What the audit opens in one data directory: each session's store, as a
 *  start of this release finds it, and whether the directory's index lists
 *  them; the agents' names each store is opened under; and the resident each
 *  name gives. */
interface Directory {
  stores: string[];
  names: string[];
  indexed: boolean;
  as: (name: string) => Resident;
}

/** One store's answer: refused, with why and the namespace whose open refused
 *  it when that isn't the agent's; not audited, with why; no store there; or
 *  none of these, which is that it opens. */
interface Outcome {
  refused?: string;
  namespace?: string;
  unaudited?: string;
  absent?: true;
}

export interface AuditOptions {
  /** Stores not to open: a host on trial's active store, which its start has
   *  open. */
  skip?: string[];
  /** On a trial, every place its fallback puts back or takes away: a store or
   *  a fleet child's directory under none of them isn't opened. Without it, a
   *  session's store is opened only inside its own data directory, which the
   *  copy of a hand update holds. */
  within?: string[];
  /** On a trial, the host's children file: each fleet child's audit is
   *  listed there while it runs (listAudit), so the launcher's fallback waits
   *  for it should the host end first. */
  listIn?: string;
  /** The recipe a start of the one data directory given would load, as its
   *  command names it. Without it, each directory's saved recipe, which a
   *  start given none resumes. */
  recipe?: string;
  /** The one data directory given is a fleet child's, audited by itself: its
   *  recipe's fleet entries, if any, aren't followed. */
  fleetChild?: true;
  /** On a trial, the extensions the host's start loaded, whose register()
   *  made the modules of its framework, alive while the audit runs: every
   *  directory given has its strategies built from them, so a trial gives its
   *  own directory alone, and the audit makes no register() call of its own.
   *  Without it, each directory's recipe loads its own. */
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
  // Each directory's recipe, read once, for its fleet entries and its own
  // audit, and the environment as it is, which a fleet child's starts from.
  const reads = new Map(await Promise.all(dataDirs.map(async (dataDir) =>
    [dataDir, await readRecipe(dataDir, options.recipe)] as const)));
  const env = { ...process.env };
  // A compression log the environment names belongs to a resident, so the
  // audit's opens stay out of it.
  const compressionLog = process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
  delete process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
  try {
    // Each fleet entry of a directory's recipe, but one naming that directory
    // itself. A directory given that another's entry names is that entry's
    // child, whatever its own recipe declares, so its own entries aren't
    // followed, as the fleet launches no child of a child; where directories
    // name each other, none is a parent, and each is audited as itself.
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
      // Pointing the data directory at another disk carries its stores only
      // where an update follows it: by hand, and on a trial where it is
      // itself a place, as the host's is. A fleet child's directory under a
      // place, pointed elsewhere, would be a link there, which the copy keeps
      // as a link.
      let pointable = !options.fleetChild || options.within === undefined;
      try {
        pointable ||= options.within!.some((place) => realOf(place) === realOf(dataDir));
      } catch { /* its real path, if it can't be had, is said below */ }
      let resident: Directory;
      try {
        resident = await residentOf(dataDir, reads.get(dataDir)!, options.extensions);
      } catch (error) {
        tell(`Couldn't audit ${dataDir}: ${oneLine(error)}`, true);
        continue;
      }
      // A store is the same as one to skip by its real path, or else as
      // written, should its real path not be had.
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
        const outside = reachesPast(store, options.within ?? [dataDir], options.within !== undefined, pointable);
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
            // Not there under any name: said once.
            const listed = resident.indexed ? 'the index lists its session, and ' : '';
            tell(`${store} (${here.namespace}): ${listed}no store is there; a start makes an empty one`);
            break;
          } else {
            tell(`${store} (${here.namespace}): opens`);
          }
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
        // Opened here, its stores would change where the fallback can't put
        // them back, and opened after the commit, a refusal would leave the
        // child down where only a Go back undoes it, and no copy holds them.
        tell(`Couldn't audit ${dataDir}, ${name}'s directory: it lies outside every place this trial's fallback puts ` +
          `back, where an update can't put back what ${there ? 'opening its stores changes' : 'its start makes there'}, ` +
          `so it wasn't audited. To update, ${there ? `move it under ${child.parent} and point its fleet entry ` +
          'there, or declare it' : `point its fleet entry under ${child.parent}, or make the directory and declare ` +
          'it'} by running setup again with --extra-state PATH for it and for each place already recorded, so each ` +
          'update copies it.', true);
      } else {
        await auditAsFleetChild(dataDir, child, env, tell, options.listIn, options.within);
      }
    }
  } finally {
    if (compressionLog !== undefined) process.env.CONTEXT_MANAGER_COMPRESSION_LOG = compressionLog;
  }
  return failed > 0 ? 1 : 0;
}

/** Whether `path` is one of `places` or lies under one, outside the
 *  launcher's own directory there, read through the links each one that
 *  exists holds. A link to nothing lies under none, since what it names is
 *  unknown. */
function inside(path: string, places: string[]): boolean {
  const at = realOf(path);
  if (at === null) return false;
  return places.some((place) => {
    const root = realOf(place);
    if (root === null) return false;
    const from = relative(root, at);
    if (from === '') return true;
    if (from === '..' || from.startsWith(`..${sep}`) || isAbsolute(from)) return false;
    // The launcher's copy leaves out its own directory at any depth.
    return !from.split(sep).includes(ITEM_UPDATE_DIR);
  });
}

/** Why a store that reaches past what an update copies wasn't opened, or
 *  undefined when it doesn't: one that is a link to nothing, that lies
 *  outside `places`, or that holds a link past them (escapeFrom), and one
 *  that can't be read, so it isn't opened uninspected. Each says how to go
 *  on. `onTrial` is whether `places` are a trial's, or else the store's data
 *  directory alone. */
function reachesPast(store: string, places: string[], onTrial: boolean, pointable: boolean): string | undefined {
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
          'the directory it lies in', pointable);
    }
    return escapeFrom(store, places, where, onTrial, pointable) ?? undefined;
  } catch (error) {
    return `it can't be read: ${oneLine(error)}, so it wasn't opened`;
  }
}

/** The ways on from a store that reaches past what an update copies: the
 *  `first`; the data directory itself pointed at the other disk, with what
 *  it `carries` moved into it and what named it there `repointed`, since an
 *  update follows a data directory that is a link and copies all of it, which
 *  only a data directory that is itself one of the places can be (`pointable`:
 *  in a fleet child's audit on a trial, its directory, when the trial took it
 *  as a place of its own); and, on an install's trial, the place `declared`
 *  with setup's --extra-state, which each update copies then. */
function goOn(onTrial: boolean, first: string, carries: string, repointed: string, declared: string,
  pointable: boolean): string {
  const ways = [first];
  if (pointable) ways.push(`point the data directory itself at the other disk, with ${carries} moved into it and ${repointed}`);
  if (onTrial) {
    ways.push(`declare ${declared} by running setup again with --extra-state PATH for it and for each place already ` +
      'recorded, so each update copies it');
  }
  return `To update, ${ways.length === 3 ? `${ways[0]}, ${ways[1]}, or ${ways[2]}` : ways.join(', or ')}.`;
}

/** What within the store at `store` an open could follow out of `places`,
 *  said with how to go on, or null: a link to what lies under none of them,
 *  or to nothing, since a copy keeps a link as a link, so what it names isn't
 *  put back. A
 *  link to a directory under a place is walked too, each directory once. A
 *  file with another name is the store's like any other: the fallback puts
 *  its content back at the store's path, though what an open changed in
 *  place stays at the other names. A store that isn't there, or whose path
 *  runs through a file, holds none here, its open says why; one whose
 *  entries can't be read throws, so it isn't opened uninspected. */
function escapeFrom(store: string, places: string[], where: string, onTrial: boolean, pointable: boolean): string | null {
  const walked = new Set<string>();
  const walk = (dir: string): string | null => {
    let real: string;
    try {
      real = realpathSync(dir);
    } catch (error) {
      // A store that isn't there, or whose path runs through a file, is its
      // open's to say.
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
              'the place the link reaches', pointable);
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

/** A path read through its links, as the contract reads the places
 *  (realOrResolved): its real path, or, when it isn't there, its nearest
 *  existing ancestor's with the rest as written; or null, when it is itself a
 *  link to nothing, since what it names is unknown. Any other error on its
 *  way, such as a loop of links or a target it may not read, is thrown. */
function realOf(p: string): string | null {
  let link = false;
  try {
    link = lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
  } catch { /* not a link it can tell of: read as the contract reads it, which throws all but a missing path */ }
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

/** Open the store at `path` as `resident`'s, in place, and close it. */
async function auditStore(path: string, resident: Resident): Promise<Outcome> {
  try {
    if (lstatSync(path, { throwIfNoEntry: false }) === undefined) return { absent: true };
  } catch (error) {
    return { unaudited: `it can't be reached: ${oneLine(error)}` };
  }
  endIfOrphaned();
  // Opened as agent-framework opens a session's store, which it then gives
  // each agent's ContextManager.
  let store: JsStore;
  try {
    store = JsStore.openOrCreate({ path });
  } catch (error) {
    return { refused: refusal(error) };
  }
  let outcome: Outcome = {};
  try {
    outcome = await auditNamespace(store, resident);
  } finally {
    try {
      store.close();
    } catch (error) {
      // A store that opened and can't be closed isn't audited; a refusal, or
      // a reason it wasn't audited, stands, with the close's failure added.
      const closing = `closing it failed: ${oneLine(error)}`;
      if (outcome.refused !== undefined) outcome = { ...outcome, refused: withClosing(outcome.refused, closing) };
      else if (outcome.unaudited !== undefined) outcome = { unaudited: withClosing(outcome.unaudited, closing) };
      else outcome = { unaudited: `it opened, and ${closing}` };
    }
  }
  return outcome;
}

/** A refusal, or why a store wasn't audited, with a closing failure after
 *  it: the line's own full stop, if it has one, goes, since the clause
 *  continues it. */
function withClosing(line: string, closing: string): string {
  return `${line.replace(/\.$/, '')}; ${closing}`;
}

/** Open the resident's namespaces in a store as a start does, and close them. */
async function auditNamespace(store: JsStore, resident: Resident): Promise<Outcome> {
  let strategy: ContextStrategy;
  try {
    strategy = resident.strategy();
  } catch (error) {
    return { unaudited: `its strategy couldn't be built for it: ${oneLine(error)}` };
  }
  // The agent's namespace, and the subconscious's while the agent's is open,
  // as a start opens them, each with a membrane of its own, so one open's
  // model call doesn't excuse another's refusal.
  const opens: Array<{ namespace: string; model: ReturnType<typeof noModel>; open: (membrane: Membrane) => Promise<ContextManager> }> = [{
    namespace: resident.namespace,
    model: noModel(),
    open: (membrane) => ContextManager.open({
      store, namespace: resident.namespace, strategy, membrane, viewFilter: residentView,
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
  // An error after an open's model call may be the missing model's own, so
  // that open is excused, and the next is still opened, since its refusal
  // would stand; a topology refusal is the store's, and stands.
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

/** A data directory's recipe as read: the one `source` names, as a start
 *  given that source loads it, or else the saved one, which is null when
 *  there is none; or why it can't be read. Its variables are taken from this
 *  environment, and its system prompt isn't fetched. */
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

/** A fleet entry of a recipe, as the fleet launches its child: its data
 *  directory as the fleet resolves it, its recipe (a recipe's load makes a
 *  relative one absolute), its env, and the time zone the fleet gives it. */
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

/** A fleet child an audit finds: the directory whose recipe names it, and its
 *  entry. */
interface FleetChild extends FleetEntry {
  parent: string;
}

/** The host's entry of this release, which a fleet child's audit runs in. */
const HOST_ENTRY = join(import.meta.dir, '..', 'index.ts');

/** Whether a line a fleet child's audit wrote says a store or a directory
 *  wasn't opened or audited, as auditStores writes one: a line that starts so,
 *  or a store's refusal. A store's other lines end as only they do, whatever
 *  its path holds. */
function failureLine(line: string): boolean {
  if (line.startsWith("Couldn't audit")) return true;
  if (line.endsWith('): opens') || line.endsWith('no store is there; a start makes an empty one')) return false;
  return line.includes('): refused: ');
}

/** List a fleet child's audit in the host's children file, beside what the
 *  file holds, as the fleet lists a child it launches: while its pid runs,
 *  the launcher's fallback waits for it, so an audit still opening a store
 *  when its host ends can't change what the fallback has put back. Nothing
 *  else writes the file while a trial audits: the fleet wrote it as the
 *  framework was created, and none of its children runs. Returns why it
 *  couldn't be listed, or null. A file that can't be read is left as it is,
 *  since replacing it would drop what the launcher checks. */
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

/** Take an audit's entry out of the children file once its process group
 *  has ended. One that stays, should this fail, names a group that has
 *  ended, which holds an update only if a process takes its pid again first:
 *  the launcher then says so, with how to remove the entry. */
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

/** Whether the process group `pid` led has no process left, waiting up to
 *  `ms` for it: a signal to it finds none. */
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

/** This boot's id, as the fleet records a child's (Linux's), or null where
 *  there's none to read. */
function bootId(): string | null {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** How long a fleet child's audit's stderr may stay open once the audit has
 *  exited and its group has been ended: a helper that left the group can hold
 *  it, and the audit's own lines are all written by its exit. */
const STDERR_GRACE_MS = 2_000;

/** How long a fleet child's audit may run, unless the host's environment
 *  gives other minutes (CHILD_AUDIT_MINUTES_ENV): one that hasn't ended by
 *  then, such as one whose extension waits at its import, would otherwise
 *  hold a trial's commit for good, so its group is ended and it isn't
 *  audited. A child whose stores need longer, opened under each agent name
 *  the audit opens them under, gets it from the setting, which the line for
 *  a child that hadn't finished names. */
const CHILD_AUDIT_LIMIT_MS = 5 * 60_000;
export const CHILD_AUDIT_MINUTES_ENV = 'CONNECTOME_FLEET_CHILD_AUDIT_MINUTES';

/** A fleet child's audit's limit: the minutes `env` gives, when they're a
 *  number above 0, up to what a timer holds (Infinity included), or else
 *  CHILD_AUDIT_LIMIT_MS. */
function childAuditLimitMs(env: NodeJS.ProcessEnv): number {
  const minutes = Number(env[CHILD_AUDIT_MINUTES_ENV]);
  return minutes > 0 ? Math.min(minutes * 60_000, 2 ** 31 - 1) : CHILD_AUDIT_LIMIT_MS;
}

/**
 * Audit a fleet child's directory in a process of its own, launched as the
 * fleet launches the child: under the recipe its entry names, in the
 * environment the fleet starts it with, from `env`, this audit's environment
 * as it began. Its lines are passed on, and its exit status says whether it
 * failed, each line that says so marked. The process leads a group of its
 * own, which is ended once it exits, and its stderr is read for a short while
 * after, so a helper an extension left holding it can't keep this audit
 * waiting. Its stdin is a pipe from this process, so it ends when this one
 * does, however this one ends.
 */
async function auditAsFleetChild(
  dataDir: string, child: FleetChild, env: NodeJS.ProcessEnv, tell: (line: string, failure?: boolean) => void,
  listIn?: string, within?: string[],
): Promise<void> {
  const listing = `${child.name}'s store audit`;
  // The pid an entry was written for, or may have been, should its write
  // fail after the file was replaced.
  let listed: number | undefined;
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
        // Its lines are on stderr; what its extensions print on stdout is for
        // no one, and would otherwise reach this host's own stdout, past a
        // headless host's log or into a terminal's UI.
        stdio: ['pipe', 'ignore', 'pipe'],
        detached: true,
      });
    } catch (thrown) {
      done({ stderr: '', status: null, signal: null, error: thrown });
      return;
    }
    // Listed before it begins, which it does only once told on its stdin, as
    // the fleet lists a child at its spawn; one that can't be listed is
    // ended, never told.
    // A write to one that has ended fails, which its exit says.
    audit.stdin!.on('error', () => {});
    if (audit.pid !== undefined) {
      if (listIn !== undefined) listed = audit.pid;
      const why = listIn === undefined ? null : listAudit(listIn, { name: listing, pid: audit.pid, bootId: bootId(), dataDir });
      if (why === null) {
        audit.stdin!.write('\n');
      } else {
        unlisted = why;
        try { process.kill(-audit.pid, 'SIGKILL'); } catch { /* it has ended */ }
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
      try { process.kill(-audit.pid!, 'SIGKILL'); } catch { /* it has ended */ }
      // One that can't end even so, such as one held in the kernel, doesn't
      // hold this audit: it stays listed while its group lives.
      setTimeout(() => settle({ stderr: Buffer.concat(chunks).toString(), status: null, signal: 'SIGKILL' }), STDERR_GRACE_MS).unref();
    }, limitMs);
    audit.on('error', (thrown) => settle({ stderr: Buffer.concat(chunks).toString(), status: null, signal: null, error: thrown }));
    audit.on('exit', (code, sig) => {
      clearTimeout(limit);
      exit = { status: code, signal: sig };
      // Whatever of its group still runs holds its stderr open.
      try { process.kill(-audit.pid!, 'SIGKILL'); } catch { /* the group has ended */ }
      setTimeout(() => {
        audit.stderr!.destroy();
        settle({ stderr: Buffer.concat(chunks).toString(), ...exit! });
      }, STDERR_GRACE_MS).unref();
    });
    audit.on('close', () => settle({ stderr: Buffer.concat(chunks).toString(), ...(exit ?? { status: null, signal: null }) }));
  });
  // Listed until its group has no process left, which the launcher's
  // fallback waits for; one that outlasts its SIGKILL stays listed.
  if (listed !== undefined) {
    // One whose listing failed may still be there, should the write have
    // failed once the file was replaced.
    if (await groupGone(listed, STDERR_GRACE_MS)) unlistAudit(listIn!, listing, listed, unlisted !== undefined);
    else {
      console.error(`[update] ${listing} (pid ${listed}) still has a process in its group after its SIGKILL, ` +
        (unlisted === undefined
          ? `so it stays listed in ${listIn} while that group has one. `
          : `and it couldn't be listed in ${listIn}, so an update reading it may not see it. `) +
        'Once sure that group is this audit\'s, whoever runs this host can end it, as a user allowed to signal it, ' +
        `with \`kill -KILL -- -${listed}\`; a process held in the kernel ends only once the kernel lets it go.`);
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
  // Its finished line is the last the audit writes; what follows it, such as
  // an extension's own output as the process exits, is the child's.
  let at = lines.length - 1;
  while (at >= 0 && !FINISHED_LINE.test(lines[at]!)) at--;
  const finished = at !== -1;
  const said = finished ? Number(FINISHED_LINE.exec(lines[at]!)![1]) : undefined;
  if (finished) lines.splice(at, 1);
  // Its status is its answer only once it has said it finished, and only the
  // status it said, 0, clean, or 1, which its lines explain: any other
  // ending cut it short or changed it, whatever it wrote before, such as an
  // extension's exit.
  const answered = !timedOut && finished && signal === null && status === said;
  const failed = !answered || status !== 0;
  let failures = 0;
  for (const line of lines) {
    const failure = failed && failureLine(line);
    if (failure) failures++;
    tell(line, failure);
  }
  // What shows where a child's audit stops: the parent's own audit by hand,
  // which audits the child as its fleet starts it and opens every child the
  // parent's recipe names, so after a copy of each of those.
  const byHand = `\`--audit-stores\` on ${child.parent}, after a copy of it and of each of its fleet children's ` +
    'directories, run as this host is started, with its recipe and its environment, audits this child as its fleet ' +
    'starts it';
  // A limit under a minute keeps two significant figures, so the line never
  // says 0 for a setting above it.
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

/** What a start of this release would open in `dataDir`, whose recipe `read`
 *  holds: with none, the default one, as a start takes it. Throws when the
 *  directory, its session index or its recipe can't be read, or the recipe's
 *  strategy can't be built. */
async function residentOf(dataDir: string, read: RecipeRead, loaded?: ExtensionRegistry): Promise<Directory> {
  // A data directory that isn't there, or isn't one, would otherwise read as
  // a fresh one with no store, which a start of any release opens.
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
  // An index as a start finds one: a link to nothing is none, as for
  // SessionManager.
  const indexed = existsSync(join(dataDir, 'sessions.json'));
  let index: ReturnType<SessionManager['load']>;
  try {
    index = sessions.load();
  } catch (error) {
    throw new Error(`its session index, sessions.json, can't be read: ${oneLine(error)}`);
  }
  // A start names the agent from the active session's import record, if the
  // recipe doesn't, and keeps that name through session switches, so a store
  // can be opened under the name any session gives, by a start with that
  // session active and a switch to the store's own: each store is opened
  // under each of them. A session with no import record gives the recipe's
  // name or the default, and one can always be made (`/session new`, or a
  // start with no active session, or one that moves a legacy store, from
  // before sessions, into a session), so that name is always among them. A
  // session's store is found by the id its entry holds, as a start finds the
  // active one's, and by the entry's key, which a switch takes.
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
  // Built once here, so a recipe whose strategy can't be built is a directory
  // not audited rather than every store refused. Each open takes a new one,
  // since a strategy holds its store's state.
  strategy();
  const { subconscious } = recipe;
  return {
    stores,
    names,
    indexed,
    as: (name) => ({
      namespace: `agents/${name}`,
      strategy,
      ...(subconscious?.enabled
        ? { subconscious: { namespace: `subconscious/${name}`, reAnchorFraction: subconscious.reAnchorFraction } }
        : {}),
    }),
  };
}

/** Whether an open's error is a store's topology refusal: context-manager's
 *  StoreTopologyError, from this host's copy of the library or from one a
 *  strategy's extension brought with it, whose class is its own. */
function topologyRefused(error: unknown): boolean {
  return error instanceof StoreTopologyError ||
    (error instanceof Error && error.message.startsWith('store topology rejected:'));
}

/** A refused open's line, the error on one line. context-manager's
 *  StoreTopologyError, from any copy of the library, ends with a remedy,
 *  "set topologyPolicy: 'report'",
 *  which the host's built-in strategies take from no recipe, so the line
 *  names §11.8 in its place. */
function refusal(error: unknown): string {
  const line = oneLine(error);
  if (!topologyRefused(error)) return line;
  const remedy = line.lastIndexOf(' Repair the store');
  return `${remedy >= 0 ? line.slice(0, remedy) : line} AGENT-ONBOARDING.md §11.8 says what a store with crossed summaries needs.`;
}

function oneLine(error: unknown): string {
  return flat(error instanceof Error ? error.message : String(error));
}

/** A line of the audit's, whatever its parts hold, on one line. */
function flat(text: string): string {
  return text.replace(/\s*[\r\n]\s*/g, ' ');
}
