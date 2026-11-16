import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEnvFile, shownByName, storedSecrets, writeEnvValue } from '../src/setup/secrets.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'setup-secrets-'));
  dirs.push(dir);
  return dir;
}

test('a value written to .env is read back as written, in place of each line that set it, and other lines stay', () => {
  const file = join(scratch(), '.env');
  writeFileSync(file, '# mine\nMODEL=claude\nDISCORD_TOKEN=old\nexport DISCORD_TOKEN=older\n');
  writeEnvValue(file, 'DISCORD_TOKEN', 'a b#c\'d');
  expect(readFileSync(file, 'utf-8')).toBe('# mine\nMODEL=claude\nDISCORD_TOKEN="a b#c\'d"\n');
  expect(readEnvFile(file).get('DISCORD_TOKEN')).toBe('a b#c\'d');
});

test('a value .env can\'t hold as written is refused, and the file is left as it was', () => {
  const file = join(scratch(), '.env');
  writeFileSync(file, 'MODEL=claude\n');
  for (const value of ['with"quote', 'with$dollar', 'with\\backslash', 'two\nlines', '']) {
    expect(() => writeEnvValue(file, 'TOKEN', value)).toThrow();
  }
  expect(readFileSync(file, 'utf-8')).toBe('MODEL=claude\n');
});

test('the stored secrets are the providers\' keys and the names setup recorded, with their values as stored, short ones left out', () => {
  const dir = scratch();
  mkdirSync(join(dir, '.setup'));
  writeFileSync(join(dir, '.setup', 'stored-secrets.json'), JSON.stringify(['MY_TOKEN', 'MY_PIN']));
  writeFileSync(join(dir, '.env'), 'MY_TOKEN=token-from-env-file\nMY_PIN=1234\nMODEL=claude-opus-5-5\n');
  const secrets = storedSecrets(dir, { ANTHROPIC_API_KEY: 'sk-ant-from-environment' });
  expect(secrets.map(({ name }) => name).sort()).toEqual(['ANTHROPIC_API_KEY', 'MY_TOKEN']);
  expect(shownByName('a token-from-env-file and sk-ant-from-environment, pin 1234', secrets))
    .toBe('a <MY_TOKEN> and <ANTHROPIC_API_KEY>, pin 1234');
});
