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
let heldUntil = 0;
let scriptUntil = 0;
let scriptStarted = false;
let credentialUntil = 0;
const app = {
  recipe: { name: 'Self-update test', agent: { name: 'fixture' } },
  agentName: 'fixture',
  switching: false,
  stopping: false,
  credentials: { actionInFlight: () => Date.now() < credentialUntil },
};
let quiesced: { quiesced: boolean; reason?: string } = { quiesced: false };
const held = () => Date.now() < heldUntil;
const scripting = () => Date.now() < scriptUntil;
const status = () => ({
  ...quiesced, drained: !held(), activeTurns: held() ? 1 : 0, parkedAdmissions: 0, gatedRequests: 0, backgroundScripts: scripting() ? 1 : 0,
  deferredWrites: 0, activeTurnAgents: held() ? ['fixture'] : [],
});
const framework = {
  getAllAgents: () => [agent],
  onTrace: () => () => {},
  getHostModeStatus: status,
  quiesce: async (opts: { reason?: string } = {}) => {
    quiesced = { quiesced: true, reason: opts.reason };
    if (mode === 'script-starts-in-quiesce' && !scriptStarted) {
      scriptStarted = true;
      scriptUntil = Date.now() + 4000;
      writeFileSync(join(dataDir, 'started'), 'script');
    }
    if (mode === 'switch-starts-in-quiesce' && !scriptStarted) {
      scriptStarted = true;
      app.switching = true;
      setTimeout(() => { app.switching = false; }, 4000);
      writeFileSync(join(dataDir, 'started'), 'switch');
    }
    if (mode === 'operator-starts-in-quiesce' && !scriptStarted) {
      scriptStarted = true;
      void trackOperatorWork(app, null, new Promise((done) => setTimeout(done, 4000)));
      writeFileSync(join(dataDir, 'started'), 'operator');
    }
    if (mode === 'credential-starts-in-quiesce' && !scriptStarted) {
      scriptStarted = true;
      credentialUntil = Date.now() + 4000;
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
    while (hostUpdate.armedSwitch() !== null) await new Promise((done) => setTimeout(done, 10));
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
  setTimeout(() => {
    agent.state.status = 'idle';
    if (mode === 'token-held-after-turn') heldUntil = Date.now() + 1500;
  }, 1200);
}, 10);

await runHeadless(Object.assign(app, { framework }) as unknown as AppContext, []);
