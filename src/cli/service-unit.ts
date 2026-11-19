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

const CONTROL = /[\u0000-\u001f\u007f]/;

export function plain(value: string, what: string): string {
  if (CONTROL.test(value)) {
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
  wants: string | null, killMode: 'mixed' | null = null): string {
  const named = `The working directory ${JSON.stringify(work)}`;
  if (/[ \\]$/.test(work)) {
    throw new Refusal(`${named} ends in a space or a backslash. systemd drops a space at the end of a unit's line and ` +
      'joins a line that ends in a backslash to the next, so it can\'t go in a unit. Nothing was written. Set this ' +
      'resident up again in a directory whose name ends in neither.');
  }
  const unit = [`Description=${plain(description, named).replace(/%/g, '%%')}`,
    ...(wants === null ? [] : [`Wants=${wants}`, `After=${wants}`])];
  const service = [`WorkingDirectory=${plain(work, named).replace(/%/g, '%%')}`, `ExecStart=${argv.map(word).join(' ')}`,
    ...env.map(([name, value]) => assignment(name, value)), 'Restart=on-failure',
    ...(killMode === null ? [] : [`KillMode=${killMode}`])];
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

export interface UnitRead {
  argv: string[];
  workingDirectory: string;
}

export function readUnit(manager: Manager, text: string): UnitRead | { why: string } {
  return manager === 'systemd-user' ? readSystemdUnit(text) : readPlist(text);
}

function readSystemdUnit(text: string): UnitRead | { why: string } {
  const lines = text.split('\n');
  if (lines.some((line) => line.endsWith('\\'))) {
    return { why: 'a line of it ends in a backslash, which systemd joins to the next line, where service install writes none' };
  }
  const only = (key: string): string | { why: string } => {
    const found = lines.filter((line) => line.startsWith(`${key}=`));
    if (found.length !== 1) {
      return { why: `it has ${found.length === 0 ? 'no' : found.length} ${key} line${found.length === 1 ? '' : 's'}, where ` +
        'service install writes one' };
    }
    return found[0]!.slice(key.length + 1);
  };
  const exec = only('ExecStart');
  if (typeof exec !== 'string') return exec;
  const argv = execWords(exec);
  if (argv === null) return { why: 'its ExecStart line isn\'t the quoted words service install writes' };
  const work = only('WorkingDirectory');
  if (typeof work !== 'string') return work;
  const workingDirectory = unpercent(work);
  if (workingDirectory === null) return { why: 'its WorkingDirectory line has a % that service install doesn\'t write' };
  if (CONTROL.test(workingDirectory)) {
    return { why: 'its WorkingDirectory line holds a control character, which service install doesn\'t write' };
  }
  if (workingDirectory.endsWith(' ')) {
    return { why: 'its WorkingDirectory line ends in a space, which systemd drops and service install doesn\'t write' };
  }
  return { argv, workingDirectory };
}

function execWords(value: string): string[] | null {
  const words: string[] = [];
  let at = 0;
  while (at < value.length) {
    if (value[at] !== '"') return null;
    at++;
    let word = '';
    for (;;) {
      const c = value[at];
      if (c === undefined || CONTROL.test(c)) return null;
      if (c === '"') {
        at++;
        break;
      }
      if (c === '\\' || c === '%' || c === '$') {
        const next = value[at + 1];
        if (c === '\\' ? next !== '\\' && next !== '"' : next !== c) return null;
        word += next;
        at += 2;
        continue;
      }
      word += c;
      at++;
    }
    words.push(word);
    if (at < value.length && value[at++] !== ' ') return null;
  }
  return words.length === 0 ? null : words;
}

function unpercent(value: string): string | null {
  return value.replace(/%%/g, '').includes('%') ? null : value.replace(/%%/g, '%');
}

function readPlist(text: string): UnitRead | { why: string } {
  const lines = text.split('\n');
  const keyAt = (key: string): number => lines.indexOf(`  <key>${key}</key>`);
  const args = keyAt('ProgramArguments');
  if (args < 0 || lines[args + 1] !== '  <array>') {
    return { why: 'it has no ProgramArguments array as service install writes it' };
  }
  const argv: string[] = [];
  let at = args + 2;
  for (; at < lines.length && lines[at] !== '  </array>'; at++) {
    const word = stringOf(lines[at]!, '    ');
    if (word === null) return { why: 'its ProgramArguments holds a line service install doesn\'t write' };
    argv.push(word);
  }
  if (at === lines.length || argv.length === 0) {
    return { why: 'its ProgramArguments array isn\'t closed as service install writes it, or is empty' };
  }
  const work = keyAt('WorkingDirectory');
  const workingDirectory = work < 0 ? null : stringOf(lines[work + 1] ?? '', '  ');
  if (workingDirectory === null) return { why: 'it has no WorkingDirectory string as service install writes it' };
  return { argv, workingDirectory };
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' };

function stringOf(line: string, indent: string): string | null {
  const open = `${indent}<string>`;
  if (!line.startsWith(open) || !line.endsWith('</string>')) return null;
  const inner = line.slice(open.length, -'</string>'.length);
  if (/[<>]/.test(inner) || CONTROL.test(inner)) return null;
  let bad = false;
  const decoded = inner.replace(/&([^;]*);?/g, (whole, name: string) => {
    if (!whole.endsWith(';') || !(name in ENTITIES)) bad = true;
    return ENTITIES[name] ?? '';
  });
  return bad ? null : decoded;
}
