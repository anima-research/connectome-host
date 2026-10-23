/**
 * Real headless protocol over a fake framework whose boot is already over:
 * main() has held three traces (what create() replayed and what start()
 * emitted before runHeadless attached its sink) in `bootTraces`, and dropped
 * two more past its cap. The tree and socket sink takes the hold; the
 * runtime's other listeners (idle detection) still attach through onTrace,
 * which here sees nothing. A `/puppet` command makes the framework emit one
 * live trace through the handed-over sink.
 */
import { runHeadless } from '../src/headless.js';
import type { AppContext } from '../src/index.js';

const boot = [
  { type: 'dendrite:agent-created', agentName: 'fixture', kind: 'resident', incarnation: 2, lifetime: { kind: 'persistent' }, timestamp: 1_700_000_000_001 },
  { type: 'dendrite:agent-created', agentName: 'fixture.reader-7', kind: 'task-fork', incarnation: 1, lifetime: { kind: 'task', idleTimeoutMs: 1 }, spawnedBy: 'fixture', inherit: { from: 'fixture', mode: 'shared' }, timestamp: 1_700_000_000_002 },
  { type: 'dendrite:agent-ended', agentName: 'fixture.reader-7', reason: 'host-restart', timestamp: 1_700_000_000_003 },
];

let live: ((event: Record<string, unknown>) => void) | null = null;

await runHeadless({
  recipe: { name: 'boot-replay-test', agent: { name: 'fixture' } },
  agentName: 'fixture',
  framework: {
    getAllAgents: () => [{ name: 'fixture', state: { status: 'idle' } }],
    onTrace: () => {},
    stop: async () => {},
    puppetToolCall: async () => {
      live?.({ type: 'inference:started', agentName: 'fixture', timestamp: 1_700_000_000_010 });
      return { toolUseId: 'fixture-tool', result: { success: true, data: 'emitted' } };
    },
  },
  bootTraces: {
    handOver(sink: (event: Record<string, unknown>) => void) {
      for (const event of boot) sink(event);
      live = sink;
      return 2;
    },
  },
} as unknown as AppContext);
