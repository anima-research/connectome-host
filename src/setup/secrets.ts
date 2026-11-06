import { lstatSync, mkdirSync, readFileSync, readlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseEnv } from 'node:util';
import { writeJsonAtomic, writeTextAtomic } from '../update/contract.js';

/** The provider credentials the host reads from its environment (src/index.ts, membrane's Bedrock provider and
 *  src/codex-subscription-adapter.ts), and the providers' base URLs it reads there, which can carry one, kept out
 *  of the setup agent's commands whether or not setup stored them. ANTHROPIC_OAUTH_CREDENTIALS_FILE names a file,
 *  and is here since a host started from such a command would sign in with it in place of the checked key; other
 *  places that hold a credential, such as CODEX_HOME and IDENTITY_KEY_FILE, stay, since stripping one changes which
 *  file a command reads and hides nothing a command can't read. */
export const PROVIDER_SECRETS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_CREDENTIALS_FILE', 'OPENAI_API_KEY',
  'OPENROUTER_API_KEY', 'OPENAI_COMPATIBLE_API_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
  'CODEX_GATE_TOKEN', 'ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'BEDROCK_BASE_URL', 'CODEX_BASE_URL',
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

/** Why a value can't be written to .env in setup's form, double-quoted as setup writes it, or null when it can. */
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

/** A .env line, from 1, outside setup's form, and why it's outside. */
interface Outside {
  line: number;
  why: string;
}

/** The .env text's assignments, line by line, and its lines outside setup's form. */
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

/** What setup's reading and writing of a .env outside its form throw. Its words name the first line outside it by
 *  its number alone, never anything it holds, its name included, since the text before an = isn't known to be a
 *  name; then how many others there are, the form, and what to do with a line outside it. */
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
    return readFileSync(path, 'utf-8');
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === 'ENOENT') return '';
    throw new Error(`${path} can't be read (${code ?? (error as Error).message})`);
  }
}

/** The assignments of a .env file in setup's form, or none when there's no file. One outside the form throws an
 *  EnvFormError, and one that can't be read an Error naming it. */
function envAssignments(path: string): Assignment[] {
  const { assignments, outside } = envLines(envText(path));
  if (outside.length > 0) throw new EnvFormError(path, outside);
  return assignments;
}

// Bun 1.4.4 reads, from the directory it starts in, .env.<mode>.local, .env.local (not under test), .env.<mode> and
// .env, in that order, where mode is production or test as NODE_ENV says, and development otherwise. A name the
// environment or an earlier file gives keeps that value, and within a file a later line takes an earlier one's place.
// It puts in $NAME, ${NAME} and ${NAME:-default}, quoted or not, with the value NAME has once the environment, the
// files read before and the whole of its own file are read, so a later line of the same file counts and a later file
// doesn't; ${NAME:-default} gives the default, itself put in, where nothing sets NAME. A value naming its own name
// comes out otherwise. It reads \$ as $, and leaves ${NAME-…}, ${NAME:=…}, ${NAME:+…} and ${NAME:?…} as written
// (probed).
const DOTENV_MODES = ['development', 'production', 'test'] as const;

function dotenvFiles(mode: (typeof DOTENV_MODES)[number]): string[] {
  return [`.env.${mode}.local`, ...(mode === 'test' ? [] : ['.env.local']), `.env.${mode}`, '.env'];
}

/** A dotenv file's assignments in its order: .env in setup's form, throwing as envAssignments does, and the others
 *  in any form, as node:util's parseEnv reads them, which is as Bun 1.4.4 does but that it keeps \$ and puts in no
 *  $NAME. None when the file isn't there; one that can't be read throws, naming it. */
function dotenvAssignments(dir: string, file: string): Assignment[] {
  const path = join(dir, file);
  if (file === '.env') return envAssignments(path);
  return Object.entries(parseEnv(envText(path))).map(([name, value]) => ({ name, value: value ?? '' }));
}

/** Every name a dotenv file Bun reads in a directory gives, in any mode, whatever the environment holds. */
export function dotenvNames(dir: string): string[] {
  const names = new Set<string>();
  for (const file of new Set(DOTENV_MODES.flatMap(dotenvFiles))) {
    for (const { name } of dotenvAssignments(dir, file)) names.add(name);
  }
  return [...names];
}

