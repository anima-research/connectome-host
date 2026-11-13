import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { RESTART_EXIT_CODE, realOrResolved } from '../update/contract.js';
import type { Manager, ServiceUnit as UnitFile } from './service-unit.js';

export interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface ManagerSystem {
  platform: NodeJS.Platform;
  uid: number;
  home: string;
  env: Record<string, string | undefined>;
  run(command: string, args: string[], env: Record<string, string>): Ran;
}

const RESTART_ON = [String(RESTART_EXIT_CODE), '1'];

export interface ServiceUnit {
  id: string;
  scope: 'user' | 'system';
  file: string;
  settings: string;
  restarts: boolean;
}

export interface ServiceUnits {
  found: ServiceUnit[];
  unasked: string[];
  unresolved: Array<{ id: string; scope: 'user' | 'system' }>;
  defaulted: string[];
}

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
  const unresolved: ServiceUnits['unresolved'] = [];
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
        `--property=Id,WorkingDirectory,User,FragmentPath,${RESTART_PROPERTIES}`,
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
        unresolved.push({ id, scope: user ? 'user' : 'system' });
        continue;
      }
      let real: string;
      try {
        real = realOrResolved(set === '~' ? tilde : set);
      } catch {
        unresolved.push({ id, scope: user ? 'user' : 'system' });
        continue;
      }
      if (real !== here) continue;
      found.push({ id, scope: user ? 'user' : 'system', file: fields.get('FragmentPath') ?? '', ...restartPolicy(fields) });
    }
  }
  return { found, unasked, unresolved, defaulted };
}

export const RESTART_PROPERTIES = 'Restart,SuccessExitStatus,RestartPreventExitStatus,RestartForceExitStatus';

export function restartPolicy(fields: Map<string, string>): { settings: string; restarts: boolean } {
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
  return { settings, restarts: RESTART_ON.every(restartsOn) };
}

// Keep ownerOf's own: a unit in one of these states still holds its process, while stopping too.
const STOPPING = new Set(['active', 'activating', 'reloading', 'deactivating']);

export type Owner = { kind: 'ok' } | { kind: 'other'; runsIn: string | null; from: string; loadedOnly?: boolean } | { kind: 'untold' }
  | { kind: 'unshown'; shown: string };

export function ownerOf(unit: UnitFile, manager: Manager, work: string, sys: ManagerSystem,
  env: Record<string, string>): Owner {
  const text = readOr(unit.file);
  if (text !== null) {
    const runsIn = fileDirectory(sys, env, manager, unit, text);
    if (!runsHere(runsIn, work)) return { kind: 'other', runsIn, from: unit.file };
  }
  if (manager !== 'systemd-user') {
    if (text !== null) return { kind: 'ok' };
    const state = agentState(sys, env, unit);
    if (state.kind === 'unknown') return { kind: 'unshown', shown: `launchctl list ${unit.name} failed: ${state.why}` };
    return state.kind === 'unloaded' ? { kind: 'ok' } : { kind: 'untold' };
  }
  const shown = showUnit(sys, env, unit.name, ['LoadState', 'ActiveState', 'WorkingDirectory', 'FragmentPath']);
  if (typeof shown === 'string') return { kind: 'unshown', shown };
  if (shown.get('LoadState') === 'not-found') {
    return STOPPING.has(shown.get('ActiveState') ?? '') ? { kind: 'untold' } : { kind: 'ok' };
  }
  const runsIn = runsFrom(shown.get('WorkingDirectory') ?? '', sys.home);
  return runsHere(runsIn, work) ? { kind: 'ok' }
    : { kind: 'other', runsIn, from: shown.get('FragmentPath') || unit.file, loadedOnly: text !== null };
}

export function runsHere(directory: string | null, work: string): boolean {
  return directory !== null && realOrResolved(directory) === realOrResolved(work);
}

export function fileDirectory(sys: ManagerSystem, env: Record<string, string>, manager: Manager,
  unit: UnitFile, text: string): string | null {
  const set = manager === 'systemd-user'
    ? [...text.matchAll(/^WorkingDirectory=(.*)$/gm)].at(-1)?.[1]?.replace(/^-/, '').replace(/%%/g, '%') ?? null
    : plistField(sys, env, unit.file, 'WorkingDirectory');
  return set === null || set === '' ? null : realOrResolved(set === '~' ? sys.home : set);
}

