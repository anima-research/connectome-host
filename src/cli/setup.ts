import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { bunBelowFloor } from '../bun-floor.js';
import { ANTHROPIC_API } from '../setup/key-check.js';
import { SERVERS, SETUP_BUN_FLOOR, SHELL_NODE_TOP, installedVersion, packageJson } from '../setup/packages.js';
import { readEnvFile, unwritableValue, writeEnvValue } from '../setup/secrets.js';
import { macSessionCheck, ended, realWorld, withoutKeys, type SetupWorld } from '../setup/world.js';
import { readCurrent, readRecord, releaseDir, type InstallRecord } from '../update/contract.js';
import { HOST_ENTRY, RELEASE_HOST, shellWord } from '../update/launcher.js';
import type { CliContext } from './connectome.js';
import { INSTALL_COMMAND } from './install-command.js';

export const SETUP_USAGE = 'connectome setup discord';
export const SETUP_RECIPE = join(RELEASE_HOST, 'recipes', 'setup.json');
export const SETUP_SUMMARY = 'Sets a resident up on Discord with the host\'s own setup agent, in the directory that ' +
  'holds the install (from bunx, the directory it runs in where that\'s empty or setup\'s, and ~/resident otherwise). ' +
  'Run again, its agent picks up where it stopped.';
export const ROOT_IN_WORKDIR = 'connectome-host';

const PACKAGE = '@animalabs/connectome-host';
const SURFACE = 'discord';
const BOOT_TIMEOUT_MS = 60_000;
const OWN_USER = 'connectome';
const NOT_FOR_THE_AGENT = [
  'CONNECTOME_INSTALL_ROOT', 'MODEL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_CREDENTIALS_FILE', 'ANTHROPIC_BASE_URL',
  'MCPL_AGENT_OVERLAY_FILE',
];

export function packageCommand(): string {
  return `bunx ${PACKAGE}@${packageJson().version}`;
}

export function firstLine(): string {
  return `${packageCommand()} setup ${SURFACE}`;
}

