import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { RESTART_EXIT_CODE, realOrResolved } from './contract.js';

interface ServiceUnit {
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
