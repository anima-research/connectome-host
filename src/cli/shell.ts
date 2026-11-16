import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { bunBelowFloor } from '../bun-floor.js';
import { HOST_TRUSTED, defaultTrusted } from '../setup/default-trusted.js';
import { makeSpawnHelperExecutable, nodePtyDir } from '../setup/node-pty.js';
import { SERVERS, SETUP_BUN_FLOOR, SHELL_NODE_TOP, installedVersion, packageJson } from '../setup/packages.js';
import { SHOWN_FILE } from '../setup/commands-shown.js';
import { withoutDotenv } from '../setup/secrets.js';
import { ended, realWorld, type SetupWorld } from '../setup/world.js';
import { writeTextAtomic } from '../update/contract.js';
import { shellWord } from '../update/launcher.js';
import type { CliCommand, CliContext } from './connectome.js';
import { INSTALL_COMMAND } from './install-command.js';
import { shownToPerson } from './shown.js';

export const SHELL_USAGE = 'connectome shell install';

export type ShellWorld = Pick<SetupWorld, 'platform' | 'env' | 'cwd' | 'bun' | 'hasSudo' | 'hasNode' | 'run'>;

const SHELL = SERVERS.shell;
// The 1.x line: the daemon, port and token that the resident's shell runs on are 1.x's.
const SHELL_RANGE = '^1';

export const shellCommand: CliCommand = {
  name: 'shell',
  usage: SHELL_USAGE,
  summary: `Installs the resident's shell, ${SHELL} 1.x, in the directory that holds this install, unless it's there, ` +
    'and checks that node-pty opens a pty there, installing node-pty once more if it doesn\'t. It writes no recipe ' +
    'and sets up no service. Setup\'s agent runs it when the person wants the resident to have a shell, and it can be ' +
    'run again.',
  run: (ctx) => shell(ctx),
};

