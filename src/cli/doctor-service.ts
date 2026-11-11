import { statSync } from 'node:fs';
import { join } from 'node:path';
import { RESTART_EXIT_CODE, SUPERVISED_ENV } from '../update/contract.js';
import { RESTART_PROPERTIES, restartPolicy } from '../update/setup.js';
import { agentState, childEnv, runsFrom, runsHere, showUnit, type ServiceSystem } from './service.js';
import type { ServiceUnit, ServiceUnits } from './service-unit.js';

export interface ServiceCheck {
  passed: boolean;
  lines: string[];
  stopped?: true;
}

const RUNNING = new Set(['active', 'activating', 'deactivating', 'reloading', 'refreshing']);

/** The units install writes for this directory, as their manager shows them. A shell unit is expected where the
 *  recipe names a shell. No log text is quoted: each unit that isn't running names the manager's line that shows it. */
export function checkUnits(units: ServiceUnits, work: string, shell: boolean, cmd: string, sys: ServiceSystem,
  stoppedIsFine = false): ServiceCheck {
  const lines: string[] = [];
  let passed = true;
  const fail = (line: string) => {
    passed = false;
    lines.push(line);
  };
  const install = `\`${cmd} service install <recipe>\``;
  const expected = shell ? [units.host, units.shell] : [units.host];
  let unseen = 0;
  for (const unit of expected) {
    const state = pathState(unit.file);
    if (state === 'there') continue;
    unseen += 1;
    const lead = unit === units.shell ? 'The recipe names a shell, and ' : '';
    const named = `${unit.file}, ${unit.name}'s ${units.manager === 'systemd-user' ? 'unit file' : 'plist'}`;
    fail(state === 'gone' ? `${lead}${named}, is gone. ${install} writes it.`
      : `${lead}${named}, can't be looked at, so whether it's there can't be told: ${state.why}. ${state.repair}`);
  }
  if (!shell && pathState(units.shell.file) === 'there') {
    lines.push(`The recipe names no shell, and ${units.shell.name} is installed: ${install} stops and removes it.`);
  }
  const env = childEnv(sys);
  if (units.manager === 'systemd-user') {
    const shownAll = expected.map((unit) => showUnit(sys, env, unit.name, ['LoadState', 'ActiveState', 'SubState',
      'NRestarts', 'ExecMainStatus', 'ExecMainStartTimestamp', 'Environment', 'WorkingDirectory', 'ConditionResult',
      'ConditionTimestamp', RESTART_PROPERTIES]));
    const skipped = (shown: Map<string, string>): boolean =>
      shown.get('ConditionResult') === 'no' && (shown.get('ConditionTimestamp') ?? '') !== '';
    const stopped = stoppedIsFine && unseen === 0 && shownAll.every((shown) => typeof shown !== 'string' &&
      shown.get('LoadState') === 'loaded' && shown.get('ActiveState') === 'inactive' && !skipped(shown));
    for (const [index, unit] of expected.entries()) {
      const shown = shownAll[index]!;
      if (typeof shown === 'string') {
        fail(`${shown}.`);
        continue;
      }
      const journal = `journalctl --user -u ${unit.name} shows its log`;
      if (shown.get('LoadState') !== 'loaded') {
        fail(RUNNING.has(shown.get('ActiveState') ?? '')
          ? `${unit.name} is running, but systemd can't load its unit (${shown.get('LoadState') ?? 'no load state'}), so ` +
            `which install it runs can't be told. If it's this install's, stop it, then run ${install}.`
          : `systemd has no ${unit.name} loaded (${shown.get('LoadState') ?? 'no load state'}): ${install} writes it.`);
        continue;
      }
      const state = stateOf(shown);
      const active = shown.get('ActiveState') === 'active';
      const restarts = Number(shown.get('NRestarts') ?? '0');
      const restarted = `systemd has restarted it ${restarts} time${restarts === 1 ? '' : 's'} since it was last started`;
      if (active && restarts > 0) {
        lines.push(`${unit.name} is ${state} again: ${restarted}, and ${journal}.`);
      } else if (active) {
        lines.push(`${unit.name} is ${state}.`);
      } else {
        if (skipped(shown)) {
          fail(`${unit.name} is ${state}: systemd skipped its last start, since a condition its unit or a drop-in sets ` +
            `wasn't met: \`systemctl --user status ${unit.name}\` names it.`);
        } else if (stopped) {
          lines.push(`${unit.name} is stopped: systemd shows it ${state}.`);
        } else {
          fail(`${unit.name} is ${state}, not active: ${journal}.`);
        }
        const exited = (shown.get('ExecMainStartTimestamp') ?? '') === '' ? ''
          : `, and its process last exited with ${shown.get('ExecMainStatus') ?? '?'}`;
        lines.push(restarts > 0 ? `${restarted}${exited}.` : `systemd hasn't restarted it since it was last started${exited}.`);
      }
      if (unit !== units.host) continue;
      const policy = restartPolicy(shown);
      if (!runsHere(runsFrom(shown.get('WorkingDirectory') ?? '', sys.home), work)) {
        fail(`systemd runs ${unit.name} in ${shown.get('WorkingDirectory') || 'no set directory'}, not ${work}.`);
      } else if (policy.restarts) {
        lines.push(`It restarts the host when it exits with ${RESTART_EXIT_CODE} and with 1 (${policy.settings}).`);
      } else {
        fail(`It doesn't restart the host both when it exits with ${RESTART_EXIT_CODE} and with 1 (${policy.settings}).`);
      }
      if (new RegExp(`(^|\\s)${SUPERVISED_ENV}=1(\\s|$)`).test(shown.get('Environment') ?? '')) {
        lines.push(`Its unit sets ${SUPERVISED_ENV}=1.`);
      } else {
        fail(`Its unit doesn't set ${SUPERVISED_ENV}=1: ${install} sets it once systemd shows the unit restarts the ` +
          `host on ${RESTART_EXIT_CODE} and 1.`);
      }
    }
    return { passed, lines, ...(stopped && passed ? { stopped: true as const } : {}) };
  }
  const states = expected.map((unit) => agentState(sys, env, unit));
  const stopped = stoppedIsFine && unseen === 0 && states.every((state) => state.kind === 'unloaded');
  for (const [index, unit] of expected.entries()) {
    const state = states[index]!;
    if (stopped) lines.push(`${unit.name} is stopped: launchd has it unloaded.`);
    else if (state.kind === 'unknown') fail(`Whether launchd has ${unit.name} loaded can't be told: ${state.why}.`);
    else if (state.kind === 'unloaded') fail(`launchd has no ${unit.name} loaded.`);
    else if (state.kind === 'running') lines.push(`${unit.name} is running, pid ${state.pid}.`);
    else {
      fail(`${unit.name} is loaded but not running${state.exit === undefined ? '' : `; it last exited with ${state.exit}`}. ` +
        `Its log is ${logOf(units, unit, work)}.`);
    }
  }
  return { passed, lines, ...(stopped && passed ? { stopped: true as const } : {}) };
}

