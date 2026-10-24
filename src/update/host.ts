/**
 * The host's side of the update contract (contract.ts): which install a host
 * was started in and which of its releases it runs from, and the commit that
 * records that release as the one the install's data runs on.
 */
import { readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ContractError, INSTALL_ROOT_ENV, appendJournal, installPaths, installRootFromEnv, moveCurrent, readCurrent, syncDir,
} from './contract.js';
import { disarmTrialLog } from './trial-log.js';

/** This host's package root: the directory its src/ is in. */
export const HOST_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** An install a host was started in through its entry point, and the release it runs from. */
export interface ReleaseHere {
  /** The install's root. */
  root: string;
  /** The entry of the install's `releases/` that holds this host's code: the name `current` and the journal use. */
  release: string;
}

/**
 * The install this host was started in and the release it runs from, or null
 * when no entry point started it (CONNECTOME_INSTALL_ROOT unset), in which
 * case it writes none of the contract's files.
 *
 * The release is the entry of the install's `releases/` whose real path holds
 * this host's code, so it names what is running, whether the entry point
 * started it through `current` or the release is itself a link. Only an entry
 * point sets the variable, so a root that doesn't hold this host exactly once
 * is refused: committing a release other than the one running would tell the
 * launcher about a switch that didn't happen.
 */
export function releaseHere(
  env: Record<string, string | undefined> = process.env,
  hostRoot: string = HOST_ROOT,
): ReleaseHere | null {
  const root = installRootFromEnv(env);
  if (root === null) return null;
  const { releases } = installPaths(root);
  const host = realpathSync(hostRoot);
  // Only what isn't there holds nothing: a releases directory or an entry
  // that can't be read might hold this host, so the refusal names the error.
  const unreadable = (what: string, error: unknown): ContractError => new ContractError(
    `${INSTALL_ROOT_ENV} names the install at ${root}, and ${what} can't be read, so this host can't tell which ` +
    `of its releases it is: ${error instanceof Error ? error.message : String(error)}`,
  );
  let entries: string[] = [];
  try {
    entries = readdirSync(releases);
  } catch (error) {
    // No releases directory holds nothing; refused below.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw unreadable(`its releases directory ${releases}`, error);
  }
  const holding = entries.filter((entry) => {
    let path: string;
    try {
      path = realpathSync(join(releases, entry));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; // a link to nothing holds nothing
      throw unreadable(`the entry ${entry} of ${releases}`, error);
    }
    return host === path || host.startsWith(path + sep);
  }).sort();
  if (holding.length === 1) return { root, release: holding[0]! };
  throw new ContractError(holding.length === 0
    ? `${INSTALL_ROOT_ENV} names the install at ${root}, but none of its releases holds this host (${host}). ` +
      `Only an install's entry point sets ${INSTALL_ROOT_ENV}: to run this host on its own, start it without that variable.`
    : `${INSTALL_ROOT_ENV} names the install at ${root}, and ${holding.length} of its releases hold this host ` +
      `(${holding.join(', ')}), so it can't tell which release it is. Each entry of ${releases} should be a release of its own.`);
}

/** What the commit checks of a start before it moves `current`. */
export interface CommitCheck {
  /** The MCPL servers the framework is configured with and hasn't connected:
   *  agent-framework logs a server that fails to connect and goes on. */
  unconnectedServers?: () => readonly string[];
  now?: Date;
}

/** The release `current` names, or null when there's none, as a start reads
 *  it: a `current` that can't be read ends the start, saying so. */
export function currentForStart(root: string): string | null {
  try {
    return readCurrent(root);
  } catch (error) {
    throw new Error(
      `This host couldn't read which release the install at ${root} runs on, so none of its agents started: ` +
      `${error instanceof Error ? error.message : String(error)}. Each start reads \`current\` again before any ` +
      'agent starts.',
    );
  }
}

