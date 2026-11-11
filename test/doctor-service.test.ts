import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkUnits, servicePid } from '../src/cli/doctor-service.js';
import type { ServiceSystem } from '../src/cli/service.js';
import { serviceUnits, type ServiceUnits } from '../src/cli/service-unit.js';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const RESTARTS = 'Restart=on-failure\nSuccessExitStatus=\nRestartPreventExitStatus=\nRestartForceExitStatus=';

function place(platform: NodeJS.Platform, files: Array<'host' | 'shell'>): { units: ServiceUnits; home: string; work: string } {
  const home = mkdtempSync(join(tmpdir(), 'doctor-service-home-'));
  const work = mkdtempSync(join(tmpdir(), 'doctor-service-work-'));
  made.push(home, work);
  const units = serviceUnits(join(work, 'connectome-host'), platform, home)!;
  for (const which of files) {
    mkdirSync(join(units[which].file, '..'), { recursive: true });
    writeFileSync(units[which].file, 'written by install');
  }
  return { units, home, work };
}

function system(home: string, answers: Record<string, string | { status: number; stdout?: string }>):
  { sys: ServiceSystem; asked: string[][] } {
  const asked: string[][] = [];
  const sys = {
    platform: 'linux', user: 'person', uid: 1000, home, cwd: home, env: {}, bun: '/bin/bun',
    run(command: string, args: string[]) {
      asked.push([command, ...args]);
      const key = `${command} ${args[args.length - 1]}`;
      const answer = answers[key];
      if (answer === undefined) return { status: 1, stdout: '', stderr: `no stand-in for ${key}` };
      return typeof answer === 'string' ? { status: 0, stdout: answer, stderr: '' }
        : { status: answer.status, stdout: answer.stdout ?? '', stderr: '' };
    },
  } as unknown as ServiceSystem;
  return { sys, asked };
}

const shown = (fields: Record<string, string>) => `${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join('\n')}\n${RESTARTS}\n`;

const activeHost = (work: string) => shown({
  LoadState: 'loaded', ActiveState: 'active', SubState: 'running', NRestarts: '0', ExecMainStatus: '0',
  ExecMainStartTimestamp: 'Wed 2026-11-11 10:00:00 UTC', Environment: 'PATH=/usr/bin CONNECTOME_SUPERVISED=1',
  WorkingDirectory: work, ConditionResult: 'yes', ConditionTimestamp: 'Wed 2026-11-11 10:00:00 UTC',
});

test('an active host unit that runs here, restarts on 75 and 1 and sets the supervised line passes, with no shell expected', () => {
  const at = place('linux', ['host']);
  const { sys } = system(at.home, { [`systemctl ${at.units.host.name}`]: activeHost(at.work) });
  const result = checkUnits(at.units, at.work, false, 'connectome', sys);
  expect(result.passed).toBe(true);
  expect(result.lines.join('\n')).toContain(`${at.units.host.name} is active (running).`);
  expect(result.lines.join('\n')).toContain('It restarts the host when it exits with 75 and with 1');
  expect(result.lines.join('\n')).toContain('Its unit sets CONNECTOME_SUPERVISED=1.');
});

test('a host unit file that is gone fails, naming the file and the install that writes it', () => {
  const at = place('linux', []);
  const { sys } = system(at.home, { [`systemctl ${at.units.host.name}`]: activeHost(at.work) });
  const result = checkUnits(at.units, at.work, false, 'connectome', sys);
  expect(result.passed).toBe(false);
  expect(result.lines.join('\n')).toContain(`${at.units.host.file}, ${at.units.host.name}'s unit file, is gone.`);
  expect(result.lines.join('\n')).toContain('connectome service install <recipe>');
});

test('a recipe that names a shell with no shell unit fails, and a shell unit the recipe doesn\'t name is said to go at the next install', () => {
  const expected = place('linux', ['host']);
  const one = system(expected.home, { [`systemctl ${expected.units.host.name}`]: activeHost(expected.work) });
  const missing = checkUnits(expected.units, expected.work, true, 'connectome', one.sys);
  expect(missing.passed).toBe(false);
  expect(missing.lines.join('\n')).toContain(`The recipe names a shell, and ${expected.units.shell.file}, ` +
    `${expected.units.shell.name}'s unit file, is gone.`);

  const extra = place('linux', ['host', 'shell']);
  const two = system(extra.home, { [`systemctl ${extra.units.host.name}`]: activeHost(extra.work) });
  const kept = checkUnits(extra.units, extra.work, false, 'connectome', two.sys);
  expect(kept.passed).toBe(true);
  expect(kept.lines.join('\n')).toContain(`The recipe names no shell, and ${extra.units.shell.name} is installed: ` +
    '`connectome service install <recipe>` stops and removes it.');
});

