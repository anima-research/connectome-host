import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runHeadless } from '../src/headless.js';
import type { AppContext } from '../src/index.js';
import { TuiModule } from '../src/modules/tui-module.js';
import { hostUpdate } from '../src/update/update.js';

const tui = new TuiModule();
if (process.env.UPDATE_NOT_AN_INSTALL === '1') {
  hostUpdate.configure({
    here: null, running: '0.0.0', env: { CONNECTOME_UPDATE_CHECK: '0' },
    host: { framework: () => ({ getHostModeStatus: () => ({ quiesced: false }) }) as never, fleet: () => null },
  });
}

await runHeadless({
  recipe: { name: 'command-owner-test', agent: { name: 'fixture' } },
  agentName: 'fixture',
  framework: {
    getAllAgents: () => [{ name: 'fixture', state: { status: 'idle' } }],
    getAllModules: () => [{
      name: 'workspace',
      handleToolCall: async () => {
        const dir = process.env.DATA_DIR!;
        writeFileSync(join(dir, 'started'), 'yes');
        while (!existsSync(join(dir, 'release'))) await Bun.sleep(10);
        setTimeout(() => writeFileSync(join(dir, 'done'), 'settled'), 0);
        return { success: true, data: { entries: [{ path: 'ORIGINAL-CALLER-RESULT', size: 1 }] } };
      },
    }],
    getHostModeStatus: () => ({ drained: true, activeTurnAgents: [], parkedAdmissions: 0, gatedRequests: 0, backgroundScripts: 0 }),
    getQueueDepth: () => 0,
    pushEvent: async (event: unknown) => {
      const answer = await tui.onProcess(event as never, {} as never);
      appendFileSync(join(process.env.DATA_DIR!, 'pushed.jsonl'), `${JSON.stringify(answer.addMessages?.[0]?.content ?? null)}\n`);
    },
    onTrace: () => {},
    stop: async () => {},
    puppetToolCall: async (_agent: string, _tool: string, input: Record<string, string>) => {
      while (!existsSync(input.release!)) await Bun.sleep(10);
      // The command's promise continuations (including reply writes) drain
      // before this next timer turn.
      setTimeout(() => writeFileSync(input.done!, 'settled'), 0);
      return { toolUseId: 'fixture-tool', result: { success: true, data: input.result } };
    },
  },
} as unknown as AppContext);