function entriesOf(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function setupsOwn(dir: string): boolean {
  return existsSync(join(dir, '.setup')) || existsSync(join(dir, ROOT_IN_WORKDIR, 'install.json'));
}

export function setupDirectory(cwd: string, home: string | undefined): string {
  if (entriesOf(cwd).length === 0 || setupsOwn(cwd)) return cwd;
  return home !== undefined && isAbsolute(home) && statSync(home, { throwIfNoEntry: false })?.isDirectory()
    ? join(home, 'resident') : cwd;
}

export async function setup(ctx: CliContext & { root: string }, world: SetupWorld = realWorld()): Promise<number> {
  try {
    return await setupIn(ctx, world);
  } catch (error) {
    ctx.err(`connectome setup: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

async function setupIn(ctx: CliContext & { root: string }, world: SetupWorld): Promise<number> {
  const { out, err, root } = ctx;
  const dir = dirname(root);
  const pkg = packageJson();
  if (ctx.argv.length !== 1 || ctx.argv[0] !== SURFACE) {
    err(`Usage: ${SETUP_USAGE}`);
    err('Discord is the one surface setup sets a resident up on.');
    return 2;
  }
  if (!world.terminal) {
    err('connectome setup needs a person at a terminal: it asks questions, and its agent talks with you in this ' +
      'terminal. Run it in one.');
    return 1;
  }
  const own = setupsOwn(dir);
  if (!own && entriesOf(dir).length > 0) {
    err(`connectome setup: ${dir} holds other files, and no connectome-host install, so setup won't put its own ` +
      'there. Make a new directory for the resident where you can write, and run this same version of setup there. ' +
      'Its service takes the directory\'s name:');
    err(`  ${firstLine()}`);
    return 1;
  }
  out(own
    ? `Setup ran in ${dir} before. Its agent picks up where it stopped, and can change with you what it set up.`
    : `The resident will live in ${dir}${dir === world.cwd ? '' : `, since ${world.cwd} holds other files`}. Its ` +
      `service will be named after the directory's name, ${basename(dir)}.`);
  const recordPath = join(root, 'install.json');
  if (!existsSync(recordPath) && offersOwnUser(world)) {
    adviseOwnUser(world, out);
    out('To give it that user, answer no: setup then says how to go on there.');
    const go = await yesNo(world, `Go on as ${world.user}? (yes/no) [yes] `, true);
    if (go === null) return stopped(out);
    if (!go) {
      out(`Setup needs Node ${pkg.engines.node.replace('>=', '')} or later there too, and at most Node ` +
        `${SHELL_NODE_TOP} if the resident may get a shell: if this machine's Node is installed for your user ` +
        `alone, as one from nvm is, install Node for ${OWN_USER} as well. \`command -v node\` shows where yours is: ` +
        'one in your home is yours alone.');
      out(`Then open a shell as ${OWN_USER}, with \`sudo -iu ${OWN_USER}\` where you can use sudo, or by whoever ran ` +
        'the line, and run this same version of setup there:');
      out(`  ${firstLine()}`);
      out('Nothing was installed here.');
      return 0;
    }
  }
  const linger = world.lingerOf(world.user);
  const session = world.platform === 'darwin' ? world.macSession() : undefined;
  if (linger === null && world.platform === 'linux') {
    out('This machine doesn\'t run systemd, so the resident can\'t run as a systemd user service here, the way its ' +
      'guide sets it up. Another service manager can run it: one that starts the install\'s start.js and restarts it ' +
      'when it exits with 75 or 1, as docs/DEPLOYMENTS.md in the host\'s package says.');
  }
  if (linger === false) {
    out(`Linger is off for ${world.user}, so a service of ${world.user}'s stops when ${world.user} logs out. One line ` +
      `turns it on, run once ${world.hasSudo ? 'with sudo. You can run it if you can use sudo here, or whoever ' +
        'administers this machine can.' : 'as root. You or whoever administers this machine can run it.'} It can run ` +
      'at any time before the resident goes live, and setup goes on meanwhile:');
    out(`  ${lingerLine(world)}`);
  } else if (session !== undefined) {
    out(`On macOS, a service of ${world.user}'s stops when ${world.user} logs out of the Mac's graphical session, not ` +
      `when an ssh session ends, and launchd starts it when ${world.user} logs in there. ${session === null
        ? `${world.user} is logged in there now.`
        : `\`${macSessionCheck().join(' ')}\` didn't give 0 for ${world.user}'s graphical session (${session}). It ` +
          `gives 0 only while ${world.user} is logged in there, and the service's install refuses until it does, so ` +
          'setup goes on meanwhile.'}`);
  }

  const upgrade = '`bun upgrade` upgrades it, or the package manager that installed it does; then run setup again.';
  if (bunBelowFloor(SETUP_BUN_FLOOR, world.bun.version) === true) {
    err(`Setup needs Bun ${SETUP_BUN_FLOOR.replace('>=', '')} or later, whose \`bun add --no-env-file\` keeps .env's ` +
      `values from the packages' install scripts, and this is Bun ${world.bun.version}. ${upgrade}`);
    return 1;
  }
  const env = withoutKeys(world.env, []);
  const node = await world.run(['node', '--version'], { cwd: dir, env });
  const nodeVersion = node.status === 0 ? node.stdout.trim().replace(/^v/, '') : null;
  const nodeFloor = pkg.engines.node.replace('>=', '');
  const getNode = `Install Node ${nodeFloor} or later, and at most Node ${SHELL_NODE_TOP} if the resident may get a ` +
    'shell, from nodejs.org or your system\'s package manager, and run setup again.';
  if (nodeVersion === null) {
    err(world.hasNode(env.PATH)
      ? `connectome-host needs Node as well as Bun, and \`node --version\` didn't answer here (${ended(node)}). ${getNode}`
      : `There's no Node on this machine's PATH. connectome-host needs Node as well as Bun. ${getNode}`);
    return 1;
  }
  if (bunBelowFloor(pkg.engines.node, nodeVersion) !== false) {
    err(`connectome-host needs Node ${nodeFloor} or later, and this is Node ${nodeVersion}. ${getNode}`);
    return 1;
  }

  mkdirSync(join(dir, '.setup'), { recursive: true, mode: 0o700 });
  const wanted = [
    ...installedVersion(dir, PACKAGE) === pkg.version ? [] : [`${PACKAGE}@${pkg.version}`],
    ...installedVersion(dir, SERVERS.discord) === null ? [SERVERS.discord] : [],
  ];
  if (wanted.length > 0) {
    out(`${wanted[0]!.startsWith(PACKAGE) ? 'With the install\'s own copy of it, made next, setup takes about 0.8 GB ' +
      'of disk here. ' : ''}Installing ${wanted.join(', ')} in ${dir}, with Bun:`);
    const added = await world.run([world.bun.path, '--no-env-file', 'add', ...wanted], { cwd: dir, env, show: true });
    if (added.status !== 0) {
      err(`\`bun --no-env-file add ${wanted.join(' ')}\` didn't finish (${ended(added)}), so setup stops here. Its own ` +
        'lines above say why. Run setup again once that\'s put right.');
      return 1;
    }
  }

  const record = readRecord<InstallRecord>(recordPath, 'install record');
  const dataDir = record?.dataDir ?? join(dir, 'data');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const ownSetup = join(dir, RELEASE_HOST, 'src', 'update', 'setup.ts');
  out(record === null
    ? `Setting up ${root}, the folder the resident's host runs from, which later updates install into. It starts as a ` +
      'copy of what was just installed here.'
    : `Checking the install at ${root}.`);
  const made = await world.run([world.bun.path, '--no-env-file', ownSetup, '--root', root], {
    cwd: dir, env: { ...withoutKeys(env, ['CONNECTOME_INSTALL_ROOT']), DATA_DIR: dataDir },
  });
  if (made.status !== 0) {
    for (const line of `${made.stdout}\n${made.stderr}`.split('\n')) if (line.trim() !== '') out(line);
    err(`The install's own setup (${ownSetup}) didn't finish (${ended(made)}). Once what the lines above say is put ` +
      'right, run setup again.');
    return 1;
  }
  const command = shellWord(join(root, INSTALL_COMMAND));
  if (record === null) out(`This install's own command is ${command}.`);

  const running = readCurrent(root);
  if (running === null) throw new Error(`the install at ${root} has no current release after its own setup`);
  const release = releaseDir(root, running);
  const setupRecipe = join(release, SETUP_RECIPE);
  if (!existsSync(setupRecipe)) {
    err(`The release this install runs, ${running}, has no setup agent: there's no ${setupRecipe}. Once the ` +
      `resident's host runs, its /update, in the TUI or the Web UI, updates it to a release that has one, such as ` +
      `${pkg.version}; then run setup again.`);
    return 1;
  }
  let model: unknown;
  try {
    model = (JSON.parse(readFileSync(setupRecipe, 'utf-8')) as { agent?: { model?: unknown } } | null)?.agent?.model;
  } catch (error) {
    throw new Error(`${setupRecipe}, the setup agent's recipe, can't be read (${(error as Error).message})`);
  }
  if (typeof model !== 'string') throw new Error(`${setupRecipe}, the setup agent's recipe, names no agent.model`);
  const entry = join(release, HOST_ENTRY);

  out('Starting the installed host once, with a test setup that calls no model, to see that it starts.');
  const scratch = mkdtempSync(join(tmpdir(), 'connectome-setup-boot-'));
  try {
    const recipe = join(scratch, 'boot.json');
    writeFileSync(recipe, JSON.stringify({
      name: 'setup boot check',
      agent: { name: 'boot', provider: 'mock', systemPrompt: 'Setup\'s boot check.' },
      modules: { wake: false, workspace: false, subscriptionGc: false },
    }));
    const boot = await world.run([world.bun.path, entry, recipe, '--no-tui'], {
      cwd: scratch, env: { ...withoutKeys(env, NOT_FOR_THE_AGENT), DATA_DIR: join(scratch, 'data') },
      timeoutMs: BOOT_TIMEOUT_MS,
    });
    if (boot.status !== 0) {
      err(`The installed host (${running}, ${entry}) doesn't start with a test setup that calls no model, in batch ` +
        `mode: ${boot.timedOut ? `it didn't finish booting within ${BOOT_TIMEOUT_MS / 1000} s` : ended(boot)}.`);
      for (const line of `${boot.stdout}\n${boot.stderr}`.split('\n')) if (line.trim() !== '') err(`  ${line}`);
      err('Where the host\'s own lines above name something of this machine\'s, such as a file it can\'t read, put ' +
        'that right. Where they name the host\'s code or a package it brings, such as a module it can\'t find, ' +
        `that's for its makers: report them, with this output, at ${pkg.bugs.url}. Once what made its boot fail is ` +
        'put right, run setup again.');
      return 1;
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  out(`The installed host (${running}) starts.`);

  const key = await keyFor(world, out, err, join(dir, '.env'), model);
  if (key === null) return stopped(out);
  out(costLine(model));

  out(`Setup's agent runs each command in ${dir}, as you, and you'll see each command whole as it starts. It ` +
    'doesn\'t wait for you to read it.');
  out(`Starting setup's agent. It speaks first. /quit leaves the conversation, and \`${command} setup ${SURFACE}\` ` +
    'picks it up where it stopped.');
  const status = await world.startAgent({
    argv: [world.bun.path, '--no-env-file', entry, setupRecipe, '--no-tui'],
    cwd: join(dir, '.setup'),
    env: {
      ...withoutKeys(env, NOT_FOR_THE_AGENT),
      ANTHROPIC_API_KEY: key.key,
      ...(key.baseUrl === undefined ? {} : { ANTHROPIC_BASE_URL: key.baseUrl }),
      DATA_DIR: join(dir, '.setup'),
      CONNECTOME_SETUP_VERSION: running,
      CONNECTOME_SETUP_INSTALL: root,
      CONNECTOME_SETUP_DIR: dir,
      CONNECTOME_SETUP_SURFACE: 'Discord',
      CONNECTOME_SETUP_GUIDE: join(release, RELEASE_HOST, 'docs', 'AGENT-ONBOARDING.md'),
      CONNECTOME_SETUP_USER: world.user,
      CONNECTOME_SETUP_COMMAND: command,
      ...offersOwnUser(world, linger) ? { CONNECTOME_SETUP_OWN_USER_LINE: OWN_USER_LINE } : {},
      ...linger === false ? { CONNECTOME_SETUP_LINGER_LINE: lingerLine(world) } : {},
      ...world.timeZone ? { CONNECTOME_SETUP_TIME_ZONE: world.timeZone } : {},
      ...session === undefined ? {} : { CONNECTOME_SETUP_MAC_SESSION: session ?? '0' },
      CONNECTOME_UPDATE_CHECK: '0',
    },
  });
  out(`To go on with setup, or to change something it set up: \`${command} setup ${SURFACE}\`.`);
  return status;
}

async function keyFor(
  world: SetupWorld, out: (line: string) => void, err: (line: string) => void, envFile: string, model: string,
): Promise<{ key: string; baseUrl?: string } | null> {
  const stored = readEnvFile(envFile);
  const baseUrl = stored.get('ANTHROPIC_BASE_URL') || undefined;
  let key: string | null = stored.get('ANTHROPIC_API_KEY') || null;
  let from = key === null ? null : `the ANTHROPIC_API_KEY in ${envFile}`;
  const exported = world.env.ANTHROPIC_API_KEY?.trim();
  if (key === null && exported) {
    const use = await yesNo(world, 'An ANTHROPIC_API_KEY is exported in this shell. Use it for setup\'s agent? Setup ' +
      `writes it to ${envFile}, readable by you alone. The resident uses it too, unless you change it. (yes/no) [yes] `, true);
    if (use === null) return null;
    if (use) [key, from] = [exported, 'the exported key'];
  }
  for (;;) {
    if (key === null) {
      key = (await world.askHidden(`${baseUrl === undefined ? 'An Anthropic API key, from console.anthropic.com\'s ' +
        'API keys' : `An API key that ${new URL(baseUrl).host} accepts`}, typed hidden (Enter alone stops setup)`))?.trim() ?? '';
      if (key === '') return null;
      from = 'the key';
    }
    const unwritable = unwritableValue(key);
    if (unwritable !== null) {
      err(`${from![0]!.toUpperCase()}${from!.slice(1)} can't be used: ${unwritable}. Check what was copied.`);
      key = null;
      continue;
    }
    out(`Checking ${from}: one call at ${baseUrl === undefined ? ANTHROPIC_API : new URL(baseUrl).origin} to ${model}, ` +
      'the model setup\'s agent runs on, which the key\'s account has to be able to use.');
    const checked = await world.checkKey({ key, model, ...(baseUrl === undefined ? {} : { baseUrl }) });
    if (checked.ok) break;
    err(checked.said);
    out('Type a key, this one again or another, or Enter alone to stop.');
    key = null;
  }
  if (stored.get('ANTHROPIC_API_KEY') === key) chmodSync(envFile, 0o600);
  else writeEnvValue(envFile, 'ANTHROPIC_API_KEY', key);
  out(`The key works, and it's in ${envFile}, readable by you alone.`);
  return { key, ...(baseUrl === undefined ? {} : { baseUrl }) };
}

function stopped(out: (line: string) => void): number {
  out('Setup stopped. Run it again in this directory to go on.');
  return 1;
}

async function yesNo(world: SetupWorld, question: string, enter: boolean): Promise<boolean | null> {
  for (;;) {
    const answer = await world.ask(question);
    if (answer === null) return null;
    const word = answer.trim().toLowerCase();
    if (word === '') return enter;
    if (word === 'yes' || word === 'y') return true;
    if (word === 'no' || word === 'n') return false;
  }
}

function offersOwnUser(world: SetupWorld, linger = world.lingerOf(world.user)): boolean {
  return world.platform === 'linux' && world.hasSudo && linger !== null && world.user !== OWN_USER;
}

function lingerLine(world: SetupWorld): string {
  return `${world.hasSudo ? 'sudo ' : ''}loginctl enable-linger ${world.user}`;
}

// One line: with sudo's use_pty, lines pasted after a sudo line go to its command as input, and never run.
// bun.sh/install exits before adding Bun to PATH, or linking bunx, wherever a bun is on PATH already.
const OWN_USER_LINE = `id -u ${OWN_USER} >/dev/null 2>&1 || sudo useradd -m -s /bin/bash ${OWN_USER} && ` +
  `sudo loginctl enable-linger ${OWN_USER} && ` +
  `sudo -iu ${OWN_USER} env PATH=/usr/bin:/bin bash -c 'set -o pipefail; curl -fsSL https://bun.sh/install | bash'`;

function adviseOwnUser(world: SetupWorld, out: (line: string) => void): void {
  out(`The resident runs as the user that runs setup, here ${world.user}, and changing that later means starting over ` +
    'as another user. Later, with setup\'s agent, you decide what the resident may do, such as whether it gets a shell ' +
    `to run commands on this machine. With a shell, the resident can read and change whatever ${world.user} can, and ` +
    'whoever talks to it on Discord can ask it to. So if this is your own account and the resident may get a shell, ' +
    `give it a user of its own. This line makes one, named ${OWN_USER}, unless a user by that name is there already, ` +
    'keeps its services running while it\'s logged out, and gives it Bun on its PATH. Run it where you can use sudo, ' +
    'and if a step fails, put right what it names and run the line again:');
  out(`  ${OWN_USER_LINE}`);
  if (world.userExists(OWN_USER) === true) {
    out(`This machine already has a user named ${OWN_USER}. If an earlier line of setup's made it for the resident, ` +
      `open a shell as ${OWN_USER} and run setup there. Otherwise, for a user of the resident's own, put a name no ` +
      `account here has in place of ${OWN_USER}, in the line and in what setup says after it.`);
  }
}

// From five test setups on claude-opus-5-5, with a tester as the person, at Anthropic's list prices.
const WALKS_MODEL = 'claude-opus-5-5';

export function costLine(model: string): string {
  return model === WALKS_MODEL
    ? `Setup's agent runs on ${model}, and spends from this key. In five test setups, with a tester playing the ` +
      'person, it cost between $0.45 and $2.70 each at Anthropic\'s list prices; the higher figure includes the new ' +
      'resident\'s first calls, which couldn\'t be told apart from setup\'s.'
    : `Setup's agent runs on ${model}, and spends from this key. What a setup costs on it isn't measured.`;
}
