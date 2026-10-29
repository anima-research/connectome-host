import { readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ContractError, INSTALL_ROOT_ENV, appendJournal, installPaths, installRootFromEnv, moveCurrent, readCurrent, syncDir,
} from './contract.js';
import { disarmTrialLog } from './trial-log.js';

export const HOST_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface ReleaseHere {
  root: string;
  release: string;
}

export function releaseHere(
  env: Record<string, string | undefined> = process.env,
  hostRoot: string = HOST_ROOT,
): ReleaseHere | null {
  const root = installRootFromEnv(env);
  if (root === null) return null;
  const { releases } = installPaths(root);
  const host = realpathSync(hostRoot);
  const unreadable = (what: string, error: unknown): ContractError => new ContractError(
    `${INSTALL_ROOT_ENV} names the install at ${root}, and ${what} can't be read, so this host can't tell which ` +
    `of its releases it is: ${error instanceof Error ? error.message : String(error)}`,
  );
  let entries: string[] = [];
  try {
    entries = readdirSync(releases);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw unreadable(`its releases directory ${releases}`, error);
  }
  const holding = entries.filter((entry) => {
    let path: string;
    try {
      path = realpathSync(join(releases, entry));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
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

export interface CommitCheck {
  /** The MCPL servers the framework is configured with and hasn't connected, closed tabs aside:
   *  agent-framework logs a server that fails to connect and goes on, and leaves a closed tab
   *  disconnected on purpose. */
  unconnectedServers?: () => readonly string[];
  now?: Date;
}

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
    // The move that made `current` name this release may be a start ago, whose
    // directory sync failed after the rename.
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
      `The MCPL server${unconnected.length === 1 ? '' : 's'} ${unconnected.join(', ')} ` +
      `${unconnected.length === 1 ? "wasn't" : "weren't"} connected when this release went to commit, so it starts none ` +
      `of its agents, and the next start goes back to ${from}: a release on trial commits only once every server it's ` +
      "configured with is connected, closed tabs aside. This start's log says why each one failed.",
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
