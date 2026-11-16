import { spawn, spawnSync } from 'node:child_process';
import { constants, userInfo } from 'node:os';
import { createInterface, type Interface } from 'node:readline';
import { checkKey, type KeyCheck } from './key-check.js';
import { lingerOf } from './linger.js';
import { askHidden } from './terminal-secret.js';

export interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
  startError?: string;
  timedOut?: boolean;
}

export interface RunOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
  /** The program's output goes to the person's terminal, not into Ran. */
  show?: boolean;
}

export interface AgentLaunch {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
}

/** What setup reads of the machine and does on it, so a test can give it another. */
export interface SetupWorld {
  terminal: boolean;
  platform: NodeJS.Platform;
  user: string;
  env: Record<string, string | undefined>;
  cwd: string;
  bun: { path: string; version: string };
  hasSudo: boolean;
  lingerOf(user: string): boolean | null;
  /** null while the user is logged in to the Mac's graphical session, and what the check gave otherwise. */
  macSession(): string | null;
  timeZone: string | undefined;
  userExists(user: string): boolean | null;
  ask(question: string): Promise<string | null>;
  askHidden(label: string): Promise<string | null>;
  run(argv: string[], options: RunOptions): Promise<Ran>;
  checkKey(options: { key: string; model: string; baseUrl?: string }): Promise<KeyCheck>;
  startAgent(launch: AgentLaunch): Promise<number>;
}

// launchd loads the service's agents only once their user has logged in to the Mac's graphical session, and that
// login makes the gui/<uid> domain this prints: it exits 0 only where there is one.
export const macSessionCheck = (): string[] => ['launchctl', 'print', `gui/${process.getuid!()}`];

export function ended(ran: Ran): string {
  if (ran.startError !== undefined) return `it couldn't be started (${ran.startError})`;
  if (ran.timedOut) return 'it ran past its time limit and was stopped';
  return `exit ${ran.status}`;
}

export function withoutKeys(env: Record<string, string | undefined>, keys: readonly string[]): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) if (value !== undefined && !keys.includes(name)) kept[name] = value;
  return kept;
}

export function realWorld(): SetupWorld {
  // One interface a question: readline holds the terminal raw while it's open, so a Ctrl-C between questions, as
  // during an install, reaches setup as a signal.
  const question = async (asking: (rl: Interface) => Promise<string | null>): Promise<string | null> => {
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
    bun: { path: process.execPath, version: Bun.version },
    hasSudo: Bun.which('sudo') !== null,
    lingerOf: (user) => lingerOf(user),
    macSession: () => {
      const [command, ...args] = macSessionCheck();
      const ran = spawnSync(command!, args, { stdio: 'ignore' });
      return ran.status === 0 ? null : ran.error ? ran.error.message : `exit ${ran.status ?? ran.signal}`;
    },
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    userExists: (user) => {
      const found = spawnSync('getent', ['passwd', user], { stdio: 'ignore' });
      return found.status === 0 ? true : found.status === 2 ? false : null;
    },
    ask: (text) => question((rl) => new Promise((done) => rl.question(text, done))),
    askHidden: (label) => question((rl) => askHidden(rl, process.stdout, label)),
    run: runProgram,
    checkKey: (options) => checkKey(options),
    startAgent,
  };
}

function runProgram(argv: string[], options: RunOptions): Promise<Ran> {
  return new Promise((done) => {
    const pipe = options.show ? 'inherit' : 'pipe';
    const child = spawn(argv[0]!, argv.slice(1), { cwd: options.cwd, env: options.env, stdio: ['ignore', pipe, pipe] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    let timedOut = false;
    const limit = options.timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);
    child.on('error', (error) => {
      clearTimeout(limit);
      done({ status: null, stdout, stderr, startError: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(limit);
      done({ status: code, stdout, stderr, ...(timedOut ? { timedOut } : {}) });
    });
  });
}

function startAgent(launch: AgentLaunch): Promise<number> {
  return new Promise((done) => {
    // A Ctrl-C that the terminal sends as a signal reaches this process as well as the agent's host, and setup waits
    // for the host to end.
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
      done(code ?? 128 + (constants.signals[signal!] ?? 0));
    });
  });
}