/** The pid of the host unit's main process, 0 where it has none. */
export function servicePid(units: ServiceUnits, sys: ServiceSystem): { pid: string } | { why: string } {
  const env = childEnv(sys);
  if (units.manager === 'systemd-user') {
    const shown = showUnit(sys, env, units.host.name, ['MainPID']);
    return typeof shown === 'string' ? { why: shown } : { pid: shown.get('MainPID') ?? '0' };
  }
  const state = agentState(sys, env, units.host);
  if (state.kind === 'unknown') return { why: state.why };
  return { pid: state.kind === 'running' ? state.pid : '0' };
}

function logOf(units: ServiceUnits, unit: ServiceUnit, work: string): string {
  return join(work, 'logs', unit === units.host ? 'agent.log' : 'shell.log');
}

function stateOf(shown: Map<string, string>): string {
  const [active, sub] = [shown.get('ActiveState') || '?', shown.get('SubState') || '?'];
  return sub === active ? active : `${active} (${sub})`;
}

export function pathState(path: string): 'there' | 'gone' | { why: string; repair: string } {
  try {
    statSync(path);
    return 'there';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'gone';
    return {
      why: errorText(error).replace(/\.$/, ''),
      repair: code === 'EACCES' || code === 'EPERM'
        ? 'Give this user search on each directory on the way to it, and run this again.'
        : 'Repair what that path runs through, and run this again.',
    };
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
