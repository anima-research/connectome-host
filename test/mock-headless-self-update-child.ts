import { runHeadless } from '../src/headless.ts';
import { operatorWorkRunning, trackOperatorWork } from '../src/session-switch.ts';
import type { AppContext } from '../src/index.ts';
import { moveCurrent } from '../src/update/contract.ts';
import { RELEASE_HOST } from '../src/update/launcher.ts';
import { hostUpdate } from '../src/update/update.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const mode = process.argv[2];
const modes = [
  'update', 'token-held-after-turn', 'script-starts-in-quiesce', 'switch-starts-in-quiesce',
  'operator-starts-in-quiesce', 'credential-starts-in-quiesce', 'stop-in-quiesce',
];
if (!modes.includes(mode)) {
  throw new Error('Unknown self-update fixture mode');
}
const dataDir = process.env.DATA_DIR!;
const root = join(dataDir, 'install');

for (const version of ['0.14.1', '0.15.0']) {
  const host = join(root, 'releases', version, RELEASE_HOST);
  mkdirSync(join(host, 'src', 'update'), { recursive: true });
  writeFileSync(join(root, 'releases', version, 'package.json'), JSON.stringify({ dependencies: { '@animalabs/connectome-host': version } }));
  writeFileSync(join(host, 'package.json'), JSON.stringify({ version }));
  writeFileSync(join(host, 'src', 'index.ts'), '');
  writeFileSync(join(host, 'src', 'update', 'launcher.ts'), 'export function launch() {}');
}
moveCurrent(root, '0.14.1');

const agent = { name: 'fixture', state: { status: 'idle' as string } };
const POLLS_PAST_A_QUIET_WINDOW = 7;
const A_POLL_APART_MS = 90;
let armedNow = false;
let turnSeen = 0;
let turnSeenAt = 0;
let tokenHeld = false;
let tokenSeen = 0;
let tokenSeenAt = 0;
let scriptRunning = false;
let scriptStarted = false;
let credentialRunning = false;
let workStarted = false;
let endWork = () => {};
const app = {
  recipe: { name: 'Self-update test', agent: { name: 'fixture' } },
  agentName: 'fixture',
  switching: false,
  stopping: false,
  credentials: { actionInFlight: () => credentialRunning },
};
let quiesced: { quiesced: boolean; reason?: string } = { quiesced: false };
const held = () => tokenHeld;
const scripting = () => scriptRunning;
const status = () => {
  if (tokenHeld && Date.now() - tokenSeenAt >= A_POLL_APART_MS) {
    tokenSeen += 1;
    tokenSeenAt = Date.now();
  }
  return statusNow();
};
const statusNow = () => ({
  ...quiesced, drained: !held(), activeTurns: held() ? 1 : 0, parkedAdmissions: 0, gatedRequests: 0, backgroundScripts: scripting() ? 1 : 0,
  deferredWrites: 0, activeTurnAgents: held() ? ['fixture'] : [],
});
const framework = {
  getAllAgents: () => {
    if (armedNow && agent.state.status !== 'idle' && Date.now() - turnSeenAt >= A_POLL_APART_MS) {
      turnSeen += 1;
      turnSeenAt = Date.now();
    }
    return [agent];
  },
  onTrace: () => () => {},
  getHostModeStatus: status,
  quiesce: async (opts: { reason?: string } = {}) => {
    if (agent.state.status !== 'idle' || held()) writeFileSync(join(dataDir, 'quiesced-while-busy'), agent.state.status);
    quiesced = { quiesced: true, reason: opts.reason };
    if (mode === 'script-starts-in-quiesce' && !scriptStarted) {
      scriptStarted = true;
      scriptRunning = true;
      startWork(() => { scriptRunning = false; });
      writeFileSync(join(dataDir, 'started'), 'script');
    }
    if (mode === 'switch-starts-in-quiesce' && !scriptStarted) {
      scriptStarted = true;
      app.switching = true;
      startWork(() => { app.switching = false; });
      writeFileSync(join(dataDir, 'started'), 'switch');
    }
    if (mode === 'operator-starts-in-quiesce' && !scriptStarted) {
      scriptStarted = true;
      void trackOperatorWork(app, null, new Promise<void>((done) => { startWork(done); }));
      writeFileSync(join(dataDir, 'started'), 'operator');
    }
    if (mode === 'credential-starts-in-quiesce' && !scriptStarted) {
      scriptStarted = true;
      credentialRunning = true;
      startWork(() => { credentialRunning = false; });
      writeFileSync(join(dataDir, 'started'), 'credential');
    }
    if (mode === 'stop-in-quiesce' && !scriptStarted) {
      scriptStarted = true;
      process.kill(process.pid, 'SIGTERM');
      while (!app.stopping) await new Promise((done) => setTimeout(done, 10));
      writeFileSync(join(dataDir, 'started'), 'stop');
    }
    return status();
  },
  resume: async () => { quiesced = { quiesced: false }; return status(); },
  getQueueDepth: () => 0,
  getAllModules: () => [],
  listMcplServers: () => [],
  async stop() {
    writeFileSync(join(dataDir, 'stopped'), `${agent.state.status}${held() ? ' in-flight' : ''}${scripting() ? ' script' : ''}${app.switching ? ' switching' : ''}${operatorWorkRunning(app) ? ' operator' : ''}${app.credentials.actionInFlight() ? ' credential' : ''}`);
  },
};

hostUpdate.configure({
  here: { root, release: '0.14.1' },
  running: '0.14.1',
  host: { framework: () => framework as never, fleet: () => null },
  env: { CONNECTOME_SUPERVISED: '1' },
  ...(mode.endsWith('-starts-in-quiesce') ? { waits: { restartMs: 120_000, longerMs: 600_000, armedRetryMs: 200 } } : {}),
  log: () => {},
});

agent.state.status = 'inferring';
const arming = setInterval(() => {
  const answer = hostUpdate.armRestart('fixture');
  if (!answer.done) return;
  clearInterval(arming);
  writeFileSync(join(dataDir, 'armed'), JSON.stringify(answer));
  armedNow = true;
}, 10);

function startWork(end: () => void): void {
  workStarted = true;
  endWork = end;
}

const letting = setInterval(() => {
  if (armedNow && agent.state.status !== 'idle' && turnSeen >= POLLS_PAST_A_QUIET_WINDOW) {
    writeFileSync(join(dataDir, 'seen-turn'), String(turnSeen));
    agent.state.status = 'idle';
    if (mode === 'token-held-after-turn') tokenHeld = true;
  }
  if (tokenHeld && tokenSeen >= POLLS_PAST_A_QUIET_WINDOW) {
    writeFileSync(join(dataDir, 'seen-token'), String(tokenSeen));
    tokenHeld = false;
  }
  const lastTry = hostUpdate.armedSwitch()?.lastTry ?? null;
  if (workStarted && lastTry !== null) {
    writeFileSync(join(dataDir, 'blocked'), lastTry.waited);
    workStarted = false;
    endWork();
  }
  if (app.stopping) clearInterval(letting);
}, 10);

await runHeadless(Object.assign(app, { framework }) as unknown as AppContext, []);
