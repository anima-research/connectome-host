import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
import { classifyBlock, stripBlocks } from '../scripts/strip-recovered-thinking.js';

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
    expect(r).toEqual({ keep: [text('Hello!')], removed: 1, mixed: 0 });
  });

  test('end to end on a store: dry run changes nothing, --apply removes the blocks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'strip-rt-'));
    const storePath = join(dir, 'store');
    try {
      const store = JsStore.openOrCreate({ path: storePath });
      const cm = await ContextManager.open({ store });
      cm.addMessage('user', [text('hi')]);
      cm.addMessage('Claude', [text('<recovered_thinking>\n\n</recovered_thinking>'), text('Hello!')]);
      cm.addMessage('Claude', [text('<recovered_thinking>\nonly thought\n</recovered_thinking>')]);
      await cm.close?.();
      store.close?.();

      const run = (...extra: string[]) =>
        Bun.spawnSync(['bun', 'scripts/strip-recovered-thinking.ts', storePath, ...extra], {
          cwd: join(import.meta.dir, '..'),
        });
      const dry = run();
      expect(dry.exitCode).toBe(0);
      expect(dry.stdout.toString()).toContain('Messages to edit: 1');
      const applied = run('--apply');
      expect(applied.exitCode).toBe(0);
      expect(applied.stdout.toString()).toContain('Messages edited: 1, blocks removed: 1');
      expect(applied.stderr.toString()).toContain('would be left empty');

      const store2 = JsStore.openOrCreate({ path: storePath });
      const cm2 = await ContextManager.open({ store: store2 });
      const contents = cm2.getAllMessages().map((m) => m.content);
      expect(contents[1]).toEqual([text('Hello!')]);
      await cm2.close?.();
      store2.close?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
