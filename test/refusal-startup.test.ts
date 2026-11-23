import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { AgentFramework } from '@animalabs/agent-framework';
import { DISCORD_SOURCE } from '../src/refusal-reactions.js';
import { SessionManager } from '../src/session-manager.js';

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

test.skipIf(typeof (AgentFramework.prototype as any).getMainRefusalBridge !== 'function').each(['failed-connect', 'invalid-overlay'])(
  'a session switch with %s does not leave a half-switched host', (mode) => {
    const dir = mkdtempSync(join(tmpdir(), 'refusal-switch-'));
    try {
      const recipe = join(dir, 'recipe.json');
      const child = join(dir, 'connector.mjs');
      const marker = join(dir, 'spawned');
      const overlay = join(dir, 'mcpl-servers.agent.json');
      writeFileSync(child, `
        import { existsSync, writeFileSync } from 'node:fs';
        const marker = ${JSON.stringify(marker)};
        if (existsSync(marker)) process.exit(1);
        writeFileSync(marker, '');
        ${mode === 'invalid-overlay' ? `writeFileSync(${JSON.stringify(overlay)}, '{"mcplServers":{"s":{"disabled":true}}}');` : ''}
        await import(${JSON.stringify(pathToFileURL(resolve(import.meta.dir, 'fixtures/main-refusal-server.mjs')).href)});
      `);
      writeFileSync(recipe, JSON.stringify({
        name: 'refusal-switch', agent: { name: 'agent', provider: 'mock', systemPrompt: 'offline test' },
        mainRefusalReactions: { ownership: 'whole-framework', servers: [{ serverId: 's', kind: 'discord', sourceRevision: DISCORD_SOURCE }] },
        mcpServers: { s: { command: process.execPath, args: [child], reconnect: false } },
      }));
      const run = (input: string) => spawnSync(process.execPath, [resolve(import.meta.dir, '../src/index.ts'), recipe, '--no-tui'], {
        cwd: dir, encoding: 'utf8', timeout: 15000, input,
        env: { PATH: process.env.PATH, HOME: dir, DATA_DIR: dir, CONNECTOME_UPDATE_CHECK: '0' },
      });
      const result = run('/session new later\n/session list\n');
      expect(result.error).toBeUndefined();
      expect(result.stdout).toContain('--- Sessions (2) ---');
      expect(result.status).toBe(0);
      if (mode === 'invalid-overlay') {
        expect(result.stderr).toContain('Session switch refused: Refusal server s: requires one known stdio server');
        expect(new SessionManager(dir).getActiveSession()?.name).toBe('Session 1');
        return;
      }
      expect(result.stdout + result.stderr).toContain('Session switched.');
      expect(result.stderr.match(/Refusal server s: .*marking is off until restart/g)).toHaveLength(1);
      expect(new SessionManager(dir).getActiveSession()?.name).toBe('later');

      const cold = run('');
      expect(cold.error).toBeUndefined();
      expect(cold.status).not.toBe(0);
      expect(cold.stderr).toContain('Refusal server s: must be connected');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 35000,
);
