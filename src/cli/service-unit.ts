export interface UnitRead {
  argv: string[];
  workingDirectory: string;
}

/** What `service install` wrote into a unit, read back by the exact rules its writer quotes by: a unit it couldn't have
 *  written is refused, with the line that isn't its. */
export function readUnit(manager: 'systemd-user' | 'launchd', text: string): UnitRead | { why: string } {
  return manager === 'systemd-user' ? readSystemdUnit(text) : readPlist(text);
}

function readSystemdUnit(text: string): UnitRead | { why: string } {
  const lines = text.split('\n');
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
      if (c === undefined) return null;
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
  if (/[<>]/.test(inner)) return null;
  let bad = false;
  const decoded = inner.replace(/&([^;]*);?/g, (whole, name: string) => {
    if (!whole.endsWith(';') || !(name in ENTITIES)) bad = true;
    return ENTITIES[name] ?? '';
  });
  return bad ? null : decoded;
}
