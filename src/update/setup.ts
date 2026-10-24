/**
 * Setup: the one step by hand that makes an npm install of connectome-host
 * update itself (contract.ts). Run it in the directory the service runs the
 * host in, with the release that brings the update mechanism installed, and
 * with DATA_DIR as the service gives the host (./data when it's unset):
 *
 *   DATA_DIR=... bun node_modules/@animalabs/connectome-host/src/update/setup.ts [--root DIR] [--extra-state PATH]...
 *
 * It copies the install's code into the install root as its first release,
 * points `current` at the release, records the data directory the install
 * serves and any state kept outside it, which each update copies with it, and writes the entry
 * point, in that order, so a record always has a `current`. It then checks
 * that the service restarts the host when it exits with 75, as a switch's
 * restart does, and with 1, as a trial that ends before its commit does.
 * Nothing it does touches a running host: the service starts through the
 * entry point once its unit runs it.
 *
 * Run again, it finishes whatever a run cut off left undone, and changes
 * nothing an earlier run finished: the release `current` names stays. With
 * --extra-state, it records the paths given in place of those recorded;
 * without, those recorded stay.
 */
import {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ContractError, ENTRY_POINT, RESTART_EXIT_CODE, installPaths, moveCurrent, readCurrent, readJournal, readRecord,
  realOrResolved, releaseDir, writeJsonAtomic,
  type InstallRecord, type JournalLine,
} from './contract.js';
import { copyTree, exists, makeDirs, removeTree, syncPath } from './data-swap.js';
import { HOST_ENTRY, LAUNCHER, isUnder } from './launcher.js';

export { ENTRY_POINT };

/** What setup copies of the install as a release. */
const RELEASE_FILES = ['package.json', 'package-lock.json', 'bun.lock', 'bun.lockb', 'node_modules'];

export function entryPointText(): string {
  return [
    '// The entry point of this connectome-host install, written by its setup. A',
    '// service starts the host here with the arguments it would give the host:',
    '// the launcher of the release this install\'s data last committed on decides what',
    '// runs, and then becomes the host of the release it decided on.',
    "import { realpathSync } from 'node:fs';",
    "import { dirname, join } from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    '',
    'const root = dirname(realpathSync(fileURLToPath(import.meta.url)));',
    `const launcher = join(root, 'current', ${LAUNCHER.split(sep).map((part) => `'${part}'`).join(', ')});`,
    'let launch;',
    'try {',
    '  ({ launch } = await import(launcher));',
    '} catch (error) {',
    "  console.error(`connectome-host: the launcher of the release this install runs doesn't load (${launcher}): ` +",
    "    `${error instanceof Error ? error.message : error}. If ${join(root, 'current')} isn't there, or isn't a link to a ` +",
    "    'release, run setup again in the directory the service runs the host in: it says how to put it right.');",
    '  process.exit(1);',
    '}',
    'await launch(root, process.argv.slice(2));',
    '',
  ].join('\n');
}

/** This package's own directory, and the install that holds it in its
 *  node_modules, or null for a package not installed there, such as a clone. */
export function installHolding(hostRoot: string): string | null {
  let dir = hostRoot;
  while (dirname(dir) !== dir) {
    if (basename(dir) === 'node_modules') return dirname(dir);
    dir = dirname(dir);
  }
  return null;
}

/** Each link in `install`'s node_modules that a release copied from it
 *  wouldn't hold the target of: one to an absolute path, or one that leads
 *  out of what setup copies. Each is named by its path in the install and
 *  the target as written. */
