import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager } from '@animalabs/context-manager';

const ROOT = '00000000-0000-4000-8000-000000000000';
const at = (n: number) => `2026-01-01T00:00:0${n}.000Z`;
const message = (n: number, sender: 'human' | 'assistant', content: unknown[], parent: string) => ({
  uuid: `00000000-0000-4000-8000-00000000000${n}`,
  parent_message_uuid: parent,
  sender, text: '', content, attachments: [], files: [],
  created_at: at(n), updated_at: at(n),
});

describe('import-claudeai-export CLI', () => {
  test('a thinking-only turn keeps its place, and the counts are what was written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'import-counts-'));
    try {
      const a = message(1, 'human', [{ type: 'text', text: 'A' }], ROOT);
      const b = message(2, 'assistant', [{ type: 'thinking', thinking: 'only a thought' }], a.uuid);
      const c = message(3, 'human', [{ type: 'text', text: 'C' }], b.uuid);
      const d = message(4, 'human', [], c.uuid); // nothing to import: skipped
      const exportDir = join(dir, 'export');
      mkdirSync(exportDir);
      writeFileSync(join(exportDir, 'conversations.json'), JSON.stringify([{
        uuid: '11111111-1111-4111-8111-111111111111', name: 'counts',
        created_at: at(1), updated_at: at(4), chat_messages: [a, b, c, d],
      }]));
      const out = join(dir, 'data');
      const r = Bun.spawnSync(
        ['bun', 'scripts/import-claudeai-export.ts', exportDir, '--out', out, '--no-interactive', '--drop-thinking'],
        { cwd: join(import.meta.dir, '..') },
      );
      expect(r.exitCode).toBe(0);

      const sessionsDir = join(out, 'sessions');
      const sidecar = readdirSync(sessionsDir).find((f) => f.endsWith('.import-source.json'))!;
      const meta = JSON.parse(readFileSync(join(sessionsDir, sidecar), 'utf-8'));
      expect(meta.originalMessageCount).toBe(4);
      expect(meta.importedMessageCount).toBe(3);

      const id = sidecar.replace('.import-source.json', '');
      const store = JsStore.openOrCreate({ path: join(sessionsDir, id) });
      const cm = await ContextManager.open({ store });
      const written = cm.getAllMessages().map((m) => [m.participant, m.content]);
      await cm.close?.();
      store.close?.();
      expect(written).toEqual([
        ['user', [{ type: 'text', text: 'A' }]],
        ['Claude', [{ type: 'text', text: '[earlier thinking left out]' }]],
        ['user', [{ type: 'text', text: 'C' }]],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
