import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentFramework } from '@animalabs/agent-framework';
import { DISCORD_SOURCE } from '../src/refusal-reactions.js';

// Exercise the actual host startup/createFramework path, not just module imports.
// Real bridge lifecycle coverage still requires the forthcoming AF release.
test.skipIf(typeof (AgentFramework.prototype as any).getMainRefusalBridge === 'function')(
  'stock host rejects handover before spawning any selected connector', () => {
    const dir = mkdtempSync(join(tmpdir(), 'refusal-startup-'));
    try {
      const marker = join(dir, 'spawned');
      const recipe = join(dir, 'recipe.json');
      writeFileSync(recipe, JSON.stringify({
        name: 'refusal-startup', agent: { name: 'agent', systemPrompt: 'offline test' },
        mainRefusalReactions: { ownership: 'whole-framework', servers: [{ serverId: 's', kind: 'discord', sourceRevision: DISCORD_SOURCE }] },
        mcpServers: { s: { command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`] } },
      }));
      const result = spawnSync(process.execPath, [resolve(import.meta.dir, '../src/index.ts'), recipe, '--headless'], {
        cwd: dir, encoding: 'utf8', timeout: 15000,
        env: { PATH: process.env.PATH, HOME: dir, DATA_DIR: dir, ANTHROPIC_API_KEY: 'offline-test-not-a-key' },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain('mainRefusalReactions is unsupported by this Agent Framework');
      expect(existsSync(marker)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 20000,
);
