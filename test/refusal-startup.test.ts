import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
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

for (const state of ['connected', 'restored closed tab', 'failed first connect'] as const) {
  test.skipIf(typeof (AgentFramework.prototype as any).getMainRefusalBridge !== 'function')(
    `enabled host starts and stops with a ${state}`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'refusal-enabled-startup-'));
      try {
        const recipe = join(dir, 'recipe.json');
        const acquisitions = join(dir, 'ownership.log');
        const preload = join(dir, 'observe-ownership.ts');
        // Observe the real bridge's acquisitions, without replacing the
        // framework, bridge decisions, connection results, or ops alerts.
        writeFileSync(preload, `
          import { appendFileSync } from 'node:fs';
          import { AgentFramework } from ${JSON.stringify(import.meta.resolve('@animalabs/agent-framework'))};
          const getBridge = AgentFramework.prototype.getMainRefusalBridge;
          AgentFramework.prototype.getMainRefusalBridge = function () {
            const bridge = getBridge.call(this);
            return { ...bridge, takeOwnership(handler) {
              const release = bridge.takeOwnership(handler);
              appendFileSync(${JSON.stringify(acquisitions)}, 'acquired\\n');
              return () => {
                release();
                appendFileSync(${JSON.stringify(acquisitions)}, 'released\\n');
              };
            } };
          };
        `);
        const start = (opts: Record<string, unknown>) => {
          writeFileSync(recipe, JSON.stringify({ name: 'refusal-startup',
            agent: { name: 'agent', provider: 'mock', model: 'mock', systemPrompt: 'offline test' }, ...opts }));
          const result = spawnSync(process.execPath, ['--preload', preload, resolve(import.meta.dir, '../src/index.ts'), recipe, '--no-tui'], {
            cwd: dir, encoding: 'utf8', input: '', timeout: 60000,
            env: { PATH: process.env.PATH, HOME: dir, DATA_DIR: dir },
          });
          expect(result.error).toBeUndefined();
          expect({ status: result.status, fatal: result.status ? result.stderr : '' }).toEqual({ status: 0, fatal: '' });
          expect(result.stdout).toContain('Done.');
        };
        if (state === 'restored closed tab') {
          start({}); // Create a usable store, then seed its saved toolset state.
          const sessions = new SessionManager(dir);
          const configDir = join(sessions.getStorePath(sessions.getActiveSession()!.id), 'config');
          mkdirSync(configDir, { recursive: true });
          writeFileSync(join(configDir, 'toolsets.json'), JSON.stringify({ version: 1, agents: {}, closed: { s: true } }));
        }
        start({
          mainRefusalReactions: { ownership: 'whole-framework', servers: [{ serverId: 's', kind: 'discord', sourceRevision: DISCORD_SOURCE }] },
          mcpServers: { s: { command: process.execPath, args: state === 'failed first connect'
            ? ['-e', 'process.exit(1)'] : [resolve(import.meta.dir, 'fixtures/main-refusal-server.mjs')] } },
        });
        const failures = join(dir, 'logs', 'failures.log');
        const alerts = existsSync(failures) ? readFileSync(failures, 'utf8').trim().split('\n')
          .map(line => JSON.parse(line)).filter(event => event.kind === 'refusal-reaction-unavailable') : [];
        if (state === 'connected') {
          expect(readFileSync(acquisitions, 'utf8')).toBe('acquired\nreleased\n');
          expect(alerts).toEqual([]);
        } else {
          expect(existsSync(acquisitions)).toBe(false);
          expect(alerts).toHaveLength(1);
          expect(alerts[0]).toMatchObject({ agent: 'agent', serverId: 's',
            status: state === 'restored closed tab' ? 'closed-tab' : 'not-connected' });
          expect(alerts[0].reason).toContain('built-in refusal reactions remain enabled');
        }
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }, 130000,
  );
}

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
