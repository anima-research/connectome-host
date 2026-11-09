import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseEnv } from 'node:util';
import { readWithoutWaiting, writeJsonAtomic, writeTextAtomic } from '../update/contract.js';

export const PROVIDER_SECRETS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_CREDENTIALS_FILE', 'OPENAI_API_KEY',
  'OPENROUTER_API_KEY', 'OPENAI_COMPATIBLE_API_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
  'CODEX_GATE_TOKEN', 'ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'BEDROCK_BASE_URL', 'CODEX_BASE_URL', 'OPENROUTER_BASE_URL',
] as const;

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isSecretName(name: string): boolean {
  return NAME.test(name);
}

// Setup reads and writes .env in one form, which Bun 1.4.3 and 1.4.4 read as it's written: each line alone, and a file
// of such lines with comment lines holding any printable character between them, a later line for a name taking its
// place (probed). Every line is empty, a comment starting with #, or NAME=value with no space around the =, its value
// unquoted, double-quoted or single-quoted, and no line holds an ASCII control character: Bun ends a line at a CR
// alone. Of the characters probed, each alone (printable ASCII, and some beyond it, U+2028 among them), Bun reads a
// value otherwise than it's spelled only for these: unquoted, a space at its ends, which it trims, a # anywhere, which
// starts a comment, and a $ before text, which starts a name it puts in; quoted, a quote of its own kind, a $ before
// text, and a backslash at its end, which escapes the closing quote. A backslash wasn't probed before every character
// an escape could take, so the form holds none, nor a quote in an unquoted value, where one at its start would quote
// it. Bun skips a BOM at the file's start, and so does setup.
const CONTROL = /[\u0000-\u001f\u007f]/;
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=/;
const FORM_VALUE = /^(?:[^ #$"'`\\]*|"[^"$\\]*"|'[^'$\\]*')$/;

export function unwritableValue(value: string): string | null {
  if (value === '') return 'it is empty';
  if (CONTROL.test(value)) return 'it holds a line break, a tab or another control character';
  if (/["$\\]/.test(value)) {
    return 'it holds a double quote, a $ or a backslash, which Bun can read in a .env line otherwise than typed, so ' +
      'setup doesn\'t write them there';
  }
  return null;
}

interface Assignment {
  name: string;
  value: string;
}

interface Outside {
  line: number;
  why: string;
}

function envLines(text: string): { assignments: Assignment[]; outside: Outside[] } {
  const assignments: Assignment[] = [];
  const outside: Outside[] = [];
  text.replace(/^\ufeff/, '').split('\n').forEach((line, at) => {
    const name = ASSIGNMENT.exec(line)?.[1] ?? null;
    const why = CONTROL.test(line) ? 'holds an ASCII control character, such as a carriage return, which each line ' +
        'of a file saved with Windows line ends has, or a tab'
      : line === '' || line.startsWith('#') ? null
      : name === null ? 'is neither empty, a comment starting with #, nor NAME= at its start'
      : FORM_VALUE.test(line.slice(name.length + 1)) ? null
      : 'spells its value in none of the form\'s three ways';
    if (why !== null) {
      outside.push({ line: at + 1, why });
    } else if (name !== null) {
      const value = line.slice(name.length + 1);
      assignments.push({ name, value: value[0] === '"' || value[0] === "'" ? value.slice(1, -1) : value });
    }
  });
  return { assignments, outside };
}

export class EnvFormError extends Error {
  constructor(path: string, outside: Outside[]) {
    const [{ line, why }] = outside as [Outside];
    const others = outside.length - 1;
    super(`${path}, line ${line}, ${why}` +
      (others === 0 ? '' : `, and ${others} other line${others === 1 ? ' isn\'t' : 's aren\'t'} in setup's form either`) +
      '. Setup reads and writes .env in one form, which Bun reads as it\'s written: empty lines, comments starting ' +
      'with #, and NAME=value, NAME="value" or NAME=\'value\', each on one line, where NAME is ASCII letters, digits ' +
      'and _, not starting with a digit, a quoted value holds no quote of its own kind, $ or backslash, an unquoted ' +
      'one no quote, backtick, $, backslash, space or #, and no line holds a tab or another ASCII control character. ' +
      'Rewrite such a line in that form, or take it out of this .env, which is setup\'s: a value the host needs from ' +
      'it then has to reach the host\'s environment another way');
  }
}

function envText(path: string): string {
  try {
    return readWithoutWaiting(path);
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === 'ENOENT') return '';
    throw new Error(`${path} can't be read (${code ?? (error as Error).message})`);
  }
}

function envAssignments(path: string): Assignment[] {
  const { assignments, outside } = envLines(envText(path));
  if (outside.length > 0) throw new EnvFormError(path, outside);
  return assignments;
}

// Bun 1.4.4 reads, from the directory it starts in, .env.<mode>.local, .env.local (not under test), .env.<mode> and
// .env, in that order, where mode is production or test as NODE_ENV says, and development otherwise.
const DOTENV_MODES = ['development', 'production', 'test'] as const;

function dotenvFiles(mode: (typeof DOTENV_MODES)[number]): string[] {
  return [`.env.${mode}.local`, ...(mode === 'test' ? [] : ['.env.local']), `.env.${mode}`, '.env'];
}

export function dotenvNames(dir: string): string[] {
  const names = new Set<string>();
  for (const file of new Set(DOTENV_MODES.flatMap(dotenvFiles))) {
    for (const name of Object.keys(parseEnv(envText(join(dir, file))))) names.add(name);
  }
  return [...names];
}

const READ_LIMIT_MS = 10_000;

export class DotenvTimeoutError extends Error {}

export function dotenvValues(dir: string, env: Record<string, string | undefined>): Map<string, Set<string>> {
  const values = new Map<string, Set<string>>();
  const names = dotenvNames(dir).filter((name) => !Object.hasOwn(env, name) || env[name] === undefined);
  if (names.length === 0) return values;
  if (env.BUN_OPTIONS) {
    const naming = [...new Set(DOTENV_MODES.flatMap(dotenvFiles))]
      .find((file) => /\$\{?BUN_OPTIONS\b/.test(envText(join(dir, file))));
    if (naming !== undefined) {
      throw new Error(`${join(dir, naming)} expands BUN_OPTIONS, which the environment sets, and setup reads the ` +
        'dotenv files without it, since Bun would apply it to that read, so what a value built from it holds ' +
        'can\'t be told: take the expansion out of it, or start the host without BUN_OPTIONS');
    }
  }
  const given: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && name !== 'BUN_OPTIONS' && name !== 'NODE_ENV') given[name] = value;
  }
  const own = env.NODE_ENV;
  const development = own !== undefined && own !== 'production' && own !== 'test' ? { ...given, NODE_ENV: own } : given;
  for (const mode of DOTENV_MODES) {
    // --config=/dev/null: a bunfig.toml in the directory would otherwise run its preload here. Bun's mode is
    // development where NODE_ENV is unset or names neither production nor test, and a NODE_ENV the environment gives
    // wins over a file's: the development run goes with the environment's own, as a command does, or else with none,
    // and only there does a file's NODE_ENV come through.
    const ran = spawnSync(process.execPath, ['--config=/dev/null', '-e', 'process.stdout.write(JSON.stringify(process.env))'], {
      cwd: dir, env: mode === 'development' ? development : { ...given, NODE_ENV: mode }, timeout: READ_LIMIT_MS,
      encoding: 'utf-8', maxBuffer: Infinity,
    });
    if ((ran.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') {
      throw new DotenvTimeoutError(`Bun didn't finish reading the dotenv files in ${dir} within ${READ_LIMIT_MS / 1000} s`);
    }
    if (ran.error || ran.status !== 0) {
      const last = `${ran.stderr ?? ''}`.trim().split('\n').at(-1);
      const how = ran.error ? ran.error.message : ran.status === null ? `killed by ${ran.signal}` : `exit ${ran.status}`;
      throw new Error(`Bun couldn't read the dotenv files in ${dir} (${how}${last ? `: ${last}` : ''})`);
    }
    let read: Record<string, unknown> | null = null;
    try {
      read = JSON.parse(ran.stdout) as Record<string, unknown> | null;
    } catch {
    }
    if (read === null || typeof read !== 'object') {
      throw new Error(`Bun's reading of the dotenv files in ${dir} gave output setup can't read`);
    }
    for (const name of names) {
      if (name === 'NODE_ENV' && mode !== 'development') continue;
      const value = read[name];
      if (typeof value !== 'string') continue;
      if (!values.has(name)) values.set(name, new Set());
      values.get(name)!.add(value);
    }
  }
  return values;
}

export function readEnvFile(path: string): Map<string, string> {
  return new Map(envAssignments(path).map(({ name, value }) => [name, value]));
}

export function envForm(path: string): EnvFormError | null {
  const { outside } = envLines(envText(path));
  return outside.length > 0 ? new EnvFormError(path, outside) : null;
}

export class EnvLinkError extends Error {}

export function envLink(path: string): EnvLinkError | null {
  if (!lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) return null;
  return new EnvLinkError(`${path} is a link to ${readlinkSync(path)}, and it's written only as a file of its own, ` +
    'not through a link or over one');
}

export function writeEnvValue(path: string, name: string, value: string): void {
  const link = envLink(path);
  if (link) throw link;
  const before = envText(path);
  const { outside } = envLines(before);
  if (outside.length > 0) throw new EnvFormError(path, outside);
  const text = before.replace(/^\ufeff/, '');
  const lines = text === '' ? [] : text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const assigns = (line: string) => ASSIGNMENT.exec(line)?.[1] === name;
  const first = lines.findIndex(assigns);
  const kept = lines.filter((line) => !assigns(line));
  kept.splice(first >= 0 ? first : kept.length, 0, `${name}="${value}"`);
  mkdirSync(dirname(path), { recursive: true });
  writeTextAtomic(path, `${kept.join('\n')}\n`, 0o600);
}

export class StoredSecrets {
  readonly file: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, 'stored-secrets.json');
  }

  read(): string[] | null {
    let text: string;
    try {
      text = readWithoutWaiting(this.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !lstatSync(this.file, { throwIfNoEntry: false })) {
        return null;
      }
      throw new Error(`${this.file} can't be read: ${(error as Error).message}`);
    }
    let names: unknown;
    try {
      names = JSON.parse(text);
    } catch {
      names = undefined;
    }
    if (!Array.isArray(names) || !names.every((name) => typeof name === 'string' && isSecretName(name))) {
      throw new Error(`${this.file} isn't the list of the names of the secrets setup stored, such as ["DISCORD_TOKEN"]`);
    }
    return names as string[];
  }

  names(): string[] {
    return this.read() ?? [];
  }

  record(name: string, envFile = join(dirname(dirname(this.file)), '.env')): void {
    const names = this.read();
    if (names === null && guessedNames(envFile).length > 0) return;
    if (names?.includes(name)) return;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeJsonAtomic(this.file, [...(names ?? []), name], 0o600);
  }
}

