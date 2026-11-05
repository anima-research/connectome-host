import { describe, expect, test } from 'bun:test';
import type { AgentFramework } from '@animalabs/agent-framework';
import { handleCommand } from '../src/commands.js';

function app(nudgeAgent: AgentFramework['nudgeAgent']): Parameters<typeof handleCommand>[1] {
  return {
    framework: { nudgeAgent } as AgentFramework,
    sessionManager: {} as never,
    recipe: { name: 'test' } as never,
    branchState: {} as never,
    switchSession: async () => {},
  };
}

describe('/nudge', () => {
  test('nudges the default agent and reports immediate run when idle', () => {
    const calls: Array<[string | undefined, string | undefined]> = [];
    const result = handleCommand('/nudge', app((name, by) => {
      calls.push([name, by]);
      return { ok: true, agentName: 'main', agentStatus: 'idle' };
    }));
    expect(calls).toEqual([[undefined, 'host-console']]);
    expect(result.lines[0]?.text).toMatch(/Nudged main/);
    expect(result.lines[0]?.text).toMatch(/no new events/);
    expect(result.lines[0]?.text).toMatch(/running now/);
  });

  test('passes an explicit agent name and reports queueing when busy', () => {
    const result = handleCommand('/nudge sidekick', app((name) => {
      expect(name).toBe('sidekick');
      return { ok: true, agentName: 'sidekick', agentStatus: 'streaming' };
    }));
    expect(result.lines[0]?.text).toMatch(/queued — runs when current turn settles \(agent is streaming\)/);
  });

  test('surfaces framework errors', () => {
    const result = handleCommand('/nudge ghost', app(() => (
      { ok: false, error: 'Unknown agent: ghost' }
    )));
    expect(result.lines[0]?.text).toBe('Nudge failed: Unknown agent: ghost');
  });
});
