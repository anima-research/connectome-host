/** Real headless protocol/command dispatcher with an offline, controlled tool. */
import { existsSync, writeFileSync } from 'node:fs';
import { runHeadless } from '../src/headless.js';
import type { AppContext } from '../src/index.js';

await runHeadless({
  recipe: { name: 'command-owner-test', agent: { name: 'fixture' } },
  agentName: 'fixture',
  framework: {
    getAllAgents: () => [{ name: 'fixture', state: { status: 'idle' } }],
    onTrace: () => {},
    stop: async () => {},
    puppetToolCall: async (_agent: string, _tool: string, input: Record<string, string>) => {
      while (!existsSync(input.release!)) await Bun.sleep(10);
      // The command's promise continuations (including reply writes) drain
      // before this next timer turn. The parent then sends a fresh command;
      // its reply is an ordered socket barrier after the pending result.
      setTimeout(() => writeFileSync(input.done!, 'settled'), 0);
      return { toolUseId: 'fixture-tool', result: { success: true, data: input.result } };
    },
  },
} as unknown as AppContext);
