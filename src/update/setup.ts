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
 * serves and any state kept outside it, which each update copies with it,
 * and writes the entry point and, beside it, the install's own command,
 * `connectome`. It then checks that each systemd service it finds running
 * from this directory restarts the host when it exits with 75, as a
 * switch's restart does, and with 1, as a trial that ends before its commit
 * does, and where it finds none, or can't ask systemd, it says what the
 * service needs. Nothing it does touches a running host: the
 * service starts through the entry point once its unit runs it.
 *
 * Run again, it finishes whatever a run cut off left undone, and changes
 * nothing an earlier run finished: the release `current` names stays. With
 * --extra-state, it records the paths given in place of those recorded;
 * without, those recorded stay.
 */
import {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ContractError, ENTRY_POINT, EXTRA_STATE_LINE, LIST_A_PLACE, RESTART_EXIT_CODE, WRITE_RECORD_AGAIN, installPaths, moveCurrent,
  copyShows, readCurrent, readJournal,
  readRecord, realOrResolved, releaseDir, writeJsonAtomic, writeTextAtomic,
  type InstallRecord, type JournalLine,
} from './contract.js';
import { copyTree, exists, makeDirs, removeTree, syncPath } from './data-swap.js';
import { PACKAGE } from './install.js';
import { HOST_ENTRY, LAUNCHER, isUnder } from './launcher.js';
import { INSTALL_COMMAND, writeInstallCommand } from '../cli/install-command.js';

export { ENTRY_POINT };

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

function setupCommand(install: string, dataDir: string, root: string): string {
  return `cd ${shellWord(install)} && DATA_DIR=${shellWord(dataDir)} bun --no-env-file ` +
    `${join('node_modules', PACKAGE, 'src', 'update', 'setup.ts')} --root ${shellWord(root)}`;
}

export function installHolding(hostRoot: string): string | null {
  let dir = hostRoot;
  while (dirname(dir) !== dir) {
    if (basename(dir) === 'node_modules') return dirname(dir);
    dir = dirname(dir);
  }
  return null;
}

function notInstalled(hostRoot: string): string {
  return `This connectome-host (${hostRoot}) isn't installed in a node_modules. Setup makes an npm install update ` +
    'itself; a clone keeps the hand procedure in docs/DEPLOYMENTS.md.';
}

