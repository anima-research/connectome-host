import { spawn, spawnSync } from 'node:child_process';
import { constants, userInfo } from 'node:os';
import { createInterface, type Interface } from 'node:readline';
import { checkKey, type KeyCheck, type KeyCheckOptions } from './key-check.js';
import { lingerOf } from './linger.js';
import { dotenvNames } from './secrets.js';
import { askHidden as askHiddenOn } from './terminal-secret.js';

export interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
  startError?: { code?: string; message: string };
  timedOut?: boolean;
  signal?: NodeJS.Signals;
}

export interface RunOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
  show?: boolean;
}

export interface AgentLaunch {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface SetupWorld {
  terminal: boolean;
  platform: NodeJS.Platform;
  user: string;
  env: Record<string, string | undefined>;
  cwd: string;
  execArgv: string[];
  bun: { path: string; version: string };
  hasSudo: boolean;
  lingerOf(user: string): boolean | null;
  /** How the Mac's session check ended where it didn't exit 0, in ended()'s words, or null where it did. */
  macSession(): string | null;
  timeZone: string | undefined;
  userExists(user: string): boolean | null;
  ask(question: string): Promise<string | null>;
  askHidden(label: string): Promise<string | null>;
  run(argv: string[], options: RunOptions): Promise<Ran>;
  checkKey(options: KeyCheckOptions): Promise<KeyCheck>;
  startAgent(launch: AgentLaunch): Promise<number>;
}

export interface EnvFileWords {
  name: string;
  command: string;
  again: string;
  environment: string;
}

// Bun loads a file --env-file names into the process's own environment as it starts, where a name of it can't be told
// from one exported, so nothing of it can be kept from what that process runs.
export function envFileRefusal(world: Pick<SetupWorld, 'env' | 'execArgv'>, words: EnvFileWords): string[] | null {
  if (world.env.BUN_OPTIONS?.includes('--env-file')) {
    return [
      `${words.name}: BUN_OPTIONS holds --env-file, and Bun loads the file such a flag names into ${words.environment}. ` +
        `${words.again} without BUN_OPTIONS:`,
      `  env -u BUN_OPTIONS ${words.command}`,
      'or with only its --env-file taken out of BUN_OPTIONS.',
    ];
  }
  if (world.execArgv.some((word) => word === '--env-file' || word.startsWith('--env-file='))) {
    return [
      `${words.name}: Bun was started with --env-file, and loads the file it names into ${words.environment}. ` +
        `${words.again} without it:`,
      `  ${words.command}`,
    ];
  }
  return null;
}

// By name, since Bun puts in $NAME as it reads a dotenv file, so a value it read there needn't match the file's text.
export function withoutDotEnv(env: Record<string, string | undefined>, cwd: string): Record<string, string | undefined> {
  const names = new Set(dotenvNames(cwd));
  return Object.fromEntries(Object.entries(env).filter(([name]) => !names.has(name)));
}

export function withoutKeys(env: Record<string, string | undefined>, keys: string[]): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) if (value !== undefined && !keys.includes(name)) kept[name] = value;
  return kept;
}

// launchd loads the service's agents, which name no session type, only once their user has logged in to the Mac's
// graphical session, and that login creates the gui/<uid> domain this prints: it exits 0 only where there is one.
export const macSessionCheck = (): string[] => ['launchctl', 'print', `gui/${process.getuid!()}`];

export function ended(ran: Ran): string {
  if (ran.startError) return `it couldn't be started (${ran.startError.message})`;
  if (ran.signal) return `it was ended by ${ran.signal}`;
  return `exit ${ran.status}`;
}

export function realWorld(): SetupWorld {
  // One interface a question: readline holds the terminal raw while it's open, so Ctrl-C between questions, as
  // during an install, reaches setup as a signal.
  const question = async (asking: (rl: Interface) => Promise<string>): Promise<string | null> => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const gone = new Promise<null>((done) => rl.once('close', () => done(null)));
    try {
      return await Promise.race([asking(rl), gone]);
    } finally {
      rl.close();
    }
  };
  return {
    terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    platform: process.platform,
    user: userInfo().username,
    env: process.env,
    cwd: process.cwd(),
    execArgv: process.execArgv,
    bun: { path: process.execPath, version: Bun.version },
    hasSudo: Bun.which('sudo') !== null,
    lingerOf: (user) => lingerOf(user),
    macSession: () => {
      const [command, ...args] = macSessionCheck();
      const ran = spawnSync(command!, args, { stdio: 'ignore' });
      if (ran.status === 0) return null;
      const error = ran.error as NodeJS.ErrnoException | undefined;
      return ended({
        status: ran.status, stdout: '', stderr: '', signal: ran.signal ?? undefined,
        startError: error ? { code: error.code, message: error.message } : undefined,
      });
    },
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    userExists: (user) => {
      const found = spawnSync('getent', ['passwd', user], { stdio: 'ignore', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
      return found.status === 0 ? true : found.status === 2 ? false : null;
    },
    ask: (text) => question((rl) => new Promise((done) => rl.question(text, done))),
    askHidden: (label) => question((rl) => askHiddenOn(rl, process.stdout, label)),
    run: runProgram,
    checkKey,
    startAgent,
  };
}

function runProgram(argv: string[], options: RunOptions): Promise<Ran> {
  return new Promise((done) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: options.cwd, env: options.env, stdio: ['ignore', options.show ? 'inherit' : 'pipe', options.show ? 'inherit' : 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    let timedOut = false;
    const limit = options.timeoutMs === undefined ? null : setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, options.timeoutMs);
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (limit) clearTimeout(limit);
      done({ status: null, stdout, stderr, startError: { code: error.code, message: error.message } });
    });
    child.on('close', (code, signal) => {
      if (limit) clearTimeout(limit);
      done({
        status: timedOut ? null : code, stdout, stderr,
        ...(timedOut ? { timedOut } : signal === null ? {} : { signal }),
      });
    });
  });
}

function startAgent(launch: AgentLaunch): Promise<number> {
  return new Promise((done) => {
    // The terminal's Ctrl-C reaches every process in its foreground group, this one too.
    const keep = () => {};
    process.on('SIGINT', keep);
    const child = spawn(launch.argv[0]!, launch.argv.slice(1), { cwd: launch.cwd, env: launch.env, stdio: 'inherit' });
    child.on('error', (error) => {
      process.off('SIGINT', keep);
      process.stderr.write(`connectome setup: the agent's host couldn't be started: ${error.message}\n`);
      done(1);
    });
    child.on('close', (code, signal) => {
      process.off('SIGINT', keep);
      if (signal !== null) {
        process.stderr.write(`connectome setup: the agent's host was ended by ${signal}. Setup's answers and key are kept, ` +
          'so running setup again in this directory goes on.\n');
      }
      done(code ?? (signal === null ? 1 : 128 + (constants.signals[signal] ?? 0)));
    });
  });
}
