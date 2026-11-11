import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { bunBelowFloor } from '../bun-floor.js';
import { makeSpawnHelperExecutable, nodePtyDir } from '../setup/node-pty.js';
import type { CliCommand, CliContext } from './connectome.js';
import { typedCommand } from './install-command.js';
import {
  SETUP_BUN_FLOOR, SHELL_NODE_TOP, SERVERS, declaredDependencies, ended, envFileRefusal, installedVersion,
  packageJson, realWorld, withoutDotEnv, withoutKeys, type SetupWorld,
} from './setup.js';

export const SHELL_USAGE = 'connectome shell install';

export type ShellWorld = Pick<SetupWorld, 'platform' | 'env' | 'cwd' | 'execArgv' | 'bun' | 'hasSudo' | 'run'>;

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

export async function shell(ctx: CliContext, world: ShellWorld = realWorld()): Promise<number> {
  const line = `${typedCommand(ctx.root!, world.env.PATH)} shell install`;
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
  const refused = envFileRefusal(world, {
    name: 'connectome shell install', command: line, again: 'Run it again',
    environment: 'this command\'s own environment as it starts, where it can\'t keep that file\'s values from the ' +
      'shell\'s install scripts',
  });
  if (refused !== null) {
    for (const said of refused) err(said);
    return 1;
  }
  if (bunBelowFloor(SETUP_BUN_FLOOR, world.bun.version) === true) {
    err(`The resident's shell is installed with Bun ${SETUP_BUN_FLOOR.replace('>=', '')} or later, whose \`bun add ` +
      `--no-env-file\` keeps .env's values from the packages' install scripts, and this is Bun ${world.bun.version}. ` +
      `\`bun upgrade\` upgrades it, or the package manager that installed it does; then ${again}.`);
    return 1;
  }
  let env: Record<string, string>;
  try {
    env = withoutKeys(withoutDotEnv(world.env, world.cwd), []);
  } catch (error) {
    err(`${(error as Error).message}. This command keeps what Bun reads from the dotenv files in ${world.cwd} away ` +
      `from the shell's install scripts, so it must read them: put that right, and ${again}.`);
    return 1;
  }

  const node = await world.run(['node', '--version'], { cwd: dir, env });
  const nodeVersion = node.status === 0 ? node.stdout.trim().replace(/^v/, '') : null;
  const getNode = `Install Node ${packageJson().engines.node.replace('>=', '')} or later, and at most Node ` +
    `${SHELL_NODE_TOP}, from nodejs.org or your system's package manager, and ${again}.`;
  if (nodeVersion === null) {
    err(`The resident's shell runs on Node, and \`node --version\` didn't answer here ` +
      `(${node.startError?.code === 'ENOENT' ? 'there\'s no node on this PATH' : ended(node)}). ${getNode}`);
    return 1;
  }
  if (Number(nodeVersion.split('.')[0]) > SHELL_NODE_TOP) {
    err(`The resident's shell, ${SHELL}, runs on Node ${SHELL_NODE_TOP} at most, and this is Node ${nodeVersion}. ` +
      getNode);
    return 1;
  }

  const manifest = join(dir, 'package.json');
  const untrusted = notTrusted(manifest);
  if (untrusted !== null) {
    out(`${manifest} ${untrusted}, so Bun runs no install script of ${SHELL}'s, and through a mirror or a company ` +
      'registry it may run none of the others\', node-pty\'s among them. Setup tries to write that list each time it ' +
      'runs, and says so when it can\'t.');
  }

  // A package counts as there once package.json declares it: a bun add that fails partway leaves packages in
  // node_modules that it never declares (probed with Bun 1.4.4).
  const declared = declaredDependencies(dir);
  const found = declared === null || declared.has(SHELL) ? installedVersion(dir, SHELL) : null;
  if (found !== null && found.split('.')[0] === '1') {
    out(`${SHELL} ${found} is installed in ${dir}.`);
  } else {
    if (found !== null) {
      out(`${SHELL} ${found} is in ${dir}, and the resident's shell is ${SHELL} 1.x, so this installs 1.x in its place.`);
    }
    const spec = `${SHELL}@${SHELL_RANGE}`;
    out(`Installing ${spec} in ${dir}, with Bun:`);
    const added = await world.run([world.bun.path, '--no-env-file', 'add', spec], { cwd: dir, env, show: true });
    if (added.status !== 0) {
      err(`\`bun --no-env-file add ${spec}\` didn't finish (${ended(added)}), so the resident's shell isn't installed.` +
        (added.status === null ? ` Run \`${line}\` again to try once more.`
          : ` Its own lines above say why. Once that's put right, ${again}.`));
      return 1;
    }
    const now = installedVersion(dir, SHELL);
    if (now !== null) out(`${SHELL} ${now} is installed in ${dir}.`);
  }

  let helper = makeSpawnHelperExecutable(nodePtyDir(dir), world.platform);
  let pty = await ptyWorks(world, dir, env);
  if (pty !== null) {
    const ptyDir = nodePtyDir(dir);
    const aside = join(dir, '.setup', 'node-pty-aside');
    out(`The resident's shell runs on node-pty, which doesn't work in ${dir} yet (${pty.replace(/\.+$/, '')}), so ` +
      `this installs it again, keeping the copy it has at ${aside} until the new one works, and putting it back if ` +
      'it doesn\'t:');
    // Setup's own directory, which a person may have taken away once setup finished.
    mkdirSync(dirname(aside), { recursive: true, mode: 0o700 });
    if (existsSync(aside)) rmSync(ptyDir, { recursive: true, force: true });
    else if (existsSync(ptyDir)) renameSync(ptyDir, aside);
    const reinstalled = await world.run([world.bun.path, '--no-env-file', 'install'], { cwd: dir, env, show: true });
    if (reinstalled.status === 0) {
      helper = makeSpawnHelperExecutable(nodePtyDir(dir), world.platform);
      pty = await ptyWorks(world, dir, env);
    } else pty = `\`bun --no-env-file install\` didn't finish (${ended(reinstalled)})`;
    if (pty === null) rmSync(aside, { recursive: true, force: true });
    else if (existsSync(aside)) {
      rmSync(ptyDir, { recursive: true, force: true });
      renameSync(aside, ptyDir);
      helper = makeSpawnHelperExecutable(ptyDir, world.platform);
    }
  }
  if (pty !== null) {
    const untrustedNote = untrusted === null ? ''
      : `${manifest} ${untrusted}, so Bun may not have run node-pty's install script at all. `;
    const linux = world.platform !== 'linux' ? '' : 'On Linux, its native part is built as it\'s installed, with ' +
      'python3, make and a C++ compiler; on Debian and Ubuntu, ' +
      `\`${world.hasSudo ? 'sudo ' : ''}apt install build-essential python3\` installs them, run ` +
      `${world.hasSudo ? 'by you if you can use sudo here, or by whoever administers this machine'
        : 'as root, by you or by whoever administers this machine'}. Then ${again}, which installs node-pty again. `;
    const mac = world.platform !== 'darwin' ? '' : helper === null
      ? 'On macOS, node-pty runs from binaries it ships prebuilt rather than building them, and this command makes ' +
        'their spawn-helper executable after each install, which node-pty\'s own install doesn\'t. '
      : `On macOS, node-pty runs from binaries it ships prebuilt, whose spawn-helper has to be executable, and ` +
        `${helper}. Run \`${line}\` again once that's put right, which installs node-pty again. `;
    err(`The resident's shell runs on node-pty, and here it doesn't work: ${pty.replace(/\.+$/, '')}. ` +
      `${world.platform === 'darwin' ? '' : untrustedNote}${linux}${mac}A resident without a shell needs none of this.`);
    return 1;
  }
  out(`A pty opens in ${dir}: node-pty ran /bin/echo in one, and what it printed came back. The resident's shell can ` +
    'run here. This command writes no recipe and sets up no service.');
  return 0;
}

