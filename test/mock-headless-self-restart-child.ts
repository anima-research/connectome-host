import { runHeadless } from '../src/headless.ts';
import type { AppContext } from '../src/index.ts';
import { selfRestart } from '../src/self-restart.ts';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MODES = ['self-restart', 'sigterm-first', 'exit-when-idle', 'held', 'cancel-in-wait', 'arm-after-idle', 'late-arm-gap', 'unseen-turn',
  'quiet-exit', 'quiet-idle', 'text-exit'];
const HOLDS = ['turn', 'gated', 'script', 'late-script', 'script-until-released', 'queue', 'subagent-active', 'subagent-queued', 'wake-gap'];
const mode = process.argv[2];
if (!MODES.includes(mode)) throw new Error('Unknown self-restart fixture mode');
const quiet = mode === 'quiet-exit' || mode === 'quiet-idle' || mode === 'text-exit';
const blip = quiet && process.argv[3] === 'blip';
const textQueued = quiet && process.argv[3] === 'text-queued';
const textSlow = quiet && process.argv[3] === 'text-slow';
// late-queue: once the test writes queue-go, an event sits on the queue until it writes release-queue.
const lateQueue = quiet && process.argv[3] === 'late-queue';
const hold = mode === 'cancel-in-wait' ? 'turn' : quiet && (process.argv[3] === 'none' || blip || textQueued || textSlow || lateQueue || mode === 'text-exit')
  ? undefined : process.argv[3];
if ((mode === 'held' || (quiet && hold !== undefined)) && !HOLDS.includes(hold!)) throw new Error('Unknown self-restart fixture hold');
const dataDir = process.env.DATA_DIR!;

const agent = { name: 'fixture', state: { status: 'idle' as string } };
let listeners: Array<(event: unknown) => void> = [];
let generation = 0;
const trace = (event: unknown) => { for (const listener of listeners) listener(event); };
let heldFrom = 0;
let heldUntil = 0;
let quietFrom = Infinity;
const quietAt = (at: number) => {
  quietFrom = at;
  writeFileSync(join(dataDir, 'quiet-from'), String(at));
};
let textHeld = false;
const lateQueued = (): boolean => {
  if (!lateQueue || !existsSync(join(dataDir, 'queue-go')) || existsSync(join(dataDir, 'release-queue'))) return false;
  if (!existsSync(join(dataDir, 'queue-seen'))) writeFileSync(join(dataDir, 'queue-seen'), String(Date.now()));
  return true;
};
const holding = (kind: string): boolean => {
  if (kind === 'queue' && (textHeld || lateQueued())) return true;
  const t = Date.now() - heldFrom;
  if (hold === 'wake-gap') return kind === 'subagent-active' ? t < 1000 : kind === 'turn' && t >= 1150 && t < 1800;
  if (mode === 'late-arm-gap') return heldFrom > 0 && kind === 'turn' && t >= 150 && t < 800;
  if (hold === 'late-script') return kind === 'script' && heldFrom > 0 && t >= 200 && t < 1200;
  if (hold === 'script-until-released') return kind === 'script' && heldFrom > 0 && !existsSync(join(dataDir, 'release-script'));
  return hold === kind && Date.now() < heldUntil;
};

const arm = () => {
  selfRestart.arm(dataDir, { requestedAt: new Date().toISOString(), reason: 'fixture restart', requestedBy: 'fixture' });
  writeFileSync(join(dataDir, 'armed'), 'yes');
};

