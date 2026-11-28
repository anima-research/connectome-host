import type { AgentFramework } from '@animalabs/agent-framework';

const CLEANUP_STOP_BUDGET_MS = 5_000;

export async function stopAfterFailedSetup(
  framework: Pick<AgentFramework, 'stop' | 'getStore'>,
  onFailed?: () => void,
): Promise<void> {
  try {
    await framework.stop(CLEANUP_STOP_BUDGET_MS);
  } catch (stopError) {
    onFailed?.();
    console.error('[framework] stopping the framework after setup failed:', stopError);
    // As in releaseFailedCreate, nobody can retry this stop. Release the store.
    const store = framework.getStore();
    if (!store.isClosed()) {
      try {
        store.close();
      } catch (closeError) {
        console.error('[framework] closing its store failed too:', closeError);
      }
    }
  }
}