export interface Secret {
  name: string;
  value: string;
}

export function secretValues(
  names: string[], envFile: string, env: Record<string, string | undefined>,
  commandEnv: Record<string, string | undefined> = withoutSecrets(env, names),
): Secret[] {
  const assignments = envAssignments(envFile);
  const fromFiles = dotenvValues(dirname(envFile), commandEnv);
  const found: Secret[] = [];
  const add = (name: string, value: string | undefined) => {
    if (value && !found.some((seen) => seen.name === name && seen.value === value)) found.push({ name, value });
  };
  for (const name of new Set(names)) {
    for (const assignment of assignments) if (assignment.name === name) add(name, assignment.value);
    for (const value of fromFiles.get(name) ?? []) add(name, value);
    add(name, Object.hasOwn(env, name) ? env[name] : undefined);
  }
  return found;
}

export const DISCORD_TOKEN = 'DISCORD_TOKEN';

const KNOWN_SECRETS: string[] = [...PROVIDER_SECRETS, DISCORD_TOKEN];

function guessedNames(envFile: string): string[] {
  return dotenvNames(dirname(envFile)).filter((name) => !KNOWN_SECRETS.includes(name));
}

export function secretNames(setupDir: string, envFile: string): { names: string[]; guessed: string[] } {
  const listed = new StoredSecrets(setupDir).read();
  if (listed !== null) return { names: [...new Set([...KNOWN_SECRETS, ...listed])], guessed: [] };
  const guessed = guessedNames(envFile);
  return { names: [...KNOWN_SECRETS, ...guessed], guessed };
}

