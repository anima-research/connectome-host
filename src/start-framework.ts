import type { AgentFramework } from '@animalabs/agent-framework';
import { FleetModule } from './modules/fleet-module.js';
import type { ExtensionRegistry } from './extensions.js';
import { auditBeforeCommit } from './update/audit-stores.js';
import { commitRelease, currentForStart, type ReleaseHere } from './update/host.js';
import { resumeIfSwitch } from './update/quiesce.js';

export async function startFramework(
  framework: Pick<AgentFramework, 'start' | 'stop' | 'getModule' | 'listMcplServers' | 'notifyOps' | 'quiesce' | 'resume' | 'getHostModeStatus'>,
  here: ReleaseHere | null,
  trial?: { dataDir: string; activeStore: string; places: () => string[] | null; extensions?: ExtensionRegistry },
): Promise<void> {
  if (here !== null) {
    let moved: { from: string } | undefined;
    try {
      const current = currentForStart(here.root);
      if (trial !== undefined && current !== null && current !== here.release) {
        await auditBeforeCommit(trial.dataDir, trial.activeStore, current, trial.places, framework.notifyOps.bind(framework), trial.extensions);
      }
      moved = commitRelease(here, {
        unconnectedServers: () => framework.listMcplServers().filter((server) => !server.connected).map((server) => server.id),
      });
    } catch (error) {
      await framework.stop().catch((stopping: unknown) => {
        console.error(`[update] stopping the framework after its start ended failed too: ${stopping instanceof Error ? stopping.message : String(stopping)}`);
      });
      throw error;
    }
    if (moved !== undefined) {
      console.log(`[update] ${here.release} is now the release the install at ${here.root} runs on (it was ${moved.from}).`);
    }
  }
  framework.start();
  const resumed = await resumeIfSwitch(framework);
  if (resumed.refused) framework.notifyOps('update-quiesce-stays', 'host', `This host's switch quiesce didn't end: ${resumed.why}`);
  const fleet = framework.getModule('fleet');
  if (fleet instanceof FleetModule) fleet.launchAutoStart();
}
