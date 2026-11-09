import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { holdBootTraces } from '../src/boot-traces.js';
import { runHeadless } from '../src/headless.js';
import type { AppContext } from '../src/index.js';

const bootTurn = process.env.FIXTURE_BOOT_TURN;
const boot: Array<Record<string, unknown>> = [
  { type: 'dendrite:agent-created', agentName: 'fixture', kind: 'resident', incarnation: 2, lifetime: { kind: 'persistent' }, timestamp: 1_700_000_000_001 },
  { type: 'dendrite:agent-created', agentName: 'fixture.reader-7', kind: 'task-fork', incarnation: 1, lifetime: { kind: 'task', idleTimeoutMs: 1 }, spawnedBy: 'fixture', inherit: { from: 'fixture', mode: 'shared' }, timestamp: 1_700_000_000_002 },
  { type: 'dendrite:agent-ended', agentName: 'fixture.reader-7', reason: 'host-restart', timestamp: 1_700_000_000_003 },
];
const agent = { name: 'fixture', state: { status: bootTurn === 'running' ? 'inferring' : 'idle' } };
if (bootTurn === 'over' || bootTurn === 'running') {
  boot.push({ type: 'inference:started', agentName: 'fixture', timestamp: 1_700_000_000_004 });
}
if (bootTurn === 'over') boot.push({ type: 'inference:completed', agentName: 'fixture', timestamp: 1_700_000_000_005 });
if (bootTurn === 'running') {
  const ending = setInterval(() => {
    if (!existsSync(join(process.env.DATA_DIR!, 'turn-end'))) return;
    clearInterval(ending);
    agent.state.status = 'idle';
    writeFileSync(join(process.env.DATA_DIR!, 'turn-ended'), String(Date.now()));
  }, 10);
}

const restored = [
  { type: 'dendrite:agent-ended', agentName: 'fixture.reader-9', kind: 'task-fork', incarnation: 1, reason: 'host-restart', timestamp: 1_700_000_000_020 },
  { type: 'dendrite:early-traces-dropped', dropped: 250, timestamp: 1_700_000_000_021 },
];

let live: ((event: Record<string, unknown>) => void) | null = null;

const app: Record<string, unknown> & { framework: unknown; onFrameworkReplaced?: () => void } = {
  recipe: { name: 'boot-replay-test', agent: { name: 'fixture' } },
  agentName: 'fixture',
  framework: {
    getAllAgents: () => [agent],
    getAllModules: () => [],
    getHostModeStatus: () => ({ drained: true, activeTurnAgents: [], parkedAdmissions: 0, gatedRequests: 0, backgroundScripts: 0 }),
    getQueueDepth: () => 0,
    onTrace: () => {},
    stop: async () => {},
  },
  bootTraces: {
    handOver(sink: (event: Record<string, unknown>) => void) {
      writeFileSync(join(process.env.DATA_DIR!, 'handed-over'), String(Date.now()));
      for (const event of boot) sink(event);
      live = sink;
      return { lost: 2, lostStarts: [] };
    },
  },
};

if (bootTurn === 'overflowed' || bootTurn === 'overflowed-subagent' || bootTurn === 'overflowed-speech') {
  const who = bootTurn === 'overflowed-subagent' ? 'fixture.reader-7' : 'fixture';
  const held = bootTurn === 'overflowed-speech'
    ? [{ type: 'inference:started', agentName: who, timestamp: 1_700_000_000_004 }, { type: 'inference:tokens', agentName: who, content: 'OLD', timestamp: 1_700_000_000_005 }]
    : [];
  const replayed = [...boot, ...held, ...(bootTurn === 'overflowed-speech' ? [{ type: 'inference:completed', agentName: who, timestamp: 1_700_000_000_006 }] : []),
    { type: 'inference:started', agentName: who, timestamp: 1_700_000_000_007 },
    ...(bootTurn === 'overflowed-speech' ? [] : [{ type: 'inference:completed', agentName: who, timestamp: 1_700_000_000_008 }])];
  let traced: ((event: never) => void) | null = null;
  const hold = holdBootTraces({
    onTrace: (listener: (event: never) => void) => {
      traced = listener;
      for (const event of replayed) listener(event as never);
      return () => {};
    },
  } as never, boot.length + held.length);
  if (bootTurn === 'overflowed-speech') {
    const speaking = setInterval(() => {
      if (!existsSync(join(process.env.DATA_DIR!, 'live'))) return;
      clearInterval(speaking);
      traced!({ type: 'inference:tokens', agentName: who, content: 'NEW', timestamp: 1_700_000_000_010 } as never);
      traced!({ type: 'inference:completed', agentName: who, timestamp: 1_700_000_000_011 } as never);
    }, 20);
  }
  app.bootTraces = {
    handOver(sink: (event: Record<string, unknown>) => void) {
      writeFileSync(join(process.env.DATA_DIR!, 'handed-over'), String(Date.now()));
      return hold.handOver(sink as never);
    },
  };
  if (bootTurn === 'overflowed-subagent') {
    const subagents = { name: 'subagent', isSubagentAgent: (name: string) => name === who, getConcurrencyStatus: () => ({ active: 0, queued: 0 }) };
    (app.framework as { getAllModules: () => unknown[] }).getAllModules = () => [subagents];
  }
}

const living = setInterval(() => {
  if (!live || !existsSync(join(process.env.DATA_DIR!, 'live'))) return;
  clearInterval(living);
  live({ type: 'inference:started', agentName: 'fixture', timestamp: 1_700_000_000_010 });
  writeFileSync(join(process.env.DATA_DIR!, 'live-emitted'), '');
}, 20);

const switching = setInterval(() => {
  if (!existsSync(join(process.env.DATA_DIR!, 'switch'))) return;
  clearInterval(switching);
  app.framework = {
    getAllAgents: () => [{ name: 'fixture', state: { status: 'idle' } }],
    getAllModules: () => [],
    getHostModeStatus: () => ({ drained: true, activeTurnAgents: [], parkedAdmissions: 0, gatedRequests: 0, backgroundScripts: 0 }),
    getQueueDepth: () => 0,
    onTrace: (listener: (event: Record<string, unknown>) => void, options?: { replay?: boolean }) => {
      if (options?.replay) for (const event of restored) listener(event);
      return () => {};
    },
    stop: async () => {},
  };
  app.onFrameworkReplaced?.();
  writeFileSync(join(process.env.DATA_DIR!, 'switched'), '');
}, 20);

await runHeadless(app as unknown as AppContext);
