import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

function system(home: string, answers: Record<string, string | { status: number; stdout?: string; stderr?: string }>):
  { sys: ServiceSystem; asked: string[][] } {
  const asked: string[][] = [];
  const sys = {
    platform: 'linux', user: 'person', uid: 1000, home, cwd: home, env: {}, bun: '/bin/bun',
    run(command: string, args: string[]) {
      asked.push([command, ...args]);
      if ((command === 'systemctl' && (args[0] !== '--user' || args[1] !== 'show')) || (command === 'launchctl' && args[0] !== 'list')) {
        return { status: 1, stdout: '', stderr: `the stand-in answers only systemctl --user show and launchctl list, not ${command} ${args.join(' ')}` };
      }
      const key = `${command} ${args[args.length - 1]}`;
      const answer = answers[key];
      if (answer === undefined) return { status: 1, stdout: '', stderr: `no stand-in for ${key}` };
      if (typeof answer !== 'string') return { status: answer.status, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' };
      const asks = command === 'systemctl' ? args.find((arg) => arg.startsWith('--property='))?.slice('--property='.length) : undefined;
      if (asks === undefined) return { status: 0, stdout: answer, stderr: '' };
      const wanted = new Set(asks.split(','));
      return { status: 0, stdout: answer.split('\n').filter((line) => wanted.has(line.slice(0, line.indexOf('=')))).join('\n') + '\n', stderr: '' };
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
  expect(result.here).toBe(true);
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
  const one = system(expected.home, {
    [`systemctl ${expected.units.host.name}`]: activeHost(expected.work),
    [`systemctl ${expected.units.shell.name}`]: 'LoadState=not-found\nActiveState=inactive\n',
  });
  const missing = checkUnits(expected.units, expected.work, true, 'connectome', one.sys);
  expect(missing.passed).toBe(false);
  expect(missing.lines).toContain(`The recipe names a shell, and ${expected.units.shell.file}, ` +
    `${expected.units.shell.name}'s unit file, is gone. \`connectome service install <recipe>\` writes it, or names what it ` +
    'needs first.');
  expect(missing.here).toBe(true);
  expect(missing.lines).toContain(`systemd has no ${expected.units.shell.name} loaded (not-found): \`connectome service ` +
    'install <recipe>\` writes it, or names what it needs first.');

  const extra = place('linux', ['host', 'shell']);
  const two = system(extra.home, {
    [`systemctl ${extra.units.host.name}`]: activeHost(extra.work),
    [`systemctl ${extra.units.shell.name}`]: activeHost(extra.work),
  });
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
  expect(stopped).toEqual({ passed: true, lines: expect.arrayContaining([`${at.units.host.name} is stopped: systemd shows it inactive (dead).`]), stopped: true,
    here: true });
  expect(checkUnits(at.units, at.work, false, 'connectome', sys).passed).toBe(false);
});

test('a host unit that runs in another directory fails, naming both', () => {
  const at = place('linux', ['host']);
  const { sys } = system(at.home, { [`systemctl ${at.units.host.name}`]: activeHost('/somewhere/else') });
  const result = checkUnits(at.units, at.work, false, 'connectome', sys);
  expect(result.passed).toBe(false);
  expect(result.lines.join('\n')).toContain(`systemd runs ${at.units.host.name} in /somewhere/else, not ${at.work}.`);
  expect([result.elsewhere, result.here]).toEqual([true, undefined]);
});

const reloads = (name: string, work: string) => `systemd shows ${name} as it last loaded it, while its file names ` +
  `${work}: if its file or drop-ins changed since, XDG_RUNTIME_DIR=/run/user/1000 systemctl --user daemon-reload loads ` +
  'them again, then run `connectome service install <recipe>`.';

test('a host unit systemd runs in another directory while its file is there says how to load the file again', () => {
  const at = place('linux', ['host']);
  const { sys } = system(at.home, { [`systemctl ${at.units.host.name}`]: activeHost('/somewhere/else') });
  const result = checkUnits(at.units, at.work, false, 'connectome', sys);
  expect(result.lines).toContain(`systemd runs ${at.units.host.name} in /somewhere/else, not ${at.work}. ` +
    reloads(at.units.host.name, at.work));
});

test('a host unit that doesn\'t restart the host on 75 and 1 names the command that shows every file it\'s read from', () => {
  const at = place('linux', ['host']);
  const { sys } = system(at.home, {
    [`systemctl ${at.units.host.name}`]: activeHost(at.work).replace('Restart=on-failure', 'Restart=no'),
  });
  const result = checkUnits(at.units, at.work, false, 'connectome', sys);
  expect(result.passed).toBe(false);
  expect(result.lines.find((line) => line.startsWith('It doesn\'t restart the host'))).toEndWith('. A drop-in may override ' +
    `the unit: XDG_RUNTIME_DIR=/run/user/1000 systemctl --user cat ${at.units.host.name} shows every file it's read from.`);
});

test('a shell unit systemd runs in another directory fails as install refuses it, whether or not the recipe names a shell', () => {
  const at = place('linux', ['host', 'shell']);
  const { sys } = system(at.home, {
    [`systemctl ${at.units.host.name}`]: activeHost(at.work),
    [`systemctl ${at.units.shell.name}`]: activeHost('/elsewhere'),
  });
  const line = `systemd runs ${at.units.shell.name} in /elsewhere, not ${at.work}. ${reloads(at.units.shell.name, at.work)}`;
  const named = checkUnits(at.units, at.work, true, 'connectome', sys);
  expect([named.passed, named.elsewhere]).toEqual([false, undefined]);
  expect(named.lines).toContain(line);
  const unnamed = checkUnits(at.units, at.work, false, 'connectome', sys);
  expect(unnamed.passed).toBe(false);
  expect(unnamed.lines).toContain(line);
  expect(unnamed.lines.join('\n')).not.toContain('stops and removes it');
});

test('a host unit systemd can\'t show, or hasn\'t loaded, isn\'t seen running here', () => {
  const at = place('linux', ['host']);
  const unshown = system(at.home, {});
  expect(checkUnits(at.units, at.work, false, 'connectome', unshown.sys).here).toBeUndefined();
  const unloaded = system(at.home, { [`systemctl ${at.units.host.name}`]: 'LoadState=not-found\nActiveState=active\n' });
  expect(checkUnits(at.units, at.work, false, 'connectome', unloaded.sys).here).toBeUndefined();
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

const stoppedHost = (work: string) => activeHost(work).replace('ActiveState=active', 'ActiveState=inactive')
  .replace('SubState=running', 'SubState=dead');
const shellShown = (work: string, active: string, sub: string) => shown({
  LoadState: 'loaded', ActiveState: active, SubState: sub, NRestarts: '0', ExecMainStatus: '0', ExecMainStartTimestamp: '',
  WorkingDirectory: work, ConditionResult: 'yes', ConditionTimestamp: '',
});

test('a host and its shell both stopped read as stopped where doctor asks, each said so, and fail the check that doesn\'t ask', () => {
  const at = place('linux', ['host', 'shell']);
  const { sys } = system(at.home, {
    [`systemctl ${at.units.host.name}`]: stoppedHost(at.work),
    [`systemctl ${at.units.shell.name}`]: shellShown(at.work, 'inactive', 'dead'),
  });
  const fine = checkUnits(at.units, at.work, true, 'connectome', sys, true);
  expect([fine.passed, fine.stopped]).toEqual([true, true]);
  expect(fine.lines).toContain(`${at.units.host.name} is stopped: systemd shows it inactive (dead).`);
  expect(fine.lines).toContain(`${at.units.shell.name} is stopped: systemd shows it inactive (dead).`);
  const strict = checkUnits(at.units, at.work, true, 'connectome', sys);
  expect([strict.passed, strict.stopped]).toEqual([false, undefined]);
});

test('one unit stopped while another runs fails even where stopped is fine, naming the journal line of the stopped one', () => {
  const at = place('linux', ['host', 'shell']);
  const { sys } = system(at.home, {
    [`systemctl ${at.units.host.name}`]: activeHost(at.work),
    [`systemctl ${at.units.shell.name}`]: shellShown(at.work, 'inactive', 'dead'),
  });
  const fine = checkUnits(at.units, at.work, true, 'connectome', sys, true);
  expect([fine.passed, fine.stopped]).toEqual([false, undefined]);
  expect(fine.lines).toContain(`${at.units.shell.name} is inactive (dead), not active: journalctl --user -u ` +
    `${at.units.shell.name} shows its log.`);
  expect(fine.lines.join('\n')).not.toContain('is stopped');
});

test('a failed unit fails even where stopped is fine', () => {
  const at = place('linux', ['host', 'shell']);
  const { sys } = system(at.home, {
    [`systemctl ${at.units.host.name}`]: stoppedHost(at.work),
    [`systemctl ${at.units.shell.name}`]: shellShown(at.work, 'failed', 'failed'),
  });
  const fine = checkUnits(at.units, at.work, true, 'connectome', sys, true);
  expect([fine.passed, fine.stopped]).toEqual([false, undefined]);
  expect(fine.lines.join('\n')).toContain(`${at.units.shell.name} is failed, not active`);
});

test('a stopped service whose check finds a fault isn\'t stopped, so nothing promises that starting it will do', () => {
  const at = place('linux', ['host']);
  const { sys } = system(at.home, { [`systemctl ${at.units.host.name}`]: stoppedHost('/srv/other/My Resident') });
  const fine = checkUnits(at.units, at.work, false, 'connectome', sys, true);
  expect([fine.passed, fine.stopped]).toEqual([false, undefined]);
  expect(fine.lines.join('\n')).toContain(`systemd runs ${at.units.host.name} in /srv/other/My Resident, not ${at.work}.`);
});

test('a unit file that\'s gone leaves a stopped service not stopped, under systemd and launchd', () => {
  const linux = place('linux', []);
  const one = system(linux.home, { [`systemctl ${linux.units.host.name}`]: stoppedHost(linux.work) });
  const systemd = checkUnits(linux.units, linux.work, false, 'connectome', one.sys, true);
  expect([systemd.passed, systemd.stopped]).toEqual([false, undefined]);
  expect(systemd.lines.join('\n')).toContain(`${linux.units.host.file}, ${linux.units.host.name}'s unit file, is gone.`);
  expect(systemd.lines.join('\n')).not.toContain('is stopped');
  const mac = place('darwin', []);
  const two = system(mac.home, { [`launchctl ${mac.units.host.name}`]: { status: 113 } });
  const launchd = checkUnits(mac.units, mac.work, false, 'connectome', two.sys, true);
  expect([launchd.passed, launchd.stopped]).toEqual([false, undefined]);
  expect(launchd.lines.join('\n')).toContain(`${mac.units.host.file}, ${mac.units.host.name}'s plist, is gone.`);
  expect(launchd.lines.join('\n')).not.toContain('is stopped');
});

test('under launchd a shell unloaded beside a loaded host fails, and both unloaded is stopped, each said so', () => {
  const at = place('darwin', ['host', 'shell']);
  const partial = system(at.home, {
    [`launchctl ${at.units.host.name}`]: '{\n\t"PID" = 501;\n};\n',
    [`launchctl ${at.units.shell.name}`]: { status: 113 },
  });
  const some = checkUnits(at.units, at.work, true, 'connectome', partial.sys, true);
  expect([some.passed, some.stopped]).toEqual([false, undefined]);
  expect(some.lines).toContain(`launchd has no ${at.units.shell.name} loaded.`);
  const whole = system(at.home, {
    [`launchctl ${at.units.host.name}`]: { status: 113 },
    [`launchctl ${at.units.shell.name}`]: { status: 113 },
  });
  const both = checkUnits(at.units, at.work, true, 'connectome', whole.sys, true);
  expect([both.passed, both.stopped]).toEqual([true, true]);
  expect(both.lines).toEqual([`${at.units.host.name} is stopped: launchd has it unloaded.`,
    `${at.units.shell.name} is stopped: launchd has it unloaded.`]);
});

test('under launchd an agent launchctl can\'t say is loaded or not leaves the service not stopped, and the check says it can\'t tell', () => {
  const at = place('darwin', ['host']);
  const { sys } = system(at.home, {
    [`launchctl ${at.units.host.name}`]: { status: 1, stderr: 'Could not communicate with launchd\n' },
  });
  const fine = checkUnits(at.units, at.work, false, 'connectome', sys, true);
  expect([fine.passed, fine.stopped]).toEqual([false, undefined]);
  expect(fine.lines).toContain(`Whether launchd has ${at.units.host.name} loaded can't be told: Could not communicate with launchd.`);
});

test('a unit systemd skipped for an unmet condition fails, naming how to see which, while one never checked is stopped', () => {
  const at = place('linux', ['host']);
  const skipped = system(at.home, {
    [`systemctl ${at.units.host.name}`]: stoppedHost(at.work).replace('ConditionResult=yes', 'ConditionResult=no'),
  });
  const fine = checkUnits(at.units, at.work, false, 'connectome', skipped.sys, true);
  expect([fine.passed, fine.stopped]).toEqual([false, undefined]);
  expect(fine.lines).toContain(`${at.units.host.name} is inactive (dead): systemd skipped its last start, since a condition ` +
    `its unit or a drop-in sets wasn't met: \`systemctl --user status ${at.units.host.name}\` names it.`);
  const never = system(at.home, {
    [`systemctl ${at.units.host.name}`]: stoppedHost(at.work).replace('ConditionResult=yes', 'ConditionResult=no')
      .replace(/ConditionTimestamp=.*/, 'ConditionTimestamp='),
  });
  expect(checkUnits(at.units, at.work, false, 'connectome', never.sys, true).stopped).toBe(true);
});

test.skipIf(process.getuid?.() === 0)('a unit file this user can\'t look at is said as that, not as gone', () => {
  const at = place('linux', ['host']);
  const { sys } = system(at.home, { [`systemctl ${at.units.host.name}`]: stoppedHost(at.work) });
  const dir = dirname(at.units.host.file);
  chmodSync(dir, 0o000);
  try {
    const fine = checkUnits(at.units, at.work, false, 'connectome', sys, true);
    expect([fine.passed, fine.stopped]).toEqual([false, undefined]);
    expect(fine.lines.join('\n')).toMatch(new RegExp(`${at.units.host.name}'s unit file, can't be looked at, so whether it's ` +
      'there can\'t be told: .*\\. Give this user search on each directory on the way to it, and run this again\\.'));
    expect(fine.lines.join('\n')).not.toContain('is gone');
  } finally {
    chmodSync(dir, 0o755);
  }
});

test('where the recipe didn\'t load, a shell unit that\'s installed is checked as the host is, a missing one is no problem, and one line says so', () => {
  const told = (units: ServiceUnits) => `Whether the recipe names a shell can't be told, since it didn't load, so ` +
    `${units.shell.name} is checked only where it's installed.`;
  const both = place('linux', ['host', 'shell']);
  const failed = system(both.home, {
    [`systemctl ${both.units.host.name}`]: stoppedHost(both.work),
    [`systemctl ${both.units.shell.name}`]: shellShown(both.work, 'failed', 'failed'),
  });
  const unknown = checkUnits(both.units, both.work, null, 'connectome', failed.sys, true);
  expect([unknown.passed, unknown.stopped]).toEqual([false, undefined]);
  expect(unknown.lines).toContain(told(both.units));
  expect(unknown.lines.join('\n')).toContain(`${both.units.shell.name} is failed, not active`);
  expect(unknown.lines.join('\n')).not.toContain('names no shell');
  const quiet = system(both.home, {
    [`systemctl ${both.units.host.name}`]: stoppedHost(both.work),
    [`systemctl ${both.units.shell.name}`]: shellShown(both.work, 'inactive', 'dead'),
  });
  const stopped = checkUnits(both.units, both.work, null, 'connectome', quiet.sys, true);
  expect([stopped.passed, stopped.stopped]).toEqual([true, true]);
  expect(stopped.lines).toContain(`${both.units.shell.name} is stopped: systemd shows it inactive (dead).`);

  const host = place('linux', ['host']);
  const alone = system(host.home, { [`systemctl ${host.units.host.name}`]: activeHost(host.work) });
  const hostOnly = checkUnits(host.units, host.work, null, 'connectome', alone.sys);
  expect(hostOnly.passed).toBe(true);
  expect(hostOnly.lines).toContain(told(host.units));
  expect(hostOnly.lines.join('\n')).not.toContain('is gone');
  expect(alone.asked.filter((call) => call.at(-1) === host.units.shell.name)).toEqual([]);

  const looped = place('linux', ['host']);
  symlinkSync(looped.units.shell.file, looped.units.shell.file);
  const odd = system(looped.home, { [`systemctl ${looped.units.host.name}`]: activeHost(looped.work) });
  const unlooked = checkUnits(looped.units, looped.work, null, 'connectome', odd.sys);
  expect(unlooked.passed).toBe(false);
  expect(unlooked.lines.join('\n')).toContain(`${looped.units.shell.file}, ${looped.units.shell.name}'s unit file, can't be looked at`);
  expect(unlooked.lines.join('\n')).not.toContain('The recipe names a shell');
});

test('a shell daemon\'s unit that is another install\'s isn\'t checked, nor said to go at the next install', () => {
  const at = place('linux', ['host', 'shell']);
  const { sys, asked } = system(at.home, { [`systemctl ${at.units.host.name}`]: activeHost(at.work) });
  const result = checkUnits(at.units, at.work, 'other', 'connectome', sys);
  expect(result.passed).toBe(true);
  expect(result.lines.join('\n')).not.toContain(at.units.shell.name);
  expect(asked.filter((call) => call.join(' ').includes(at.units.shell.name))).toEqual([]);
});