export function linksOutside(install: string): string[] {
  const modules = join(install, 'node_modules');
  // Each as written and as the filesystem resolves it.
  const roots = [modules, realOrResolved(modules)];
  const copied = RELEASE_FILES.flatMap((name) => [join(install, name), realOrResolved(join(install, name))]);
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        walk(path);
      } else if (stat.isSymbolicLink()) {
        const target = readlinkSync(path);
        // Where it leads through every link on the way, or for one that
        // leads nowhere, where it points.
        let at = resolve(dirname(path), target);
        try {
          at = realpathSync(path);
        } catch {
          // A dangling link: judged by where it points.
        }
        if (isAbsolute(target) || !(roots.some((top) => isUnder(at, top)) || copied.includes(at))) {
          found.push(`${relative(install, path)} links to ${target}`);
        }
      }
    }
  };
  if (existsSync(modules)) walk(modules);
  return found.sort();
}

/** A service unit run from the directory setup runs in, and whether systemd
 *  restarts the host it runs both when the host exits with RESTART_EXIT_CODE,
 *  as a switch's restart does, and when it exits with 1, as a trial that
 *  ends before its commit does, so its fallback runs. */
export interface ServiceUnit {
  id: string;
  /** The settings that decide it, as systemd shows them. */
  settings: string;
  restarts: boolean;
}

/** What setup learns of the service units: see systemdUnits. */
export interface ServiceUnits {
  found: ServiceUnit[];
  unasked: string[];
  unresolved: string[];
  /** Units that set no working directory, when setup's is their manager's
   *  default, where they run. */
  defaulted: string[];
}

/** The exit statuses an update needs the service to restart on: a switch's,
 *  and a failed trial's. */
const RESTART_ON = [String(RESTART_EXIT_CODE), '1'];

/** The home `file`, /etc/passwd, gives the user `name`, or null where it
 *  names none or can't be read, as for a user another source of accounts
 *  serves. */
export function passwdHome(name: string, file = '/etc/passwd'): string | null {
  try {
    const line = readFileSync(file, 'utf-8').split('\n').map((entry) => entry.split(':')).find((f) => f[0] === name);
    return line?.[5] || null;
  } catch {
    return null;
  }
}

/** What systemd's user and system managers say of their service units: those
 *  run from `cwd`, which manager couldn't be asked, and the units whose
 *  working directory this user can't resolve, such as one under /root or
 *  /var/lib/private, which may or may not be `cwd` reached another way. A
 *  unit that sets none runs in its manager's default, which `systemctl show`
 *  gives as the user's home marked `!` for the user manager, and as nothing
 *  for the system's, whose default is /. Most units in a home are others',
 *  so one there is `defaulted` rather than found when `cwd` is that default.
 *  One that sets ~ runs in its user's home: this user's for the user
 *  manager, and for the system's, its User='s, root's when it names none,
 *  as `homeOf` finds it. Only units systemd has loaded are seen. */
