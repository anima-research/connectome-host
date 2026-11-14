import { readFileSync } from 'node:fs';
import { realOrResolved } from '../update/contract.js';
import type { Manager, ServiceUnit } from './service-unit.js';

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

// Keep ownerOf's own: a unit in one of these states still holds its process, while stopping too.
const STOPPING = new Set(['active', 'activating', 'reloading', 'deactivating']);

export type Owner = { kind: 'ok' } | { kind: 'other'; runsIn: string | null; from: string; loadedOnly?: boolean } | { kind: 'untold' }
  | { kind: 'unshown'; shown: string };

export function ownerOf(unit: ServiceUnit, manager: Manager, work: string, sys: ManagerSystem,
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
  unit: ServiceUnit, text: string): string | null {
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

export function agentState(sys: ManagerSystem, env: Record<string, string>, unit: ServiceUnit): AgentState {
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
