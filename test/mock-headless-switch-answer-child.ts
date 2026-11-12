import { runHeadless } from '../src/headless.js';
import type { AppContext } from '../src/index.js';
import { trackOperatorWork } from '../src/session-switch.js';

const mode = process.env.ANSWER_MODE;
if (!['quiet', 'credential', 'operator', 'subagents', 'switch-begun', 'refused-text'].includes(mode ?? '')) {
  throw new Error('Unknown switch-answer fixture mode');
}

let quiesced: { quiesced: boolean; reason?: string } = { quiesced: false };
const status = () => ({
  ...quiesced, drained: true, activeTurns: 0, activeTurnAgents: [], parkedAdmissions: 0, gatedRequests: 0,
  backgroundScripts: 0, deferredWrites: 0,
});
const subagents = {
  name: 'subagent',
  getConcurrencyStatus: () => ({ configured: 2, effective: 2, active: 0, queued: 1 }),
  isSubagentAgent: () => false,
};
const app = {
  recipe: { name: 'Switch answer test', agent: { name: 'fixture' } },
  agentName: 'fixture',
  switching: false,
  credentials: { actionInFlight: () => mode === 'credential' },
  framework: {
    getAllAgents: () => [{ name: 'fixture', state: { status: 'idle' } }],
    getAllModules: () => mode === 'subagents' ? [subagents] : [],
    getHostModeStatus: status,
    getQueueDepth: () => 0,
    onTrace: () => () => {},
    listMcplServers: () => [],
    quiesce: async (opts: { reason?: string } = {}) => {
      quiesced = { quiesced: true, reason: opts.reason };
      if (mode === 'switch-begun') app.switching = true;
      return status();
    },
    resume: async () => { quiesced = { quiesced: false }; return status(); },
    stop: async () => {},
    pushEvent: () => { if (mode === 'refused-text') throw new Error('this framework takes no text now'); },
  },
};
if (mode === 'operator') void trackOperatorWork(app, null, new Promise<void>(() => {}));

await runHeadless(app as unknown as AppContext);