export function linksOutside(install: string): string[] {
  const modules = join(install, 'node_modules');
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
        let at = resolve(dirname(path), target);
        try {
          at = realpathSync(path);
        } catch {
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

export interface ServiceUnit {
  id: string;
  settings: string;
  restarts: boolean;
}

export interface ServiceUnits {
  found: ServiceUnit[];
  unasked: string[];
  unresolved: string[];
  defaulted: string[];
}

const RESTART_ON = [String(RESTART_EXIT_CODE), '1'];

export function passwdHome(name: string, file = '/etc/passwd'): string | null {
  try {
    const line = readFileSync(file, 'utf-8').split('\n').map((entry) => entry.split(':')).find((f) => f[0] === name);
    return line?.[5] || null;
  } catch {
    return null;
  }
}

/** A systemd unit that sets no working directory runs in its manager's
 *  default, which `systemctl show` gives as the user's home marked `!` for
 *  the user manager, and as nothing for the system's, whose default is /.
 *  One that sets ~ runs in its user's home: this user's for the user
 *  manager, and for the system's, its User='s, root's when it names none.
 *  Only units systemd has loaded are seen. */
export function systemdUnits(cwd: string, run = (args: string[]) =>
  Bun.spawnSync(['systemctl', ...args], { stdout: 'pipe', stderr: 'pipe' }), home = homedir(),
homeOf = passwdHome): ServiceUnits {
  const found: ServiceUnit[] = [];
  const unasked: string[] = [];
  const unresolved: string[] = [];
  const defaulted: string[] = [];
  const here = realOrResolved(cwd);
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
      // restarts, and a forced one restarts whatever Restart= says.
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
  cwd: string;
  dataDir: string;
  root: string;
  extraState: string[] | null;
  hostRoot: string;
  say(line: string): void;
  units(cwd: string): ServiceUnits;
}

function setupsOwn(root: string): boolean {
  if (!existsSync(root)) return true;
  const names = readdirSync(root);
  if (names.length === 0) return true;
  const own = new Set(['releases', 'install.json.tmp', 'current', 'current.tmp']);
  if (!names.includes('releases') || !names.every((name) => own.has(name))) return false;
  const releases = installPaths(root).releases;
  return readdirSync(releases).every((name) => name.endsWith('.tmp') || existsSync(join(releases, name, HOST_ENTRY)));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function lookAdvice(error: unknown, permission: string): string {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EACCES' || code === 'EPERM' ? `${permission}, and run setup again.`
    : 'Repair what that path runs through, and run setup again.';
}

function shellWord(path: string): string {
  return /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replace(/'/g, "'\\''")}'`;
}

/** The release `current` names, read from its link alone, so a link whose release is gone still says it: only a
 *  target of the form `releases/<version>`, which is how a switch writes it. */
function linkedRelease(current: string): string | null {
  let target: string;
  try {
    target = readlinkSync(current);
  } catch {
    return null;
  }
  const match = /^releases\/([^/]+)$/.exec(target);
  return match === null || match[1] === '.' || match[1] === '..' ? null : match[1];
}

/** The end of setup's refusals of a record: what this run did and was given, then how to put the record right. */
function recordAgain(dataDir: string): string {
  return `Setup has changed nothing. It was given the data directory ${dataDir}, which belongs in the record only if ` +
    `its host was started with it. ${WRITE_RECORD_AGAIN}`;
}

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

  let existing: InstallRecord | null;
  try {
    existing = readRecord<InstallRecord>(paths.install, 'install record');
  } catch (error) {
    if (!(error instanceof ContractError)) {
      throw new ContractError(`The install record at ${paths.install} can't be read: ${errorText(error)}. Make it a ` +
        'file this user can read, and run setup again.');
    }
    let version: unknown;
    try {
      version = (JSON.parse(readFileSync(paths.install, 'utf-8')) as { v?: unknown } | null)?.v;
    } catch {
    }
    if (version !== undefined && version !== 1) throw error;
    throw new ContractError(`${error.message.replace(/\.+$/, '')}. ${recordAgain(dataDir)}`);
  }
  if (existing !== null && (typeof existing.dataDir !== 'string' || existing.dataDir === '')) {
    throw new ContractError(`The install record at ${paths.install} names no data directory this release can read. ${recordAgain(dataDir)}`);
  }
  const writtenAfterRecord: [string, string][] = [
    [paths.journal, `${basename(paths.journal)}, its update journal,`],
    ...[ENTRY_POINT, INSTALL_COMMAND, `${ENTRY_POINT}.tmp`, `${INSTALL_COMMAND}.tmp`].map((name): [string, string] =>
      [join(root, name), `${name}, which setup writes only after the record,`]),
  ];
  const shown = existing !== null ? undefined : writtenAfterRecord.find(([path]) => exists(path))?.[1];
  if (shown !== undefined && exists(paths.releases)) {
    throw new ContractError(`The install at ${root} has ${shown} and no record at ${paths.install}, so its record ` +
      'is gone. The record is what\'s gone: it named the data directory the install serves and the places of state ' +
      `kept outside it that each update copies, and setup hasn't touched those. ${recordAgain(dataDir)}`);
  }
  if (shown !== undefined) {
    const seen = `${root} has ${shown} but no record at ${paths.install} and no ${paths.releases}, so setup can't tell ` +
      'whether it made it, and it can\'t put an install back in place without its releases. Setup has changed ' +
      `nothing, and the data directory it was given, ${dataDir}, is outside it.`;
    const stopped = (account: string): ContractError =>
      new ContractError(`${seen} ${account} If setup didn't make it, choose another --root.`);
    let lines: JournalLine[] = [];
    let unread: string | null = null;
    try {
      lines = readJournal(root);
    } catch (error) {
      unread = errorText(error).replace(/\.+$/, '');
    }
    const journalThere = lstatSync(paths.journal, { throwIfNoEntry: false }) !== undefined;
    const end = lines.at(-1);
    const committed = end !== undefined && end.step === 'commit' && end.outcome === 'ok' ? end.to : null;
    const linked = linkedRelease(paths.current);
    const named = linked === null ? 'It has no current that names a release.' : `Its current names ${linked}.`;
    const backUp = 'and a fresh install starts with no journal to finish one from. Don\'t start any release on that ' +
      `data, and don't move ${root} aside and run setup again. If you have ${paths.releases} in a backup, put it back: ` +
      'setup then takes the root for an install whose record is gone, and says how to write the record back.';
    if (unread !== null) {
      throw stopped(`${named} Its journal can't be read (${unread}), so setup can't tell from it whether an update or a ` +
        `Go back stopped part-way, ${backUp}`);
    }
    if (journalThere && end === undefined) {
      throw stopped(`${named} Setup reads no whole line in its journal, so it can't tell from it whether an update or ` +
        `a Go back stopped part-way, ${backUp}`);
    }
    if (end !== undefined && committed === null) {
      throw stopped(`${named} Its journal's last line, a ${end.step} (${end.outcome}), isn't an ok commit, so setup ` +
        `can't tell from it whether an update or a Go back stopped part-way, ${backUp}`);
    }
    const there = lstatSync(paths.current, { throwIfNoEntry: false });
    const pointAt = (release: string): string => {
      const ln = `${shellWord(join('releases', release))} ${shellWord(paths.current)}`;
      return there === undefined ? `point current at it with \`ln -s ${ln}\``
        : there.isSymbolicLink() ? `point current at it with \`ln -sfn ${ln}\``
        : `move ${paths.current} aside, and point current at it with \`ln -s ${ln}\``;
    };
    const afresh = 'and run setup again as before: it then says how to make the install afresh from exactly that ' +
      'release.';
    const install = installHolding(realpathSync(options.hostRoot));
    const hold = (known: string, release: string): string => 'Until you know which release did, and that no update ' +
      'or Go back stopped part-way on it, don\'t start any release on that data, and don\'t move ' + root + ' aside and ' +
      'run setup again. ' + (install === null ? notInstalled(options.hostRoot)
        : `If setup made it and you know${known}, ${pointAt(release)} ${afresh}`);
    if (linked !== null && committed !== null && linked !== committed) {
      throw stopped(`Its current names ${linked}, and its journal's last line, an ok commit, names ${committed}, so ` +
        `setup can't tell which release its data last committed on. ${hold(` it's ${committed}`, committed)}`);
    }
    const last = linked ?? committed;
    if (last === null) {
      throw stopped(`${named} Nothing setup can read names the release its data last committed on. ` +
        hold(' which', '<that release>'));
    }
    if (install === null) throw stopped(notInstalled(options.hostRoot));
    const ifMade = journalThere ? 'If setup made it' : 'It has no journal: an install has none until an update or a ' +
      'Go back is first asked of it, and a journal can be lost with the record, so its absence doesn\'t show whether ' +
      'one ran on that data. If one did, ' +
      `don't start any release on that data, and don't move ${root} aside and run setup again, until you know that ` +
      'its current names the release that last committed on it and that none stopped part-way. If setup made it, ' +
      'and none ran or you know that';
    const version = (JSON.parse(readFileSync(join(options.hostRoot, 'package.json'), 'utf-8')) as { version: string }).version;
    const pkg = shellWord(`@animalabs/connectome-host@${last}`);
    const exactly = last === version ? ', the release that last committed on its data and the one setup here installs: '
      : `, the release that last committed on its data, and setup here installs ${version}: install exactly ${last} in ` +
        `${install} first, with \`cd ${shellWord(install)} && npm install ${pkg}\` or \`cd ${shellWord(install)} && bun ` +
        `--no-env-file add ${pkg}\`, as docs/DEPLOYMENTS.md does, so that ` +
        `the setup below is ${last}'s own, since any other release would start on that data with no copy of it ` +
        'behind; then ';
    const setupThere = setupCommand(install, dataDir, root);
    const names = linked === null ? `${named} ${ifMade}, its journal's last line, an ok commit, names ${last}`
      : `${ifMade}, its current names ${last}`;
    throw new ContractError(`${seen} ${names}${exactly}stop its service, move ${root} ` +
      `aside, keeping it until the new install runs, and run \`${setupThere}\`, with DATA_DIR the data directory its ` +
      `host was started with if that isn't ${dataDir}, and --extra-state PATH added for each place of state kept ` +
      'outside the data directory that\'s there now: setup then makes the install afresh there, serving that data ' +
      'directory, with no journal or copy, so with no Go back, and starting the service again starts the new install, ' +
      `since its path is the same. Those places: a setup run that finished printed them after "${EXTRA_STATE_LINE}", ` +
      `and the moved root's copy/copy.json, if it has updated, ${copyShows('which aren\'t given')} If setup didn't make ` +
      'it, choose another --root.');
  }
  const link = `\`ln -sfn ${shellWord(join('releases', '<that release>'))} ${shellWord(paths.current)}\``;
  const current = (): string | null => {
    try {
      const name = readCurrent(root);
      if (name !== null) releaseDir(root, name);
      return name;
    } catch (error) {
      // readlink's EINVAL: it's there, and not a link.
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
    const currentWhenWritten = (line: JournalLine) =>
      (line.step === 'commit' && line.outcome === 'ok') || line.step === 'fallback' ? line.to : line.from;
    const last = lines.at(-1);
    const committed = last === undefined ? null : currentWhenWritten(last);
    let at = -1;
    lines.forEach((line, i) => { if (line.step === 'commit' && line.outcome === 'ok') at = i; });
    const mayHaveCommitted = lines.slice(at + 1).filter((line, i, after) => line.step === 'trial-start' &&
      line.outcome === 'ok' && after.slice(i + 1).every((l) => currentWhenWritten(l) === line.to));
    const maybe = [...new Set(mayHaveCommitted.map((line) => line.to))].filter((release) => release !== committed);
    let named: string;
    if (committed !== null) {
      named = `${committed}, which the journal's last line leaves it naming`;
    } else {
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
    throw new ContractError(`${root} isn't empty, and holds no install record, so setup doesn't take it for an install it made. ` +
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
  if (install === null) throw new ContractError(notInstalled(options.hostRoot));
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
  const running = current();
  if (running !== null) {
    const release = releaseDir(root, running);
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
  writeTextAtomic(entry, entryPointText());
  const command = writeInstallCommand(root);

  if (settingUp) {
    say(`Set up ${root} as the install of ${readCurrent(root)} that serves ${dataDir}.`);
  } else {
    say(`The install at ${root} serves ${existing?.dataDir ?? dataDir} and runs ${readCurrent(root)}, as before.`);
  }
  const served = existing?.dataDir ?? dataDir;
  say(`${EXTRA_STATE_LINE}: an update copies the data directory, ${served}, and outside it only the places listed ` +
    'here, beside those it finds itself (mcpl-servers.json, the agent overlay and its fleet children\'s data ' +
    'directories):');
  for (const place of extraState.length > 0 ? extraState : ['none']) say(`  ${place}`);
  say(`${LIST_A_PLACE}, such as an MCPL server's state, run setup again with every place, the ones listed here too: ` +
    `\`${setupCommand(install, served, root)}${extraState.map((place) => ` --extra-state ${shellWord(place)}`).join('')} ` +
    '--extra-state <another place>`, one --extra-state for each. It can run while the service runs: it leaves the ' +
    'running host as it is, and the next update copies the places it records.');
  say(`The service starts the host with \`${shellWord(process.execPath)} ${shellWord(entry)}\`, followed by the arguments ` +
    `it gives the host${settingUp ? ' now; set that, and restart it' : ''}.`);
  say(`This install's own command is ${command.path}.`);
  if (command.pathLine !== null) {
    say('To type it as `connectome` from anywhere, put its directory on your PATH, and in ~/.bashrc (or your ' +
      'shell\'s own file) to keep it there:');
    say(`  ${command.pathLine}`);
  }
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