export function dotenvReferences(dir: string): string[] {
  const names = new Set<string>();
  for (const file of new Set(DOTENV_MODES.flatMap(dotenvFiles))) {
    for (const { value } of dotenvAssignments(dir, file)) {
      const named = value.matchAll(/\\\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?:\}|:-)|\$([A-Za-z_][A-Za-z0-9_]*)/g);
      for (const [, braced, bare] of named) {
        if (braced ?? bare) names.add((braced ?? bare)!);
      }
    }
  }
  return [...names];
}

/** Each value Bun can give a name from a directory's dotenv files, in any mode, with `env` as the environment it
 *  starts with: a name `env` gives takes none from the files. */
export function dotenvValues(dir: string, env: Record<string, string | undefined>): Map<string, Set<string>> {
  const values = new Map<string, Set<string>>();
  for (const mode of DOTENV_MODES) {
    const has = new Map<string, string>();
    for (const [name, value] of Object.entries(env)) if (value !== undefined) has.set(name, value);
    const fixed = new Set(has.keys());
    for (const file of dotenvFiles(mode)) {
      const ours = new Set<string>();
      for (const { name, value } of dotenvAssignments(dir, file)) {
        if (fixed.has(name)) continue;
        has.set(name, value.replace(/\\\$|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
          (whole, braced?: string, bare?: string) => (whole === '\\$' ? '$' : has.get(braced ?? bare!) ?? '')));
        ours.add(name);
      }
      for (const name of ours) {
        fixed.add(name);
        if (!values.has(name)) values.set(name, new Set());
        values.get(name)!.add(has.get(name)!);
      }
    }
  }
  return values;
}

/** Each name's value in a .env file in setup's form, as Bun reads it: the last line for the name. Throws as
 *  envAssignments does. */
export function readEnvFile(path: string): Map<string, string> {
  return new Map(envAssignments(path).map(({ name, value }) => [name, value]));
}

/** The refusal of a .env outside setup's form, or null when it's in it or there's none. One that can't be read
 *  throws, naming it. */
export function envForm(path: string): EnvFormError | null {
  const { outside } = envLines(envText(path));
  return outside.length > 0 ? new EnvFormError(path, outside) : null;
}

/** What writeEnvValue throws for a link at the path it would write. */
export class EnvLinkError extends Error {}

/** The refusal of a link at `path`, naming where it leads, or null when there's none. */
export function envLink(path: string): EnvLinkError | null {
  if (!lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) return null;
  return new EnvLinkError(`${path} is a link to ${readlinkSync(path)}, and it's written only as a file of its own, ` +
    'not through a link or over one');
}

/** Writes NAME="value" in .env, readable by this user only: in place of the first line for NAME, with any later
 *  ones taken out, or after the others, every other line as it was, short of a BOM at the start, which Bun skips.
 *  The value must be one `unwritableValue` passes. A link found at `path` throws, naming where it leads, rather than
 *  being written through or replaced, and a file outside setup's form throws an EnvFormError, writing nothing. */
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

export function removeEnvValues(path: string, names: readonly string[]): boolean {
  const link = envLink(path);
  if (link) throw link;
  const before = envText(path);
  const { outside } = envLines(before);
  if (outside.length > 0) throw new EnvFormError(path, outside);
  const bom = before.startsWith('\ufeff') ? '\ufeff' : '';
  const lines = before.slice(bom.length).split('\n');
  const after = bom + lines.filter((line) => !names.includes(ASSIGNMENT.exec(line)?.[1] ?? '')).join('\n');
  if (after === before) return false;
  writeTextAtomic(path, after, 0o600);
  return true;
}

