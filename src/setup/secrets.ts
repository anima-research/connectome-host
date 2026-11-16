import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseEnv } from 'node:util';
import { writeJsonAtomic, writeTextAtomic } from '../update/contract.js';

export const DISCORD_TOKEN = 'DISCORD_TOKEN';

// The providers' credentials and base URLs, which setup hides by name though it didn't store them.
export const PROVIDER_SECRETS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_CREDENTIALS_FILE', 'OPENAI_API_KEY',
  'OPENROUTER_API_KEY', 'OPENAI_COMPATIBLE_API_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
  'CODEX_GATE_TOKEN', 'ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'BEDROCK_BASE_URL', 'CODEX_BASE_URL', 'OPENROUTER_BASE_URL',
] as const;

export const SHORT_CHARACTERS = 8;

export interface Secret {
  name: string;
  value: string;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isSecretName(name: string): boolean {
  return NAME.test(name);
}

export function isShort(value: string): boolean {
  return [...value].length < SHORT_CHARACTERS;
}

/** Why setup can't write a value as NAME="value", or null where it can. */
export function unwritableValue(value: string): string | null {
  if (value === '') return 'it is empty';
  if (/[\u0000-\u001f\u007f]/.test(value)) return 'it holds a line break, a tab or another control character';
  if (/["$\\]/.test(value)) {
    return 'it holds a double quote, a $ or a backslash, which Bun can read in a .env line otherwise than typed';
  }
  return null;
}

function textOf(path: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw new Error(`${path} can't be read (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`);
  }
}

export function readEnvFile(path: string): Map<string, string> {
  return new Map(Object.entries(parseEnv(textOf(path))).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

/** Writes NAME="value" in place of every line that sets NAME, readable by its owner alone. */
export function writeEnvValue(path: string, name: string, value: string): void {
  const why = unwritableValue(value);
  if (why !== null) throw new Error(`${name} can't be written to ${path}: ${why}`);
  const sets = new RegExp(`^\\s*(export\\s+)?${name}\\s*=`);
  const lines = textOf(path).split('\n').filter((line) => !sets.test(line));
  while (lines.length > 0 && lines.at(-1) === '') lines.pop();
  writeTextAtomic(path, `${[...lines, `${name}="${value}"`].join('\n')}\n`, 0o600);
}

/** The names of the secrets setup stored, kept in the install directory's .setup. */
export class StoredSecrets {
  private readonly file: string;

  constructor(setupDir: string) {
    this.file = join(setupDir, 'stored-secrets.json');
  }

  names(): string[] {
    const text = textOf(this.file);
    if (text === '') return [];
    const names: unknown = JSON.parse(text);
    if (!Array.isArray(names) || !names.every((name) => typeof name === 'string')) {
      throw new Error(`${this.file} isn't a JSON list of names`);
    }
    return names;
  }

  record(name: string): void {
    const names = this.names();
    if (names.includes(name)) return;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeJsonAtomic(this.file, [...names, name], 0o600);
  }
}

/**
 * Each secret setup knows of, by its name, with the value .env and the environment give it, as stored. A value
 * shorter than SHORT_CHARACTERS isn't hidden: the person is told so when it's stored.
 */
export function storedSecrets(dir: string, env: Record<string, string | undefined>): Secret[] {
  const names = new Set([...PROVIDER_SECRETS, ...new StoredSecrets(join(dir, '.setup')).names()]);
  const stored = readEnvFile(join(dir, '.env'));
  const secrets: Secret[] = [];
  for (const name of names) {
    for (const value of new Set([stored.get(name), env[name]])) {
      if (value !== undefined && !isShort(value)) secrets.push({ name, value });
    }
  }
  return secrets.sort((a, b) => b.value.length - a.value.length);
}

/** The text with each secret's value, as stored, replaced by <NAME>. */
export function shownByName(text: string, secrets: readonly Secret[]): string {
  for (const { name, value } of secrets) text = text.split(value).join(`<${name}>`);
  return text;
}
