// A headless host whose one agent takes a turn that arms a self-restart,
// then goes idle. Modes (argv[2]):
// - `self-restart`: the host should exit 75 on its own.
// - `sigterm-first`: the test sends SIGTERM while the turn is still running,
//   so the host exits 0 and the request records that shutdown.
// - `exit-when-idle`: as `self-restart`, under --exit-when-idle.
// - `held`: the agent reads idle, but for 1.5 s something argv[3] names is
//   still in flight: `turn` (a turn token, as while a turn's context and
//   hooks assemble), `gated` (a gated wake), `script` (a background script),
//   `queue` (an event not yet taken off the queue), `subagent-active` or
//   `subagent-queued` (a subagent run). `wake-gap`: a subagent run ends
//   after 1 s, nothing is in flight for 150 ms, as while its wake waits on
//   the framework's loop, and then the wake's turn holds a token until 1.8 s.
// - `cancel-in-wait`: under --exit-when-idle, a turn token holds the armed
//   restart back, and the restart is cancelled meanwhile with no inference
//   (as /puppet would), so the host should exit 0 as --exit-when-idle asks.
// - `arm-after-idle`: a first turn ends without arming; the restart is
//   armed only after the host has gone quiet.
// - `late-arm-gap`: as `arm-after-idle`, but the restart is armed in a
//   150 ms gap with nothing in flight, after which a turn holds a token
//   until 800 ms, as when a subagent has just ended and its wake waits.
// - `unseen-turn`: the arming turn's inference:started never reaches the
//   host, as when it ran before runHeadless attached its listener.
// Only `held` with a subagent hold has a subagent module.
import { runHeadless } from '../src/headless.ts';
import type { AppContext } from '../src/index.ts';
import { selfRestart } from '../src/self-restart.ts';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MODES = ['self-restart', 'sigterm-first', 'exit-when-idle', 'held', 'cancel-in-wait', 'arm-after-idle', 'late-arm-gap', 'unseen-turn'];
const HOLDS = ['turn', 'gated', 'script', 'queue', 'subagent-active', 'subagent-queued', 'wake-gap'];
const mode = process.argv[2];
if (!MODES.includes(mode)) throw new Error('Unknown self-restart fixture mode');
const hold = mode === 'cancel-in-wait' ? 'turn' : process.argv[3];
if (mode === 'held' && !HOLDS.includes(hold)) throw new Error('Unknown self-restart fixture hold');
const dataDir = process.env.DATA_DIR!;

const agent = { name: 'fixture', state: { status: 'idle' as string } };
let trace: ((event: unknown) => void) | undefined;
let heldFrom = 0;
let heldUntil = 0;
// Whether `kind` is in flight now: for its whole hold, or in wake-gap its phase.
const holding = (kind: string): boolean => {
  const t = Date.now() - heldFrom;
  if (hold === 'wake-gap') return kind === 'subagent-active' ? t < 1000 : kind === 'turn' && t >= 1150 && t < 1800;
  if (mode === 'late-arm-gap') return heldFrom > 0 && kind === 'turn' && t >= 150 && t < 800;
  return hold === kind && Date.now() < heldUntil;
};

const arm = () => {
  selfRestart.arm(dataDir, { requestedAt: new Date().toISOString(), reason: 'fixture restart', requestedBy: 'fixture' });
  writeFileSync(join(dataDir, 'armed'), 'yes');
};

setTimeout(() => {
  // The turn: inference starts, the tool arms the restart, and (but in the
  // sigterm-first mode) the turn ends 300 ms later.
  agent.state.status = 'inferring';
  if (mode !== 'unseen-turn') trace?.({ type: 'inference:started', agentName: 'fixture' });
  if (mode !== 'arm-after-idle' && mode !== 'late-arm-gap') arm();
  if (mode === 'sigterm-first') return;
  setTimeout(() => {
    agent.state.status = 'idle';
    if (hold) { heldFrom = Date.now(); heldUntil = heldFrom + (hold === 'wake-gap' ? 1800 : 1500); }
    if (mode === 'cancel-in-wait') setTimeout(() => selfRestart.cancel(), 800);
    if (mode === 'arm-after-idle') setTimeout(arm, 1500);
    if (mode === 'late-arm-gap') setTimeout(() => { heldFrom = Date.now(); heldUntil = heldFrom + 800; arm(); }, 1500);
  }, 300);
}, 200);

await runHeadless({
  recipe: { name: 'Self-restart test', agent: { name: 'fixture' } },
  agentName: 'fixture',
  framework: {
    getAllAgents: () => [agent],
    onTrace: (cb: (event: unknown) => void) => { trace = cb; return () => {}; },
    getHostModeStatus: () => ({
      drained: !holding('turn'),
      activeTurns: holding('turn') ? 1 : 0,
      parkedAdmissions: 0,
      gatedRequests: holding('gated') ? 1 : 0,
      backgroundScripts: holding('script') ? 1 : 0,
    }),
    getQueueDepth: () => (holding('queue') ? 1 : 0),
    getAllModules: () => hold?.startsWith('subagent') || hold === 'wake-gap'
      ? [{ name: 'subagent', getConcurrencyStatus: () => ({ active: holding('subagent-active') ? 1 : 0, queued: holding('subagent-queued') ? 1 : 0 }) }]
      : [],
    async stop() {
      writeFileSync(join(dataDir, 'stopped'), `${agent.state.status}${Date.now() < heldUntil ? ' in-flight' : ''}`);
    },
  },
} as unknown as AppContext, mode === 'exit-when-idle' || mode === 'cancel-in-wait' ? ['--exit-when-idle'] : []);