export function systemdUnits(cwd: string, run = (args: string[]) =>
  Bun.spawnSync(['systemctl', ...args], { stdout: 'pipe', stderr: 'pipe' }), home = homedir(),
homeOf = passwdHome): ServiceUnits {
  const found: ServiceUnit[] = [];
  const unasked: string[] = [];
  const unresolved: string[] = [];
  const defaulted: string[] = [];
  const here = realOrResolved(cwd);
  // The home as a path to compare, so one given with a trailing slash or
  // through a link still matches what systemctl shows.
  const realOrNull = (path: string) => {
    try {
      return realOrResolved(path);
    } catch {
      return null;
    }
  };
  const homeReal = realOrNull(home);
  for (const scope of [['--user'], []]) {
    const user = scope.length > 0;
    const unanswered = () => unasked.push(scope.length > 0 ? 'user' : 'system');
    let result: { exitCode: number | null; stdout: Uint8Array | Buffer };
    try {
      result = run([...scope, 'show',
        '--property=Id,WorkingDirectory,User,Restart,SuccessExitStatus,RestartPreventExitStatus,RestartForceExitStatus',
        '--', '*.service']) as never;
    } catch {
      unanswered();
      continue;
    }
    if (result.exitCode !== 0) {
      unanswered();
      continue;
    }
    for (const block of Buffer.from(result.stdout).toString('utf-8').split(/\n\s*\n/)) {
      const fields = new Map(block.split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
      if (!fields.has('Id')) continue;
      const shown = fields.get('WorkingDirectory') ?? '';
      const set = shown.replace(/^[-!+@:]+/, '');
      const id = fields.get('Id') ?? '?';
      if (set === '' || (user && shown.startsWith('!') && homeReal !== null && realOrNull(set) === homeReal)) {
        let runsIn: string;
        try {
          runsIn = realOrResolved(set === '' ? '/' : set);
        } catch {
          continue;
        }
        if (runsIn === here) defaulted.push(id);
        continue;
      }
      const tilde = set === '~' && !user ? homeOf(fields.get('User') || 'root') : home;
      if (tilde === null) {
        unresolved.push(id);
        continue;
      }
      let real: string;
      try {
        real = realOrResolved(set === '~' ? tilde : set);
      } catch {
        unresolved.push(id);
        continue;
      }
      if (real !== here) continue;
      const restart = fields.get('Restart') || 'no';
      const statusesOf = (key: string) => (fields.get(key) ?? '').split(/\s+/).filter(Boolean);
      // systemd's rules for an exit with `code`: a prevented status never
      // restarts, and a forced one restarts whatever Restart= says. A status
      // in both is read as prevented, the side on which a wrong answer costs
      // an edit rather than a stopped host.
      const restartsOn = (code: string) => {
        if (statusesOf('RestartPreventExitStatus').includes(code)) return false;
        if (statusesOf('RestartForceExitStatus').includes(code)) return true;
        const success = code === '0' || statusesOf('SuccessExitStatus').includes(code);
        return restart === 'always' || (restart === 'on-failure' && !success) || (restart === 'on-success' && success);
      };
      const listed = (key: string) => {
        const codes = RESTART_ON.filter((code) => statusesOf(key).includes(code));
        return codes.length > 0 ? [`${key} includes ${codes.join(' and ')}`] : [];
      };
      const settings = [`Restart=${restart}`, ...listed('SuccessExitStatus'), ...listed('RestartPreventExitStatus'),
        ...listed('RestartForceExitStatus')].join(', ');
      found.push({ id, settings, restarts: RESTART_ON.every(restartsOn) });
    }
  }
  return { found, unasked, unresolved, defaulted };
}

export interface SetupOptions {
  /** The directory the service runs the host in. */
  cwd: string;
  /** The data directory a host started there serves. */
  dataDir: string;
  root: string;
  /** State kept outside the data directory, which each update copies with it, or null to keep what
   *  an earlier run recorded. */
  extraState: string[] | null;
  /** This package's directory. */
  hostRoot: string;
  say(line: string): void;
  /** The service units run from a directory (systemdUnits). */
  units(cwd: string): ServiceUnits;
}

/** Whether `root` holds nothing, or nothing but what setup itself writes, as
 *  a run cut off before its install record leaves it. Setup makes its
 *  releases directory first, so a root without one holds nothing of setup's. */
function setupsOwn(root: string): boolean {
  if (!existsSync(root)) return true;
  const names = readdirSync(root);
  if (names.length === 0) return true;
  const own = new Set(['releases', 'install.json.tmp', 'current', 'current.tmp', ENTRY_POINT, `${ENTRY_POINT}.tmp`]);
  if (!names.includes('releases') || !names.every((name) => own.has(name))) return false;
  const releases = installPaths(root).releases;
  return readdirSync(releases).every((name) => name.endsWith('.tmp') || existsSync(join(releases, name, HOST_ENTRY)));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What to do about `error`, met looking at a path: what `permission` says
 *  for one a permission causes, which permissions mend; for any other, such
 *  as a file where a directory should be or a loop of links, the path itself
 *  is what's wrong. */
function lookAdvice(error: unknown, permission: string): string {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EACCES' || code === 'EPERM' ? `${permission}, and run setup again.`
    : 'Repair what that path runs through, and run setup again.';
}

/** `path` as a shell reads it, quoted when it holds anything but plain characters. */
function shellWord(path: string): string {
  return /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replace(/'/g, "'\\''")}'`;
}

/** Set an install up, or finish a setup a run cut off, or record its extra
 *  state again. */
export function setup(options: SetupOptions): void {
  const { say } = options;
  const root = resolve(options.root);
  const paths = installPaths(root);
  if (!existsSync(options.dataDir)) {
    throw new ContractError(`The data directory ${options.dataDir} isn't there. Run setup in the directory the service runs the ` +
      'host in, with the DATA_DIR it gives the host, after the host has run there once.');
  }
  if (!statSync(options.dataDir).isDirectory()) {
    throw new ContractError(`The data directory ${options.dataDir} isn't a directory. Run setup with the DATA_DIR the service ` +
      'gives the host.');
  }
  const dataDir = realpathSync(options.dataDir);
  const given = options.extraState?.map((path) => {
    try {
      statSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ContractError(`The extra state ${path} isn't there.`);
      throw new ContractError(`The extra state ${path} can't be looked at: ${errorText(error)}. ` +
        lookAdvice(error, 'Give this user search on each directory on the way to it'));
    }
    const real = realpathSync(path);
    const stat = lstatSync(real);
    if (!stat.isFile() && !stat.isDirectory()) {
      throw new ContractError(`The extra state ${path} is neither a file nor a directory, so a copy can't hold it.`);
    }
    return real;
  }) ?? null;
  const rootReal = realOrResolved(root);
  for (const item of [dataDir, ...(given ?? [])]) {
    if (isUnder(rootReal, item) || isUnder(item, rootReal)) {
      throw new ContractError(`The install root ${rootReal} and ${item} are one inside the other, so a copy of the data ` +
        'would hold the copy itself. Choose a root apart from the data with --root.');
    }
  }

  const writeAgain = `Write it again as {"v": 1, "dataDir": ${JSON.stringify(dataDir)}, "extraState": []}, listing in ` +
    'extraState the paths it listed, where they can still be read, and any other state kept outside the data ' +
    'directory, and run setup again.';
  let existing: InstallRecord | null;
  try {
    existing = readRecord<InstallRecord>(paths.install, 'install record');
  } catch (error) {
    if (!(error instanceof ContractError)) {
      throw new ContractError(`The install record at ${paths.install} can't be read: ${errorText(error)}. Make it a ` +
        'file this user can read, and run setup again.');
    }
    // One of another version is a release's that reads it; this one doesn't.
    let version: unknown;
    try {
      version = (JSON.parse(readFileSync(paths.install, 'utf-8')) as { v?: unknown } | null)?.v;
    } catch {
      // Its content can't be read: the advice below is for it.
    }
    if (version !== undefined && version !== 1) throw error;
    throw new ContractError(`${error.message.replace(/\.+$/, '')}. ${writeAgain}`);
  }
  if (existing !== null && typeof existing.dataDir !== 'string') {
    throw new ContractError(`The install record at ${paths.install} names no data directory this release can read. ${writeAgain}`);
  }
  // Setup makes its releases directory first and the entry point after the
  // record, and writes no journal line, which only the launcher, started by
  // the entry point, writes. So in a root of setup's, either there with no
  // record is an install that ran: its record is gone.
  if (existing === null && existsSync(paths.releases) &&
    (existsSync(paths.journal) || existsSync(join(root, ENTRY_POINT)))) {
    throw new ContractError(`The install at ${root} has ${existsSync(paths.journal) ? 'a journal' : 'its entry point'} ` +
      `and no record at ${paths.install}, so its record is gone, and with it the extra state it listed. ${writeAgain}`);
  }
  const link = `\`ln -sfn ${shellWord(join('releases', '<that release>'))} ${shellWord(paths.current)}\``;
  const current = (): string | null => {
    try {
      const name = readCurrent(root);
      if (name !== null) releaseDir(root, name);
      return name;
    } catch (error) {
      // readlink's EINVAL: it's there, and not a link. A ContractError: a link
      // whose last part isn't a release's name. Anything else is its own.
      const isLink = error instanceof ContractError;
      if (!isLink && (error as NodeJS.ErrnoException).code !== 'EINVAL') {
        throw new ContractError(`${paths.current} can't be looked at: ${errorText(error)}. ` +
          lookAdvice(error, `Give this user search on each directory on the way to ${root}`));
      }
      throw new ContractError(`${paths.current} ${isLink ? `is a link to ${readlinkSync(paths.current)}, which names no ` +
        'release' : 'is there and isn\'t a link'}, so it can't say which release this install runs. ` +
        (isLink ? `Point it at the release the data last committed on with ${link}`
          : `Move it aside, and point current at the release the data last committed on with \`ln -s ` +
            `${shellWord(join('releases', '<that release>'))} ${shellWord(paths.current)}\``) + ', and run setup again.');
    }
  };
  if (existing !== null && realOrResolved(existing.dataDir) !== dataDir) {
    throw new ContractError(`The install at ${root} serves ${existing.dataDir}, not ${dataDir}. Each service needs an ` +
      'install of its own: give this one another --root.');
  }
  const recorded = existing?.extraState;
  if (existing !== null && given === null &&
    !(Array.isArray(recorded) && recorded.every((path) => typeof path === 'string'))) {
    throw new ContractError(`The install record at ${paths.install} has no list of extra state this release can read. ` +
      'Run setup again with --extra-state PATH for each place of state kept outside the data directory, such as an MCPL ' +
      'server\'s, or, with none, set extraState to [] in the record.');
  }
  if (existing !== null && current() === null) {
    const lines = readJournal(root);
    // Each line names the release current named when it was written: a
    // commit's or a fallback's `to`, any other's `from`. The last line's is
    // the latest known.
    const last = lines.at(-1);
    const committed = last === undefined ? null
      : (last.step === 'commit' && last.outcome === 'ok') || last.step === 'fallback' ? last.to : last.from;
    // A trial after the last commit line may have committed with no line of
    // its own, since a commit moves current first, while every line after it
    // was written with current naming its release. Its own fallback rules it
    // out: a fallback runs only while current names another release, which
    // its line's `to` names, and after one that failed, nothing starts.
    let at = -1;
    lines.forEach((line, i) => { if (line.step === 'commit' && line.outcome === 'ok') at = i; });
    const before = (line: JournalLine) => line.step === 'fallback' ? line.to : line.from;
    const trials = lines.slice(at + 1).filter((line, i, after) => line.step === 'trial-start' && line.outcome === 'ok' &&
      after.slice(i + 1).every((l) => before(l) === line.to));
    const maybe = [...new Set(trials.map((line) => line.to))].filter((release) => release !== committed);
    let named: string;
    if (committed !== null) {
      named = `${committed}, which the journal's last line leaves it naming`;
    } else {
      // With no line, no update has run: what releases/ holds is setup's
      // release, unless it's gone, and any the host installed for a request
      // still to come.
      let releases: string[];
      try {
        releases = readdirSync(paths.releases).filter((name) => !name.endsWith('.tmp')).sort();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new ContractError(`The install at ${root} has its record and no ${paths.current}, and the journal has ` +
            `no line, so it's the release setup installed; ${paths.releases} can't be listed to say which: ` +
            `${errorText(error)}. ${lookAdvice(error, 'Make it readable to this user')}`);
        }
        releases = [];
      }
      if (releases.length === 0) {
        throw new ContractError(`The install at ${root} has its record and no ${paths.current}, and the journal has no ` +
          `line, so it's the release setup installed, and ${paths.releases} holds no release. Put that release back in ` +
          `${paths.releases} from a backup, point current at it with \`ln -s ` +
          `${shellWord(join('releases', '<that release>'))} ${shellWord(paths.current)}\`, and run setup again.`);
      }
      named = `the release setup installed, since the journal has no line, which unless it's gone is ` +
        `${releases.length === 1 ? releases[0] : `one of ${releases.join(', ')}`}, in ${paths.releases}`;
    }
    throw new ContractError(`The install at ${root} has its record and no ${paths.current}, which names the release its ` +
      'data last committed on. Setup and updates replace current and never remove it, so it was removed some other ' +
      `way. By the journal, that release is ${named}` +
      (maybe.length > 0 ? `, or ${maybe.join(' or ')} if its trial committed: a commit moves current before it writes ` +
        'its line, and no line after that trial says how it ended' : '') +
      `. Point current at it with \`ln -s ${shellWord(join('releases', '<that release>'))} ` +
      `${shellWord(paths.current)}\`, and run setup again.`);
  }
  if (existing === null && !setupsOwn(root)) {
    throw new ContractError(`${root} isn't empty, and holds no install record, so it isn't an install setup made. ` +
      'Choose another --root.');
  }
  const extraState = given ?? recorded ?? [];

  // A module's own path is its real one, so a host reached through a link
  // reads as wherever the link leads: the directory's own node_modules says
  // whether it's this install's.
  const here = join(options.cwd, 'node_modules', '@animalabs', 'connectome-host');
  if (exists(here)) {
    let real: string;
    try {
      real = realpathSync(here);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new ContractError(`${here} can't be followed to the host it names: ${errorText(error)}.`);
      }
      throw new ContractError(`${here} is a link to something that isn't there. Install connectome-host in this ` +
        'directory again, and run setup again.');
    }
    if (!isUnder(real, join(realpathSync(options.cwd), 'node_modules'))) {
      throw new ContractError(`${here} leads to ${real}, outside this install's own node_modules (a node_modules that is ` +
        'itself a link counts), so a release copied from it wouldn\'t hold that code. Make node_modules a directory of ' +
        'this install, with connectome-host installed from the registry or a packed tarball, and run setup again, or ' +
        'keep updating this install as you do now (docs/DEPLOYMENTS.md).');
    }
  }
  const install = installHolding(realpathSync(options.hostRoot));
  if (install === null) {
    throw new ContractError(`This connectome-host (${options.hostRoot}) isn't installed in a node_modules. Setup makes an npm ` +
      'install update itself; a clone keeps the hand procedure in docs/DEPLOYMENTS.md.');
  }
  const inside = RELEASE_FILES.map((name) => join(install, name)).find((path) => isUnder(rootReal, realOrResolved(path)));
  if (inside !== undefined) {
    throw new ContractError(`The install root ${rootReal} is inside ${inside}, which setup copies as the release, so the copy ` +
      'would hold itself. Choose a root outside it with --root.');
  }
  const outside = linksOutside(install);
  if (outside.length > 0) {
    throw new ContractError(`${outside.join('; ')}: outside this install, so a release copied from it wouldn't hold that ` +
      'code. Install each from the registry or a packed tarball and run setup again, or keep updating this install as ' +
      'you do now (docs/DEPLOYMENTS.md).');
  }
  const version = (JSON.parse(readFileSync(join(options.hostRoot, 'package.json'), 'utf-8')) as { version: string }).version;
  const release = releaseDir(root, version);
  // A first run, or one finishing a run cut off before its record: the
  // release, then current, then the record, so a record always has a current.
  const settingUp = existing === null;
  if (settingUp && current() === null) {
    if (!existsSync(release)) {
      const tmp = `${release}.tmp`;
      makeDirs(paths.releases);
      removeTree(tmp);
      mkdirSync(tmp);
      for (const name of RELEASE_FILES) {
        if (existsSync(join(install, name))) copyTree(join(install, name), join(tmp, name));
      }
      if (!existsSync(join(tmp, HOST_ENTRY))) {
        removeTree(tmp);
        throw new ContractError(`The copy of ${install} as ${version} has no host at ${HOST_ENTRY}.`);
      }
      syncPath(tmp);
      renameSync(tmp, release);
    }
    // Also when an earlier run renamed it: its sync may not have happened.
    syncPath(paths.releases);
    moveCurrent(root, version);
  } else if (settingUp) {
    // current is there from a run cut off before its record: its rename's
    // sync may not have happened, and the record must not outlive it.
    syncPath(root);
  }
  // The entry point loads the launcher through current, and the launcher
  // starts the host of releases/<the release current names>: a current that
  // leads anywhere else, or a release with no host, would start nothing, or
  // the wrong thing.
  const running = current();
  if (running !== null) {
    const release = releaseDir(root, running);
    // Followed through any link, as the launcher's start does: a link to
    // nothing is no host.
    let host = true;
    try {
      statSync(join(release, HOST_ENTRY));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new ContractError(`${paths.current} names ${running}, and its host at ${join(release, HOST_ENTRY)} can't ` +
          `be looked at: ${errorText(error)}. ${lookAdvice(error, 'Give this user search on each directory on the way')}`);
      }
      host = false;
    }
    if (!host) {
      throw new ContractError(`${paths.current} names ${running}, and there's no host at ${join(release, HOST_ENTRY)}, ` +
        `so the entry point would start nothing. Put ${release} back as it was, or point current at the release the ` +
        `data last committed on with \`ln -sfn ${shellWord(join('releases', '<that release>'))} ` +
        `${shellWord(paths.current)}\`, and run setup again.`);
    }
    let leads: string | null = null;
    try {
      leads = realpathSync(paths.current);
    } catch (error) {
      // A link to nothing leads nowhere; any other error is its own.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') {
        throw new ContractError(`${paths.current} can't be followed: ${errorText(error)}. Give this user search on ` +
          'each directory on the way to where it leads, and run setup again.');
      }
      if (code !== 'ENOENT') {
        throw new ContractError(`${paths.current} can't be followed: ${errorText(error)}. Point it at the release the ` +
          `data last committed on with ${link}, and run setup again.`);
      }
    }
    if (leads !== realpathSync(release)) {
      throw new ContractError(`${paths.current} names ${running} but leads to ${readlinkSync(paths.current)}, not ` +
        `${release}, where the launcher starts ${running} from. Point it there with \`ln -sfn ` +
        `${shellWord(join('releases', running))} ${shellWord(paths.current)}\`, and run setup again.`);
    }
  }
  writeJsonAtomic(paths.install, { v: 1, dataDir: existing?.dataDir ?? dataDir, extraState } satisfies InstallRecord);
  const entry = join(root, ENTRY_POINT);
  writeFileSync(`${entry}.tmp`, entryPointText());
  syncPath(`${entry}.tmp`);
  renameSync(`${entry}.tmp`, entry);
  syncPath(root);

  if (settingUp) {
    say(`Set up ${root} as the install of ${readCurrent(root)} that serves ${dataDir}.`);
  } else {
    say(`The install at ${root} serves ${existing?.dataDir ?? dataDir} and runs ${readCurrent(root)}, as before.`);
  }
  say(`State kept outside the data directory, which each update copies with it: ${extraState.join(', ') || 'none recorded ' +
    '(pass --extra-state PATH for each place of it, such as an MCPL server\'s state, and for those already recorded too, ' +
    'since a run given any records only those)'}.`);
  say(`The service starts the host with \`${shellWord(process.execPath)} ${shellWord(entry)}\`, followed by the arguments ` +
    `it gives the host${settingUp ? ' now; set that, and restart it' : ''}.`);
  const units = options.units(options.cwd);
  const needed = `The service must restart the host when it exits with ${RESTART_EXIT_CODE}, as a switch's restart does, ` +
    'and with 1, as a trial that ends before its commit does, so its fallback runs: under systemd, each of the two ' +
    'restarted, by Restart=always, by Restart=on-failure while it isn\'t in SuccessExitStatus=, or by ' +
    'RestartForceExitStatus=, and neither in RestartPreventExitStatus=; or launchd\'s KeepAlive.';
  const one = units.unresolved.length === 1;
  const unresolvedNote = units.unresolved.length === 0 ? '' : ` Setup couldn't resolve the working directory of ` +
    `${units.unresolved.join(', ')} (one under a directory this user can't search, or a system unit's ~ whose User= ` +
    `/etc/passwd doesn't name), so it can't tell whether ${one ? 'it runs' : 'they run'} from this directory, and doesn't ` +
    `check ${one ? 'it' : 'them'}. If ${one ? 'it runs' : 'one of them runs'} the host, check its restart settings by ` +
    'hand, or run setup as a user who can reach its working directory.';
  const few = units.defaulted.length === 1;
  const defaultedNote = units.defaulted.length === 0 ? '' : ` ${units.defaulted.join(', ')} ${few ? 'sets' : 'set'} no ` +
    `working directory, so ${few ? 'it runs' : 'they run'} in ${few ? 'its' : 'their'} systemd manager's default, which ` +
    `is this directory. Most units that do are no host's, so setup doesn't check ${few ? 'it' : 'them'}. If ` +
    `${few ? 'it runs' : 'one of them runs'} the host, give the service WorkingDirectory=${options.cwd.replace(/%/g, '%%')} ` +
    'and run setup again, or check its restart settings by hand.';
  const notes = unresolvedNote + defaultedNote;
  const managers = units.unasked.map((scope) => `systemd's ${scope} manager`).join(' or ');
  if (units.found.length === 0) {
    say(units.unasked.length > 0
      ? `${needed} Setup couldn't ask ${managers} which service runs from this directory, so it couldn't check that.` +
        notes
      : `${needed} No loaded systemd service ${units.unresolved.length > 0 ? 'whose working directory setup could ' +
        'resolve' : 'that this user can see'} is set to run from this directory, so setup couldn't check that.${notes}`);
  } else if (units.unasked.length > 0) {
    say(`Setup couldn't ask ${managers}, so a service of its that runs from this directory isn't checked.` +
      `${notes} ${needed}`);
  } else if (notes !== '') {
    say(`${notes.trim()} ${needed}`);
  }
  for (const unit of units.found) {
    say(unit.restarts
      ? `${unit.id} restarts the host when it exits with ${RESTART_EXIT_CODE} or 1 (${unit.settings}).`
      : `${unit.id} won't restart the host on both ${RESTART_EXIT_CODE} and 1 (${unit.settings}), so a switch's ` +
        'restart, or a failed trial\'s fallback, would leave the host stopped. Before you update, have each of the two ' +
        'restarted, by Restart=always, by Restart=on-failure while it isn\'t in SuccessExitStatus=, or by ' +
        'RestartForceExitStatus=, and neither in RestartPreventExitStatus=.');
  }
}

export function parseArgs(argv: string[]): { root?: string; extraState: string[] | null } {
  const out: { root?: string; extraState: string[] | null } = { extraState: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg !== '--root' && arg !== '--extra-state') {
      throw new ContractError(`Setup takes --root DIR and --extra-state PATH, not ${JSON.stringify(arg)}.`);
    }
    const value = argv[++i];
    if (value === undefined) {
      throw new ContractError(`Setup's ${arg} takes ${arg === '--root' ? 'a directory' : 'a path'}, and none followed it.`);
    }
    if (arg === '--root') out.root = value;
    else (out.extraState ??= []).push(resolve(value));
  }
  return out;
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    setup({
      cwd: process.cwd(),
      dataDir: resolve(process.env.DATA_DIR || './data'),
      root: args.root ?? join(process.cwd(), 'connectome-host'),
      extraState: args.extraState,
      hostRoot: resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'),
      say: (line) => console.log(line),
      units: (cwd) => systemdUnits(cwd),
    });
  } catch (error) {
    console.error(`connectome-host setup: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
