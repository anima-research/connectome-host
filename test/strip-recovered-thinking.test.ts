import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
import { classifyBlock, parseStripArgs, stripBlocks } from '../scripts/strip-recovered-thinking.js';

const text = (t: string): ContentBlock => ({ type: 'text', text: t });

describe('strip-recovered-thinking', () => {
  test('classifies the importer shapes', () => {
    expect(classifyBlock(text('<recovered_thinking>\n\n</recovered_thinking>'))).toBe('remove');
    expect(classifyBlock(text('<recovered_thinking>\nI think X\n</recovered_thinking>'))).toBe('remove');
    expect(classifyBlock(text('Hello!'))).toBe('keep');
    expect(classifyBlock(text('see <recovered_thinking> above'))).toBe('mixed');
    expect(classifyBlock(text('<recovered_thinking>a</recovered_thinking>\n\nHello'))).toBe('mixed');
  });

  test('--empty-only keeps non-empty blocks', () => {
    expect(classifyBlock(text('<recovered_thinking>\nI think X\n</recovered_thinking>'), true)).toBe('keep');
    expect(classifyBlock(text('<recovered_thinking>\n \n</recovered_thinking>'), true)).toBe('remove');
  });

  test('stripBlocks returns null when nothing changes', () => {
    expect(stripBlocks([text('Hello!')])).toBeNull();
    const r = stripBlocks([text('<recovered_thinking>\n\n</recovered_thinking>'), text('Hello!')]);
    expect(r).toEqual({ keep: [text('Hello!')], removed: 1, mixed: 0, keptNonEmpty: 0, placeholder: false });
  });

  test('a message of thinking alone keeps the placeholder', () => {
    const r = stripBlocks([text('<recovered_thinking>\nonly thought\n</recovered_thinking>')]);
    expect(r).toEqual({ keep: [text('[earlier thinking left out]')], removed: 1, mixed: 0, keptNonEmpty: 0, placeholder: true });
  });

  test('--empty-only counts the non-empty blocks it keeps', () => {
    const r = stripBlocks([text('<recovered_thinking>\nI think X\n</recovered_thinking>'), text('Hello!')], true);
    expect(r?.keptNonEmpty).toBe(1);
    expect(r?.removed).toBe(0);
  });

  test('unknown options and stray paths are refused', () => {
    expect(parseStripArgs(['store', '--empty-ony', '--apply'])).toEqual({ error: 'unknown option: --empty-ony' });
    expect(parseStripArgs(['store', 'other'])).toEqual({ error: 'one store path, not 2' });
    expect(parseStripArgs(['--apply'])).toEqual({ error: 'no store path' });
    expect(parseStripArgs(['store', '--apply', '--empty-only'])).toEqual({ storePath: 'store', apply: true, emptyOnly: true });
  });

  const makeStore = async (dir: string, extra: ContentBlock[][] = []) => {
    const storePath = join(dir, 'store');
    const store = JsStore.openOrCreate({ path: storePath });
    const cm = await ContextManager.open({ store });
    cm.addMessage('user', [text('hi')]);
    cm.addMessage('Claude', [text('<recovered_thinking>\n\n</recovered_thinking>'), text('Hello!')]);
    cm.addMessage('user', [text('and?')]);
    cm.addMessage('Claude', [text('<recovered_thinking>\nonly thought\n</recovered_thinking>')]);
    for (const content of extra) cm.addMessage('user', content);
    await cm.close?.();
    store.close?.();
    return storePath;
  };
  const readStore = async (storePath: string) => {
    const store = JsStore.openOrCreate({ path: storePath });
    const cm = await ContextManager.open({ store });
    const messages = cm.getAllMessages().map((m) => ({ id: m.id, participant: m.participant, content: m.content }));
    await cm.close?.();
    store.close?.();
    return messages;
  };
  const run = (storePath: string, ...extra: string[]) =>
    Bun.spawnSync(['bun', 'scripts/strip-recovered-thinking.ts', storePath, ...extra], {
      cwd: join(import.meta.dir, '..'),
    });

  test('end to end on a store: dry run changes nothing, --apply removes every block', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'strip-rt-'));
    try {
      const storePath = await makeStore(dir);
      const before = await readStore(storePath);
      const dry = run(storePath);
      expect(dry.exitCode).toBe(0);
      expect(dry.stdout.toString()).toContain('Messages to edit: 2');
      expect(await readStore(storePath)).toEqual(before);

      const applied = run(storePath, '--apply');
      expect(applied.exitCode).toBe(0);
      expect(applied.stdout.toString()).toContain('Messages edited: 2, blocks removed: 2');
      expect(applied.stdout.toString()).toContain('given the placeholder');

      const after = await readStore(storePath);
      // Same messages, same order and roles; the thinking-only turn keeps a placeholder.
      expect(after.map((m) => [m.id, m.participant])).toEqual(before.map((m) => [m.id, m.participant]));
      expect(after.map((m) => m.content)).toEqual([
        [text('hi')],
        [text('Hello!')],
        [text('and?')],
        [text('[earlier thinking left out]')],
      ]);
      expect(JSON.stringify(after)).not.toContain('<recovered_thinking>');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('a misspelled flag is refused before the store is touched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'strip-rt-'));
    try {
      const storePath = await makeStore(dir);
      const before = await readStore(storePath);
      const r = run(storePath, '--empty-ony', '--apply');
      expect(r.exitCode).toBe(1);
      expect(r.stderr.toString()).toContain('unknown option: --empty-ony');
      expect(await readStore(storePath)).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('blocks it leaves in place make it exit 2 and say so', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'strip-rt-'));
    try {
      const storePath = await makeStore(dir, [[text('<recovered_thinking>a</recovered_thinking>\n\nquoted')]]);
      const r = run(storePath, '--apply');
      expect(r.exitCode).toBe(2);
      expect(r.stdout.toString()).toContain('Mixed blocks left alone: 1. These still carry the tag.');
      const after = await readStore(storePath);
      expect(after[4]!.content).toEqual([text('<recovered_thinking>a</recovered_thinking>\n\nquoted')]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
