import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentFramework } from '@animalabs/agent-framework';
import { createBranchState, handleCommand } from '../src/commands.js';
import { DISCORD_SOURCE } from '../src/refusal-reactions.js';
import { SessionManager } from '../src/session-manager.js';

// Exercise the actual host startup/createFramework path, not just module imports.
// Real bridge lifecycle coverage still requires the forthcoming AF release.
// It runs in the locked suite (no bridge in the stock framework), so the spawn
// gets a generous bound: it checks refusal, not startup latency.
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
        cwd: dir, encoding: 'utf8', timeout: 60000,
        env: { PATH: process.env.PATH, HOME: dir, DATA_DIR: dir, ANTHROPIC_API_KEY: 'offline-test-not-a-key' },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain('mainRefusalReactions is unsupported by this Agent Framework');
      expect(existsSync(marker)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 70000,
);

// This guard is at the shared command boundary, before clients can drop turn
// trackers or call switchSession, so it runs even with the locked framework.
test.each(['/session switch later', '/session sw later', '/session new third', '/session create third'])(
  '%s refuses before changing any session state with refusal reactions on', (command) => {
    const dir = mkdtempSync(join(tmpdir(), 'refusal-switch-'));
    try {
      const sessionManager = new SessionManager(dir);
      sessionManager.createSession('later');
      sessionManager.createSession('current');
      const before = sessionManager.load();
      const branchState = createBranchState();
      branchState.checkpoints.set('saved', { branchName: 'main' });
      const app: Parameters<typeof handleCommand>[1] = {
        framework: { getHostModeStatus: () => ({ quiesced: false, activeTurnAgents: ['agent'] }) } as unknown as AgentFramework,
        recipe: { mainRefusalReactions: { ownership: 'whole-framework', servers: [] } } as never,
        sessionManager,
        branchState,
        async switchSession() { throw new Error('a refused switch must not reach the framework'); },
      };

      const result = handleCommand(command, app);
      expect(result.switchToSessionId).toBeUndefined();
      expect(result.asyncWork).toBeUndefined();
      expect(result.refused).toBe(true);
      expect(result.lines.map(line => line.text).join(' ')).toContain(
        'The current session is still running. Start the host with the path of a recipe without mainRefusalReactions (a bare start reloads the saved recipe), use /session switch or /session new, then re-enable the option and start the host again with the recipe path.',
      );
      expect(sessionManager.load()).toEqual(before);
      expect(branchState.checkpoints.get('saved')).toEqual({ branchName: 'main' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
);