// Setup writes Bun's default trusted list and the shell's package as trustedDependencies, which Bun reads in place of
// that list.
function notTrusted(manifest: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifest, 'utf-8'));
  } catch (error) {
    return `can't be read (${(error as Error).message})`;
  }
  const trusted = (parsed as { trustedDependencies?: unknown } | null)?.trustedDependencies;
  return Array.isArray(trusted) && trusted.includes(SHELL) ? null
    : `doesn't name ${SHELL} in its trustedDependencies`;
}

const PTY_CHECK = "let p;try{p=require('module').createRequire(require('fs').realpathSync('node_modules/term-sessions-mcp')+'/package.json')('node-pty')" +
  ".spawn('/bin/echo',['pty-ok'],{})}catch(e){console.error(String(e.message)" +
  ".split('\\n')[0]);process.exit(1)}let o='';p.onData(d=>{o+=d});p.onExit(()=>{if(o.includes('pty-ok'))process.exit(0);" +
  "console.error('a pty it opened gave back nothing');process.exit(1)})";

async function ptyWorks(world: ShellWorld, dir: string, env: Record<string, string>): Promise<string | null> {
  const ran = await world.run(['node', '-e', PTY_CHECK], { cwd: dir, env, timeoutMs: 30_000 });
  if (ran.status === 0) return null;
  const said = `${ran.stderr}${ran.stdout}`.trim().split('\n').at(-1);
  return said ? said : `node exited without saying why (${ended(ran)})`;
}