export function withoutSecrets(env: Record<string, string | undefined>, names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !names.includes(key)) out[key] = value;
  }
  return out;
}

interface Span {
  start: number;
  end: number;
  names: string[];
}

// ASCII letters fold one to one, so a match in the folded bytes is at the same offsets in the bytes.
const foldAscii = (bytes: Buffer): Buffer => Buffer.from(bytes.map((byte) => (byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte)));

function spansOf(bytes: Buffer, secrets: Secret[]): Span[] {
  const candidates: Span[] = [];
  const folded = foldAscii(bytes);
  for (const { name, value } of secrets) {
    for (const form of new Set([value, value.trim()])) {
      const needle = foldAscii(Buffer.from(form, 'utf-8'));
      if (needle.length === 0) continue;
      for (let at = folded.indexOf(needle); at >= 0; at = folded.indexOf(needle, at + 1)) {
        candidates.push({ start: at, end: at + needle.length, names: [name] });
      }
    }
  }
  candidates.sort((a, b) => a.start - b.start || b.end - a.end);
  const spans: Span[] = [];
  for (const span of candidates) {
    const last = spans[spans.length - 1];
    if (last && span.start < last.end) {
      last.end = Math.max(last.end, span.end);
      for (const name of span.names) if (!last.names.includes(name)) last.names.push(name);
    } else {
      spans.push({ ...span, names: [...span.names] });
    }
  }
  return spans;
}

