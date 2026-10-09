import { FleetModule } from '../src/modules/fleet-module.ts';
import { runHeadless } from '../src/headless.ts';
import type { AppContext } from '../src/index.ts';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.DATA_DIR!;
const mode = process.argv[2];
if (mode !== 'timeout' && mode !== 'detach') throw new Error('Unknown fleet shutdown mode');
const fleet = new FleetModule({
  childIndexPath: join(import.meta.dir, 'mock-headless-fleet-shutdown-child.ts'),
  socketWaitTimeoutMs: 3000, readyTimeoutMs: 3000,
});
await fleet.start({} as Parameters<FleetModule['start']>[0]);
const launched = await fleet.handleToolCall({ id: 'launch', name: 'launch', input: {
  name: 'fixture', recipe: join(dir, 'fixture-recipe.json'), dataDir: join(dir, 'child'),
} });
if (!launched.success) throw new Error(String(launched.error));
writeFileSync(join(dir, 'child-pid.json'), JSON.stringify({ pid: fleet.getChildren().get('fixture')!.pid }));
fleet.setDetachMode(mode === 'detach');
await runHeadless({
  recipe: { name: 'Fleet shutdown test', agent: { name: 'fixture' } },
  agentName: 'fixture',
  framework: {
    getAllAgents: () => [{ name: 'fixture', state: { status: 'idle' } }],
    onTrace: () => () => {},
    async stop() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // Isolate Host behavior using the locked Framework API. The shorter
        // synthetic module budget expires before Fleet's actual 10s/5s waits.
        await Promise.race([
          fleet.stop(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('synthetic framework module shutdown deadline')), 50);
          }),
        ]);
        const stopped = fleet as any;
        writeFileSync(join(dir, 'detach-cleanup.json'), JSON.stringify({
          exitHandler: stopped.exitHandler, context: stopped.ctx,
          socket: fleet.getChildren().get('fixture')!.socket,
        }));
      } finally { clearTimeout(timer); }
    },
  },
} as unknown as AppContext);
