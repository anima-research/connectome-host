import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storedSecretWindowRedactor } from '../src/setup/secrets.js';

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function install(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stored-secret-window-'));
  made.push(dir);
  mkdirSync(join(dir, '.setup'));
  writeFileSync(join(dir, '.setup', 'stored-secrets.json'), '["DISCORD_TOKEN"]');
  writeFileSync(join(dir, '.env'), 'DISCORD_TOKEN="dt-value"\n');
  return dir;
}

function tail(log: string, windowStart: number, contextBytes: number): { bytes: Buffer; from: number } {
  const whole = Buffer.from(log, 'utf-8');
  const bufferStart = Math.max(0, windowStart - contextBytes);
  return { bytes: whole.subarray(bufferStart), from: windowStart - bufferStart };
}

describe("the stored secrets' window redactor", () => {
  test('replaces a stored value that has spaces around it where output holds it trimmed too', () => {
    const dir = install();
    writeFileSync(join(dir, '.setup', 'stored-secrets.json'), '["DISCORD_TOKEN","OPENAI_API_KEY"]');
    writeFileSync(join(dir, '.env'), 'DISCORD_TOKEN="dt-value"\nOPENAI_API_KEY="  sk-spaced  "\n');
    const { redact } = storedSecretWindowRedactor(dir, {});
    const bytes = Buffer.from('it printed sk-spaced here', 'utf-8');
    expect(redact(bytes, 0, bytes.length)).toMatchObject({ text: 'it printed <OPENAI_API_KEY> here', replaced: ['OPENAI_API_KEY'] });
  });

  test('holds the longest value in UTF-8 bytes, and shows a value cut by the window whole, as its name', () => {
    const multiLine = 'first-line\nsécond-line';
    const { contextBytes, redact } = storedSecretWindowRedactor(install(), { OPENAI_API_KEY: multiLine });
    expect(contextBytes).toBe(Buffer.byteLength(multiLine, 'utf-8'));
    const log = `before ${multiLine} after`;
    const { bytes, from } = tail(log, Buffer.byteLength(log.slice(0, log.indexOf('sécond'))), contextBytes);
    const shown = redact(bytes, from, bytes.length);
    expect(shown).toMatchObject({ text: '<OPENAI_API_KEY> after', end: bytes.length, replaced: ['OPENAI_API_KEY'] });
    expect(bytes.toString('utf-8', shown.start, shown.end)).toBe(`${multiLine} after`);
    const after = tail(log, Buffer.byteLength(log.slice(0, log.indexOf(' after'))), contextBytes);
    expect(redact(after.bytes, after.from, after.bytes.length)).toMatchObject({ text: ' after', replaced: [] });
  });

  test('shows nothing of a value cut by the bytes held before the window, where it overlaps one crossing the window', () => {
    const { contextBytes, redact } = storedSecretWindowRedactor(install(), {
      ANTHROPIC_API_KEY: 'XYZ-shared', AWS_SESSION_TOKEN: 'shared-tail',
    });
    const log = `${'p'.repeat(20)}XYZ-shared-tail end`;
    const { bytes, from } = tail(log, log.indexOf('ail end'), contextBytes);
    expect(bytes.toString('utf-8').startsWith('YZ-shared')).toBe(true);
    expect(redact(bytes, from, bytes.length)).toMatchObject({
      text: '<AWS_SESSION_TOKEN> end', start: bytes.indexOf('shared'), replaced: ['AWS_SESSION_TOKEN'],
    });
  });
});