test('a host that failed fails with the journal line to read, and no log text is quoted', () => {
  const at = place('linux', ['host']);
  const { sys, asked } = system(at.home, {
    [`systemctl ${at.units.host.name}`]: activeHost(at.work).replace('ActiveState=active', 'ActiveState=failed')
      .replace('SubState=running', 'SubState=failed').replace('ExecMainStatus=0', 'ExecMainStatus=1'),
  });
  const result = checkUnits(at.units, at.work, false, 'connectome', sys);
  expect(result.passed).toBe(false);
  expect(result.lines.join('\n')).toContain(`${at.units.host.name} is failed, not active: journalctl --user -u ` +
    `${at.units.host.name} shows its log.`);
  expect(asked.filter(([command]) => command === 'journalctl')).toEqual([]);
});

test('every expected unit loaded and inactive reads as stopped where doctor asks, and fails otherwise', () => {
  const at = place('linux', ['host']);
  const inactive = activeHost(at.work).replace('ActiveState=active', 'ActiveState=inactive').replace('SubState=running', 'SubState=dead');
  const { sys } = system(at.home, { [`systemctl ${at.units.host.name}`]: inactive });
  const stopped = checkUnits(at.units, at.work, false, 'connectome', sys, true);
  expect(stopped).toEqual({ passed: true, lines: expect.arrayContaining([`${at.units.host.name} is stopped: systemd shows it inactive (dead).`]), stopped: true });
  expect(checkUnits(at.units, at.work, false, 'connectome', sys).passed).toBe(false);
});

test('a host unit that runs in another directory fails, naming both', () => {
  const at = place('linux', ['host']);
  const { sys } = system(at.home, { [`systemctl ${at.units.host.name}`]: activeHost('/somewhere/else') });
  const result = checkUnits(at.units, at.work, false, 'connectome', sys);
  expect(result.passed).toBe(false);
  expect(result.lines.join('\n')).toContain(`systemd runs ${at.units.host.name} in /somewhere/else, not ${at.work}.`);
});

test('under launchd a running host passes, one loaded but not running fails with its log file, and all unloaded is stopped', () => {
  const at = place('darwin', ['host']);
  const running = system(at.home, { [`launchctl ${at.units.host.name}`]: '{\n\t"PID" = 501;\n};\n' });
  const ok = checkUnits(at.units, at.work, false, 'connectome', running.sys);
  expect(ok.passed).toBe(true);
  expect(ok.lines).toContain(`${at.units.host.name} is running, pid 501.`);

  const exited = system(at.home, { [`launchctl ${at.units.host.name}`]: '{\n\t"LastExitStatus" = 256;\n};\n' });
  const failed = checkUnits(at.units, at.work, false, 'connectome', exited.sys);
  expect(failed.passed).toBe(false);
  expect(failed.lines.join('\n')).toContain(`${at.units.host.name} is loaded but not running; it last exited with 256. ` +
    `Its log is ${join(at.work, 'logs', 'agent.log')}.`);

  const unloaded = system(at.home, { [`launchctl ${at.units.host.name}`]: { status: 113 } });
  expect(checkUnits(at.units, at.work, false, 'connectome', unloaded.sys, true).stopped).toBe(true);
});

test('the service\'s pid is its host unit\'s main process, under systemd and launchd', () => {
  const linux = place('linux', ['host']);
  expect(servicePid(linux.units, system(linux.home, { [`systemctl ${linux.units.host.name}`]: 'MainPID=4242\n' }).sys))
    .toEqual({ pid: '4242' });
  const mac = place('darwin', ['host']);
  expect(servicePid(mac.units, system(mac.home, { [`launchctl ${mac.units.host.name}`]: { status: 113 } }).sys))
    .toEqual({ pid: '0' });
});
