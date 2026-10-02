/**
 * Requires the AF release containing agent-framework#95. During companion
 * development, run against that AF branch; the old release lacks its default.
 */
import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentFramework, REFUSAL_REACTION_BASELINE } from '@animalabs/agent-framework';
import { Membrane, MockAdapter, NativeFormatter } from '@animalabs/membrane';
import { composeMcplChildEnv } from '../src/mcpl-config.js';

const CHILD = fileURLToPath(new URL('./fixtures/placed-reaction-child.cjs', import.meta.url));

for (const override of [undefined, '🟪', '']) {
  test('host and AF compose the child reaction baseline: ' + JSON.stringify(override), async () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-reaction-composition-'));
    let framework: AgentFramework | undefined;
    try {
      framework = await AgentFramework.create({
        storePath: join(dir, 'store'),
        membrane: new Membrane(new MockAdapter({ defaultResponse: 'ok' }), { formatter: new NativeFormatter() }),
        agents: [{ name: 'resident', model: 'mock', systemPrompt: 'Resident.' }],
        modules: [],
        discordAwarenessEmoji: '🔕',
        mcplServers: [{
          id: 'probe',
          command: process.execPath,
          args: [CHILD],
          env: composeMcplChildEnv({
            EXTRA: 'preserved',
            AGENT_TIMEZONE: 'wrong-server-zone',
            ...(override === undefined ? {} : { DISCORD_SUPPRESSED_REACTIONS_BASELINE: override }),
          }, 'Pacific/Auckland'),
        }],
      });
      const registry = (framework as unknown as {
        mcplServerRegistry: { getServer(id: string): { sendToolsCall(name: string, args: {}): Promise<{ content: Array<{ text?: string }> }> } };
      }).mcplServerRegistry;
      const result = await registry.getServer('probe').sendToolsCall('read_env', {});
      const env = JSON.parse(result.content[0]!.text!);
      if (override === undefined) {
        expect(new Set(env.baseline?.split(','))).toEqual(new Set([...REFUSAL_REACTION_BASELINE, '💤', '🔕']));
      } else {
        expect(env.baseline).toBe(override);
      }
      expect(env.timeZone).toBe('Pacific/Auckland');
      expect(env.extra).toBe('preserved');
    } finally {
      await framework?.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