export function redactWindow(
  bytes: Buffer,
  from: number,
  to: number,
  secrets: Secret[],
  replaced: Set<string>,
): { text: string; start: number; end: number } {
  const spans = spansOf(bytes, secrets);
  const crossing = spans.find((span) => span.start < from && from < span.end);
  const start = crossing ? crossing.start : from;
  let text = '';
  let at = start;
  for (const span of spans) {
    if (span.end <= at) continue;
    if (span.start >= to) break;
    text += `${bytes.toString('utf-8', at, span.start)}<${span.names[0]}>`;
    for (const name of span.names) replaced.add(name);
    at = span.end;
  }
  if (at < to) {
    text += bytes.toString('utf-8', at, to);
    at = to;
  }
  return { text, start, end: at };
}

/** The text with each of the .env values that the agent's side takes as a secret, by secretNames, shown by its name,
 *  as everywhere setup hides one: a URL's host can carry one. The base URLs are left out, since such text says where
 *  one of them leads. */
export function withoutStoredSecrets(
  text: string, values: ReadonlyMap<string, string>, setupDir: string, envFile: string,
): string {
  let taken: string[];
  try {
    taken = secretNames(setupDir, envFile).names;
  } catch {
    // An unreadable list is said where setup reads it for its agent. Here every name it could hold is hidden.
    taken = [...KNOWN_SECRETS, ...guessedNames(envFile)];
  }
  const names = new Set(taken.filter((name) => !name.endsWith('_BASE_URL')));
  const secrets = [...values].filter(([name, value]) => names.has(name) && value.trim() !== '')
    .map(([name, value]) => ({ name, value }));
  const bytes = Buffer.from(text);
  return redactWindow(bytes, 0, bytes.length, secrets, new Set()).text;
}