export async function shell(given: CliContext, world: ShellWorld = realWorld()): Promise<number> {
  const ctx = shownToPerson(given, world.env);
  const line = `${shellWord(join(ctx.root!, INSTALL_COMMAND))} shell install`;
  if (ctx.argv.length !== 1 || ctx.argv[0] !== 'install') {
    ctx.err(`Usage: ${line}`);
    return 2;
  }
  try {
    return await install(ctx, world, line);
  } catch (error) {
    ctx.err(`connectome shell install: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

async function install(ctx: CliContext, world: ShellWorld, line: string): Promise<number> {
  const { out, err } = ctx;
  const dir = dirname(ctx.root!);
  const again = `run \`${line}\` again`;
  if (bunBelowFloor(SETUP_BUN_FLOOR, world.bun.version) === true) {
    err(`The resident's shell is installed with Bun ${SETUP_BUN_FLOOR.replace('>=', '')} or later, whose \`bun add ` +
      `--no-env-file\` keeps .env's values from the packages' install scripts, and this is Bun ${world.bun.version}. ` +
      `\`bun upgrade\` upgrades it, or the package manager that installed it does; then ${again}.`);
    return 1;
  }
  const env = withoutDotenv(world.env, world.cwd);
  const node = await world.run(['node', '--version'], { cwd: dir, env });
  const nodeVersion = node.status === 0 ? node.stdout.trim().replace(/^v/, '') : null;
  const getNode = `Install Node ${packageJson().engines.node.replace('>=', '')} or later, and at most Node ` +
    `${SHELL_NODE_TOP}, from nodejs.org or your system's package manager, and ${again}.`;
  if (nodeVersion === null) {
    err(world.hasNode(env.PATH)
      ? `The resident's shell runs on Node, and \`node --version\` didn't answer here (${ended(node)}). ${getNode}`
      : `There's no Node on this machine's PATH. The resident's shell runs on Node. ${getNode}`);
    return 1;
  }
  if (Number(nodeVersion.split('.')[0]) > SHELL_NODE_TOP) {
    err(`The resident's shell, ${SHELL}, runs on Node ${SHELL_NODE_TOP} at most, and this is Node ${nodeVersion}. ` +
      getNode);
    return 1;
  }

  const manifest = join(dir, 'package.json');
  const trusted = await defaultTrusted(async (_manager, args, cwd) => {
    const ran = await world.run([world.bun.path, '--no-env-file', ...args], { cwd, env });
    return { status: ran.status, output: `${ran.stdout}${ran.stderr}` };
  }, dir);
  const listed = Array.isArray(trusted) ? addTrusted(manifest, [...trusted, ...HOST_TRUSTED]) : trusted.reason;
  if (listed !== null) {
    out(`This couldn't add the packages whose install scripts Bun runs by default to ${manifest} (${listed}), so ` +
      `unless it already names ${SHELL} among its trustedDependencies, Bun runs no install script of ${SHELL}'s, and ` +
      'through a mirror or a company registry it may run none of the others\', node-pty\'s among them.');
  }

  const found = installedVersion(dir, SHELL);
  if (found !== null && found.split('.')[0] === '1') {
    out(`${SHELL} ${found} is installed in ${dir}.`);
  } else {
    if (found !== null) {
      out(`${SHELL} ${found} is in ${dir}, and the resident's shell is ${SHELL} 1.x, so this installs 1.x in its place.`);
    }
    const spec = `${SHELL}@${SHELL_RANGE}`;
    out(`Installing ${spec} in ${dir}, with Bun.`);
    const added = await world.run([world.bun.path, '--no-env-file', 'add', spec], { cwd: dir, env, show: true });
    if (added.status !== 0) {
      err(`\`bun --no-env-file add ${spec}\` didn't finish (${ended(added)}), so the resident's shell isn't installed. ` +
        `${world.env[SHOWN_FILE] ? 'Setup\'s agent has Bun\'s own lines, which say why' : 'Bun\'s own lines say why'}. ` +
        `Once that's put right, ${again}.`);
      return 1;
    }
    const now = installedVersion(dir, SHELL);
    if (now !== null) out(`${SHELL} ${now} is installed in ${dir}.`);
  }

  const loadedFrom = nodePtyDir(dir);
  const outside = existsSync(loadedFrom) && !within(realpathSync(loadedFrom), realpathSync(dir));
  let helper = outside ? null : makeSpawnHelperExecutable(loadedFrom, world.platform);
  let pty = await ptyWorks(world, dir, env);
  if (pty !== null && outside) {
    err(`The resident's shell runs on node-pty, and here it doesn't work: ${pty}. node-pty loads from ${loadedFrom}, ` +
      `which is outside ${dir}, so this command leaves it as it is. A resident without a shell needs none of this.`);
    return 1;
  }
  if (pty !== null) {
    out(`The resident's shell runs on node-pty, which doesn't work in ${dir} yet (${pty}), so this installs it again.`);
    rmSync(nodePtyDir(dir), { recursive: true, force: true });
    const reinstalled = await world.run([world.bun.path, '--no-env-file', 'install'], { cwd: dir, env, show: true });
    if (reinstalled.status === 0) {
      helper = makeSpawnHelperExecutable(nodePtyDir(dir), world.platform);
      pty = await ptyWorks(world, dir, env);
    } else {
      pty = `\`bun --no-env-file install\` didn't finish (${ended(reinstalled)})`;
      helper = null;
    }
  }
  if (pty !== null) {
    const linux = world.platform !== 'linux' ? '' : 'On Linux, its native part is built as it\'s installed, with ' +
      'python3, make and a C++ compiler; on Debian and Ubuntu, ' +
      `\`${world.hasSudo ? 'sudo ' : ''}apt install build-essential python3\` installs them, run ` +
      `${world.hasSudo ? 'by you if you can use sudo here, or by whoever administers this machine'
        : 'as root, by you or by whoever administers this machine'}. Then ${again}, which installs node-pty again. `;
    const mac = helper === null ? '' : `On macOS, node-pty runs from binaries it ships prebuilt, whose spawn-helper ` +
      `has to be executable, and ${helper}. Run \`${line}\` again once that's put right, which installs node-pty again. `;
    err(`The resident's shell runs on node-pty, and here it doesn't work: ${pty}. ${linux}${mac}A resident without a ` +
      'shell needs none of this.');
    return 1;
  }
  out(`A pty opens in ${dir}: node-pty ran /bin/echo in one, and what it printed came back. The resident's shell can ` +
    'run here. This command writes no recipe and sets up no service.');
  return 0;
}

/** Adds names to package.json's trustedDependencies, which Bun reads in place of its default list. */
function addTrusted(file: string, names: string[]): string | null {
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
  } catch (error) {
    return `${file} can't be read as JSON (${(error as Error).message})`;
  }
  const held = Array.isArray(manifest.trustedDependencies) ? manifest.trustedDependencies as string[] : [];
  const added = names.filter((name) => !held.includes(name));
  if (added.length > 0) writeTextAtomic(file, `${JSON.stringify({ ...manifest, trustedDependencies: [...held, ...added] }, null, 2)}\n`, 0o644);
  return null;
}

const PTY_CHECK = "let p;try{p=require('module').createRequire(require('fs').realpathSync('node_modules/term-sessions-mcp')+'/package.json')('node-pty')" +
  ".spawn('/bin/echo',['pty-ok'],{})}catch(e){console.error(String(e.message)" +
  ".split('\\n')[0]);process.exit(1)}let o='';p.onData(d=>{o+=d});p.onExit(()=>{if(o.includes('pty-ok'))process.exit(0);" +
  "console.error('a pty it opened gave back nothing');process.exit(1)})";

const PTY_CHECK_MS = 30_000;

function within(path: string, dir: string): boolean {
  const from = relative(dir, path);
  return from !== '' && !from.startsWith('..') && !isAbsolute(from);
}

async function ptyWorks(world: ShellWorld, dir: string, env: Record<string, string>): Promise<string | null> {
  const ran = await world.run(['node', '-e', PTY_CHECK], { cwd: dir, env, timeoutMs: PTY_CHECK_MS });
  if (ran.status === 0) return null;
  if (ran.timedOut) return `its check ran past its ${PTY_CHECK_MS / 1000} s limit and was stopped`;
  const said = `${ran.stderr}${ran.stdout}`.trim().split('\n').at(-1)?.replace(/\.+$/, '');
  return said ? said : `node exited without saying why (${ended(ran)})`;
}