const startTurn = () => {
  agent.state.status = 'inferring';
  if (mode !== 'unseen-turn') trace({ type: 'inference:started', agentName: 'fixture' });
  if (mode !== 'arm-after-idle' && mode !== 'late-arm-gap' && !quiet) arm();
  if (mode === 'sigterm-first') return;
  setTimeout(() => {
    agent.state.status = 'idle';
    if (quiet) writeFileSync(join(dataDir, 'turn-ended'), String(Date.now()));
    if (hold) {
      heldFrom = Date.now();
      heldUntil = heldFrom + (hold === 'wake-gap' ? 1800 : hold === 'late-script' ? 1200 : 1000);
    }
    if (quiet) quietAt(hold ? heldUntil : Date.now());
    if (blip) {
      setTimeout(() => {
        trace({ type: 'inference:started', agentName: 'fixture' });
        quietAt(Date.now());
      }, 100);
    }
    if (mode === 'cancel-in-wait') setTimeout(() => selfRestart.cancel(), 800);
    if (mode === 'arm-after-idle') setTimeout(arm, 1500);
    if (mode === 'late-arm-gap') setTimeout(() => { heldFrom = Date.now(); heldUntil = heldFrom + 800; arm(); }, 1500);
  }, 300);
};
const pushEvent = (event: { content?: string }) => {
  writeFileSync(join(dataDir, 'texts-taken'), '');
  appendFileSync(join(dataDir, 'pushes'), `${generation} ${event.content}\n`);
  if (event.content === 'throws' && generation === 0) throw new Error('Queue is closed');
  if (event.content?.startsWith('stuck') && generation === 0) return;
  if (event.content === 'switch') {
    trace({ type: 'process:completed', processEvent: event });
    replaceFramework();
    quietAt(Date.now());
    return;
  }
  if (event.content === 'switch to a successor') {
    trace({ type: 'inference:tool_calls_yielded', agentName: 'fixture', calls: [{ id: 'call-before-the-switch', name: 'look' }] });
    trace({ type: 'process:completed', processEvent: event });
    replaceFramework([{ name: 'successor', state: { status: 'idle' } }]);
    quietAt(Date.now());
    return;
  }
  if (event.content === 'switch, then the old framework traces') {
    trace({ type: 'process:completed', processEvent: event });
    const replaced = listeners;
    replaceFramework();
    for (const listener of [...replaced]) listener({ type: 'replaced-framework-trace' });
    trace({ type: 'new-framework-trace' });
    quietAt(Date.now());
    return;
  }
  if (textSlow || event.content === 'slow' || event.content === 'throws' || event.content?.startsWith('stuck')) {
    setTimeout(() => {
      trace({ type: 'process:completed', processEvent: event });
      quietAt(Date.now());
      writeFileSync(join(dataDir, 'processed-at'), String(Date.now()));
    }, 900);
    return;
  }
  if (!textQueued) {
    trace({ type: 'process:completed', processEvent: event });
    quietAt(Date.now());
    return;
  }
  textHeld = true;
  const releasing = setInterval(() => {
    if (!existsSync(join(dataDir, 'release-queue'))) return;
    clearInterval(releasing);
    textHeld = false;
    quietAt(Date.now() + 300);
    trace({ type: 'process:completed', processEvent: event });
    agent.state.status = 'inferring';
    trace({ type: 'inference:started', agentName: 'fixture' });
    setTimeout(() => { agent.state.status = 'idle'; }, 300);
  }, 20);
};
if (mode === 'quiet-idle') {
  const going = setInterval(() => {
    if (!existsSync(join(dataDir, 'go'))) return;
    clearInterval(going);
    startTurn();
  }, 20);
  const switchFlag = setInterval(() => {
    if (!existsSync(join(dataDir, 'switch-begun'))) return;
    app.switching = true;
    writeFileSync(join(dataDir, 'switching'), '');
    if (!existsSync(join(dataDir, 'switch-ended'))) return;
    clearInterval(switchFlag);
    app.switching = false;
  }, 20);
  const switching = setInterval(() => {
    if (!existsSync(join(dataDir, 'switch-busy'))) return;
    clearInterval(switching);
    replaceFramework();
    agent.state.status = 'inferring';
    trace({ type: 'inference:started', agentName: 'fixture' });
    setTimeout(() => {
      agent.state.status = 'idle';
      trace({ type: 'inference:completed', agentName: 'fixture' });
    }, 300);
  }, 20);
} else if (mode !== 'text-exit') {
  setTimeout(startTurn, 200);
}

const framework = (agents: Array<{ name: string; state: { status: string } }> = [agent]) => {
  const own: Array<(event: unknown) => void> = [];
  listeners = own;
  return {
    getAllAgents: () => agents,
    onTrace: (cb: (event: unknown) => void) => {
      own.push(cb);
      return () => { if (own.includes(cb)) own.splice(own.indexOf(cb), 1); };
    },
    getHostModeStatus: () => ({
      drained: !holding('turn'),
      activeTurns: holding('turn') ? 1 : 0,
      parkedAdmissions: 0,
      gatedRequests: holding('gated') ? 1 : 0,
      backgroundScripts: holding('script') ? 1 : 0,
    }),
    getQueueDepth: () => (holding('queue') ? 1 : 0),
    pushEvent,
    getAllModules: () => hold?.startsWith('subagent') || hold === 'wake-gap'
      ? [{ name: 'subagent', getConcurrencyStatus: () => ({ active: holding('subagent-active') ? 1 : 0, queued: holding('subagent-queued') ? 1 : 0 }) }]
      : [],
    async stop() {
      const early = quiet ? Date.now() < quietFrom + 540 : heldUntil > 0 && Date.now() < heldUntil + 540;
      writeFileSync(join(dataDir, 'stopped'), `${agent.state.status}${early ? ' in-flight' : ''}`);
    },
  };
};
const app: { recipe: unknown; agentName: string; framework: ReturnType<typeof framework>; onFrameworkReplaced?: () => void; switching?: boolean } = {
  recipe: { name: 'Self-restart test', agent: { name: 'fixture' } },
  agentName: 'fixture',
  framework: framework(),
};
function replaceFramework(agents?: Array<{ name: string; state: { status: string } }>): void {
  generation += 1;
  app.framework = framework(agents);
  app.onFrameworkReplaced?.();
}
await runHeadless(app as unknown as AppContext, ['exit-when-idle', 'cancel-in-wait', 'quiet-exit', 'text-exit'].includes(mode) ? ['--exit-when-idle'] : []);