/**
 * The commit: record this host's release as the one the install's data runs
 * on. startFramework calls it once the framework has opened its stores and
 * tried its servers, and before any agent starts, so a release that fails
 * before it leaves `current` as it was. Returns `{ from }`, the release
 * `current` named before, or undefined when nothing moved.
 *
 * - **A start on trial,** when `current` names another release, commits only
 *   once every server it's configured with has connected, as a switch's
 *   trial promises: a server that hasn't is a failure before the commit,
 *   which the next start falls back from.
 * - **When `current` already names this release,** as on every start but the
 *   first of a switch or a Go back, nothing is written. The move that made it
 *   so may be a start ago, whose directory sync failed after the rename, so
 *   the root is synced again before any agent acts.
 * - **An install with no `current`** has nothing to say which release its data
 *   runs on. Setup makes the link before any start, and the launcher refuses
 *   to start without it, so this refuses too.
 *
 * Moving `current` is the commit. The journal's `commit` line after it only
 * records it, since `current` is what decides (unfinishedTrial), so a line
 * that can't be written is logged and the start goes on: stopping now would
 * gain nothing, as the next start would find the same release committed.
 */
export function commitRelease(here: ReleaseHere, check: CommitCheck = {}): { from: string } | undefined {
  const { root, release } = here;
  const said = (error: unknown): string => error instanceof Error ? error.message : String(error);
  const from = currentForStart(root);
  if (from === null) {
    throw new Error(
      `The install at ${root} has no \`current\` to say which release it runs on, so this host starts none of its ` +
      'agents. Run setup again.',
    );
  }
  if (from === release) {
    try {
      syncDir(root);
    } catch (error) {
      throw new Error(
        `This host couldn't sync \`current\`, which names ${release}, to disk at ${root}, so none of its agents ` +
        `started and it exits: ${said(error)}. Its next start, which its service makes, syncs again.`,
      );
    }
    return undefined;
  }
  const unconnected = check.unconnectedServers?.() ?? [];
  if (unconnected.length > 0) {
    throw new Error(
      `This release couldn't connect the MCPL server${unconnected.length === 1 ? '' : 's'} ` +
      `${unconnected.join(', ')}, so it starts none of its agents, and the next start goes back to ${from}: a ` +
      "release on trial commits only once every server it's configured with has connected. This start's log " +
      'says why each one failed.',
    );
  }
  try {
    moveCurrent(root, release);
  } catch (error) {
    // The move renames the new link into place and then syncs the root, so a
    // failure in the sync leaves `current` naming the release unsynced, and
    // only a read of `current` now tells which happened.
    let named: string | null;
    try {
      named = readCurrent(root);
    } catch (reread) {
      throw new Error(
        `This host couldn't record ${release} as the release the install at ${root} runs on, so none of its ` +
        `agents started: ${said(error)}. It couldn't read \`current\` afterwards either, so it can't tell ` +
        `whether \`current\` names ${release} or ${from} now: ${said(reread)}`,
      );
    }
    throw new Error(named === release
      ? `This host moved \`current\` to ${release} at ${root} but couldn't sync the move to disk, so none of its ` +
        `agents started and it exits: ${said(error)}. Its next start runs ${release}, and syncs the root again ` +
        'before any agent starts. A disk that failed a sync may not have kept the move: check the disk, and ' +
        'which release `current` names once the install has started again.'
      : `This host couldn't record ${release} as the release the install at ${root} runs on, so none of its ` +
        `agents started, and the next start goes back to ${from}: ${said(error)}`);
  }
  // Committed: what this release writes from here isn't a trial's to keep.
  disarmTrialLog();
  const at = (check.now ?? new Date()).toISOString();
  try {
    appendJournal(root, { at, step: 'commit', from, to: release, outcome: 'ok' });
  } catch (error) {
    console.error(
      `[update] ${release} is now the release the install at ${root} runs on, but its journal doesn't ` +
      `say so: adding the commit failed (${said(error)}). \`current\` is what records the commit, so the ` +
      'switch stands without it.',
    );
  }
  return { from };
}