function plistField(sys: ManagerSystem, env: Record<string, string>, path: string, key: string): string | null {
  const type = sys.run('plutil', ['-type', key, path], env);
  if (type.status !== 0) {
    const lint = sys.run('plutil', ['-lint', path], env);
    if (lint.status !== 0) throw new Error(lint.stderr.trim() || lint.stdout.trim() || `plutil exited with ${lint.status}`);
    return null;
  }
  if (type.stdout !== 'string\n') return null;
  const raw = sys.run('plutil', ['-extract', key, 'raw', '-o', '-', path], env);
  if (raw.status !== 0) throw new Error(raw.stderr.trim() || raw.stdout.trim() || `plutil exited with ${raw.status}`);
  // plutil raw adds one LF; spaces and any newline in the value itself remain part of that value.
  return raw.stdout.replace(/\n$/, '');
}

/** systemctl show (systemd 257) gives WorkingDirectory=-/x as !/x, ~ as ~, and an unset one under the user manager as
 *  ! and the home, its default. */
export function runsFrom(shown: string, home: string): string | null {
  const set = shown.replace(/^[-!+@:]+/, '');
  if (set === '' || (shown.startsWith('!') && realOrResolved(set) === realOrResolved(home))) return null;
  return realOrResolved(set === '~' ? home : set);
}

export type AgentState = { kind: 'unloaded' } | { kind: 'loaded'; exit?: string } |
  { kind: 'running'; pid: string } | { kind: 'unknown'; why: string };

export function agentState(sys: ManagerSystem, env: Record<string, string>, unit: UnitFile): AgentState {
  const listed = sys.run('launchctl', ['list', unit.name], env);
  if (listed.status === 113) return { kind: 'unloaded' };
  if (listed.status !== 0) return { kind: 'unknown', why: launchctlFailure(listed) };
  const pid = pidOf(listed.stdout);
  return pid === undefined
    ? { kind: 'loaded', exit: /"LastExitStatus"\s*=\s*(-?\d+);/.exec(listed.stdout)?.[1] }
    : { kind: 'running', pid };
}

function pidOf(listed: string): string | undefined {
  return /"PID"\s*=\s*(\d+);/.exec(listed)?.[1];
}

export function launchctlFailure(ran: Ran): string {
  return stderrOf({ ...ran, stderr: ran.stderr.split('\n').filter((line) =>
    line.trim() !== 'Try re-running the command as root for richer errors.').join('\n') });
}

export function showUnit(sys: ManagerSystem, env: Record<string, string>, name: string,
  properties: string[]): Map<string, string> | string {
  const ran = sys.run('systemctl', ['--user', 'show', `--property=${properties.join(',')}`, '--', name], env);
  if (ran.status !== 0) {
    return `systemd couldn't be asked about ${name}: ${stderrOf(ran)} ` +
      `(${systemctlLine(sys, `show ${name}`)})`;
  }
  return new Map(ran.stdout.split('\n').filter((line) => line.includes('='))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
}

export function stateOf(shown: Map<string, string>): string {
  const [active, sub] = [shown.get('ActiveState') || '?', shown.get('SubState') || '?'];
  return sub === active ? active : `${active} (${sub})`;
}

export function stderrOf(ran: Ran): string {
  return (ran.stderr.trim() || `exit ${ran.status}`).replace(/\.$/, '');
}

export function systemctlLine(sys: Pick<ManagerSystem, 'env' | 'uid'>, args: string): string {
  return `${sys.env.XDG_RUNTIME_DIR ? '' : `XDG_RUNTIME_DIR=/run/user/${sys.uid} `}systemctl --user ${args}`;
}

export function childEnv(sys: ManagerSystem): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(sys.env)) if (value !== undefined) env[key] = value;
  if (sys.platform === 'linux' && !env.XDG_RUNTIME_DIR) env.XDG_RUNTIME_DIR = `/run/user/${sys.uid}`;
  return env;
}

export function readOr(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
