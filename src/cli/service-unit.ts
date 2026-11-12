import { basename, dirname, join } from 'node:path';

export class Refusal extends Error {}

export type Manager = 'systemd-user' | 'launchd';

export interface ServiceUnit {
  name: string;
  file: string;
}

export interface ServiceUnits {
  manager: Manager;
  work: string;
  host: ServiceUnit;
  shell: ServiceUnit;
}

export function slugOf(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function managerFor(platform: NodeJS.Platform): Manager | null {
  return platform === 'linux' ? 'systemd-user' : platform === 'darwin' ? 'launchd' : null;
}

export function serviceUnits(root: string, platform: NodeJS.Platform, home: string): ServiceUnits | null {
  const manager = managerFor(platform);
  const work = dirname(root);
  const slug = slugOf(basename(work));
  if (manager === null || slug === '') return null;
  if (manager === 'systemd-user') {
    const dir = join(home, '.config', 'systemd', 'user');
    return {
      manager, work,
      host: { name: `connectome-${slug}.service`, file: join(dir, `connectome-${slug}.service`) },
      shell: { name: `connectome-${slug}.shell.service`, file: join(dir, `connectome-${slug}.shell.service`) },
    };
  }
  const dir = join(home, 'Library', 'LaunchAgents');
  const label = `com.animalabs.connectome.${slug}`;
  return {
    manager, work,
    host: { name: label, file: join(dir, `${label}.plist`) },
    shell: { name: `${label}.shell`, file: join(dir, `${label}.shell.plist`) },
  };
}

export function plain(value: string, what: string): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Refusal(`${what} holds a line break or another control character, so it can't go in a unit. Nothing was ` +
      'written.');
  }
  return value;
}

function word(value: string): string {
  return `"${plain(value, `The command's word ${JSON.stringify(value)}`).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    .replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;
}

function assignment(name: string, value: string): string {
  return `Environment="${`${name}=${plain(value, name)}`.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
}

export function systemdUnit(description: string, work: string, argv: string[], env: Array<[string, string]>,
  wants: string | null): string {
  const named = `The working directory ${JSON.stringify(work)}`;
  if (/[ \\]$/.test(work)) {
    throw new Refusal(`${named} ends in a space or a backslash. systemd drops a space at the end of a unit's line and ` +
      'joins a line that ends in a backslash to the next, so it can\'t go in a unit. Nothing was written. Set this ' +
      'resident up again in a directory whose name ends in neither.');
  }
  const unit = [`Description=${plain(description, named).replace(/%/g, '%%')}`,
    ...(wants === null ? [] : [`Wants=${wants}`, `After=${wants}`])];
  const service = [`WorkingDirectory=${plain(work, named).replace(/%/g, '%%')}`, `ExecStart=${argv.map(word).join(' ')}`,
    ...env.map(([name, value]) => assignment(name, value)), 'Restart=on-failure'];
  return `[Unit]\n${unit.join('\n')}\n\n[Service]\n${service.join('\n')}\n\n[Install]\nWantedBy=default.target\n`;
}

function xml(value: string, what: string): string {
  return plain(value, what).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function plist(label: string, work: string, args: string[], env: Array<[string, string]>, logPath: string): string {
  const as = (value: string) => xml(value, JSON.stringify(value));
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${as(label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...args.map((arg) => `    <string>${as(arg)}</string>`),
    '  </array>',
    '  <key>WorkingDirectory</key>',
    `  <string>${as(work)}</string>`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...env.flatMap(([name, value]) => [`    <key>${as(name)}</key>`, `    <string>${xml(value, name)}</string>`]),
    '  </dict>',
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>SuccessfulExit</key>',
    '    <false/>',
    '  </dict>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>StandardOutPath</key>',
    `  <string>${as(logPath)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${as(logPath)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}