/** The names of the secrets setup stored, kept in its own data directory so a resumed setup knows them. */
export class StoredSecrets {
  readonly file: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, 'stored-secrets.json');
  }

  read(): string[] | null {
    let text: string;
    try {
      text = readFileSync(this.file, 'utf-8');
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

  forget(names: readonly string[]): boolean {
    const before = this.names();
    const after = before.filter((name) => !names.includes(name));
    if (after.length === before.length) return false;
    writeJsonAtomic(this.file, after, 0o600);
    return true;
  }
}

export interface Secret {
  name: string;
  value: string;
}

/** Each secret's name and value: from each of .env's lines for it, which in setup's form spell a value as Bun reads
 *  it, from each value Bun can give it from the dotenv files beside .env, in a process whose environment is the
 *  given one without the secrets, as a setup--run command's is, and from the given environment. A .env outside the
 *  form throws an EnvFormError, as it does at setup's start: what Bun reads from it, and so what a command prints of
 *  a secret, isn't known. */
export function secretValues(names: string[], envFile: string, env: Record<string, string | undefined>): Secret[] {
  const assignments = envAssignments(envFile);
  const fromFiles = dotenvValues(dirname(envFile), withoutSecrets(env, names));
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

function spansOf(bytes: Buffer, secrets: Secret[]): Span[] {
  const candidates: Span[] = [];
  for (const { name, value } of secrets) {
    const needle = Buffer.from(value, 'utf-8');
    if (needle.length === 0) continue;
    for (let at = bytes.indexOf(needle); at >= 0; at = bytes.indexOf(needle, at + 1)) {
      candidates.push({ start: at, end: at + needle.length, names: [name] });
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

// Buffer replaces partial UTF-8 characters during decoding, so callers keep from and to between characters.
export function redactWindow(
  bytes: Buffer,
  from: number,
  to: number,
  secrets: Secret[],
  replaced: Set<string>,
  preserveLineBreaks = false,
): { text: string; start: number; end: number } {
  const spans = spansOf(bytes, secrets);
  const crossing = spans.find((span) => span.start < from && from < span.end);
  const start = crossing ? crossing.start : from;
  let text = '';
  let at = start;
  for (const span of spans) {
    if (span.end <= at) continue;
    if (span.start >= to) break;
    const hidden = `<${span.names[0]}>`;
    text += bytes.toString('utf-8', at, span.start) + (preserveLineBreaks
      ? bytes.toString('utf-8', span.start, span.end).split('\n').map(() => hidden).join('\n') : hidden);
    for (const name of span.names) replaced.add(name);
    at = span.end;
  }
  if (at < to) {
    text += bytes.toString('utf-8', at, to);
    at = to;
  }
  return { text, start, end: at };
}

export interface RedactedWindow {
  text: string;
  start: number;
  end: number;
  replaced: string[];
  guessed: string[];
}

/** For a reader of part of a log: replaces, in the bytes from `from` to `to`, current values collected for this
 *  install's secret names and additionalNames from its dotenv files and env, with their names, as redactWindow does. A value that crosses `from` is replaced whole when the bytes hold it whole, which
 *  they do when they start `contextBytes` before `from`, the longest value's length. It has only those values: one
 *  .env held earlier, which a running setup--run also replaces, isn't among them. Throws as `StoredSecrets.names`
 *  does. */
export function storedSecretWindowRedactor(
  workingDir: string,
  env: Record<string, string | undefined> = process.env,
  preserveLineBreaks = false,
  additionalNames: readonly string[] = [],
): { contextBytes: number; redact(bytes: Buffer, from: number, to: number): RedactedWindow } {
  const envFile = join(workingDir, '.env');
  const { names, guessed } = secretNames(join(workingDir, '.setup'), envFile);
  const secrets = secretValues([...names, ...additionalNames], envFile, env);
  return {
    contextBytes: Math.max(0, ...secrets.map(({ value }) => Buffer.byteLength(value, 'utf-8'))),
    redact(bytes, from, to) {
      const replaced = new Set<string>();
      const window = redactWindow(bytes, from, to, secrets, replaced, preserveLineBreaks);
      return { ...window, replaced: [...replaced], guessed: guessed.filter((name) => replaced.has(name)) };
    },
  };
}

/** storedSecretWindowRedactor over the whole of a text. */
export function storedSecretRedactor(
  workingDir: string,
  env: Record<string, string | undefined> = process.env,
  preserveLineBreaks = false,
  additionalNames: readonly string[] = [],
): (text: string) => { text: string; replaced: string[]; guessed: string[] } {
  const { redact } = storedSecretWindowRedactor(workingDir, env, preserveLineBreaks, additionalNames);
  return (text) => {
    const bytes = Buffer.from(text, 'utf-8');
    const { text: redacted, replaced, guessed } = redact(bytes, 0, bytes.length);
    return { text: redacted, replaced, guessed };
  };
}

export function storedSecrets(workingDir: string, env: Record<string, string | undefined>): Secret[] {
  const envFile = join(workingDir, '.env');
  return secretValues(secretNames(join(workingDir, '.setup'), envFile).names, envFile, env);
}
