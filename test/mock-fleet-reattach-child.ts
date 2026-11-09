import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runHeadless } from '../src/headless.ts';
import type { AppContext } from '../src/index.ts';

const dataDir = process.env.DATA_DIR!;
const listeners: Array<(event: unknown) => void> = [];
const trace = (event: Record<string, unknown>): void => {
  for (const listener of listeners) listener({ agentName: 'resident', timestamp: Date.now(), ...event });
};
let bursts = 0;
let replies = 0;
let markers = 0;
let blocked = false;
let chattering = false;
let unlinked = false;
setInterval(() => {
  const next = join(dataDir, `burst-${bursts + 1}`);
  if (existsSync(next)) {
    bursts += 1;
    for (let n = 0; n < 8_000; n += 1) trace({ type: 'inference:tokens', content: ' token', blockType: 'text', blockIndex: 0 });
    writeFileSync(`${next}-sent`, '');
  }
  const reply = join(dataDir, `reply-${replies + 1}`);
  if (existsSync(reply)) {
    replies += 1;
    trace({ type: 'inference:started' });
    trace({ type: 'inference:tokens', content: readFileSync(reply, 'utf8'), blockType: 'text', blockIndex: 0 });
    trace({ type: 'inference:completed' });
  }
  const marker = join(dataDir, `marker-${markers + 1}`);
  if (existsSync(marker)) {
    markers += 1;
    trace({ type: 'probe:marker' });
    trace({ type: 'inference:tokens', content: `after marker ${markers}`, blockType: 'text', blockIndex: 0 });
  }
  if (!chattering && existsSync(join(dataDir, 'chatter'))) {
    chattering = true;
    setInterval(() => trace({ type: 'probe:marker' }), 5);
    writeFileSync(join(dataDir, 'chattering'), '');
  }
  if (!blocked && existsSync(join(dataDir, 'block'))) {
    blocked = true;
    writeFileSync(join(dataDir, 'blocking'), '');
    const until = Date.now() + Number(process.env.BLOCK_MS ?? 4_000);
    while (Date.now() < until && !existsSync(join(dataDir, 'release'))) { }
    writeFileSync(join(dataDir, 'unblocked'), '');
  }
  if (!unlinked && existsSync(join(dataDir, 'unlink'))) {
    unlinked = true;
    unlinkSync(join(dataDir, 'ipc.sock'));
    writeFileSync(join(dataDir, 'unlinked'), '');
  }
}, 10);

await runHeadless({
  recipe: { name: 'Reattach', agent: { name: 'resident' } },
  agentName: 'resident',
  framework: {
    getAllAgents: () => [{ name: 'resident', state: { status: 'idle' } }],
    getAllModules: () => [],
    getHostModeStatus: () => ({ drained: true, activeTurnAgents: [], parkedAdmissions: 0, gatedRequests: 0, backgroundScripts: 0 }),
    getQueueDepth: () => 0,
    onTrace: (listener: (event: unknown) => void) => { listeners.push(listener); return () => {}; },
    pushEvent: (event: { content?: unknown }) => {
      appendFileSync(join(dataDir, 'texts'), `${String(event.content)}\n`);
      setTimeout(() => trace({ type: 'process:completed', processEvent: event }), 0);
    },
    stop: async () => {},
  },
} as unknown as AppContext, [], { stoppedReadingMs: 500 });
