import { existsSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { join } from 'node:path';
import { runHeadless } from '../src/headless.ts';
import type { AppContext } from '../src/index.ts';

const dataDir = process.env.DATA_DIR!;
let refused = 0;
const write = Socket.prototype.write;
Socket.prototype.write = function (this: Socket, ...args: unknown[]): boolean {
  const accepted = (write as (...given: unknown[]) => boolean).apply(this, args);
  if (!accepted) refused += 1;
  return accepted;
} as typeof Socket.prototype.write;

const listeners: Array<(event: unknown) => void> = [];
let bursts = 0;
setInterval(() => {
  const next = join(dataDir, `burst-${bursts + 1}`);
  if (!existsSync(next)) return;
  bursts += 1;
  for (let n = 0; n < 8_000; n += 1) {
    const event = { type: 'inference:tokens', agentName: 'resident', content: ' token', blockType: 'text', blockIndex: 0, timestamp: Date.now() };
    for (const listener of listeners) listener(event);
  }
  writeFileSync(`${next}-sent`, String(refused));
}, 10);

await runHeadless({
  recipe: { name: 'Flood', agent: { name: 'resident' } },
  agentName: 'resident',
  framework: {
    getAllAgents: () => [{ name: 'resident', state: { status: 'idle' } }],
    getAllModules: () => [],
    getHostModeStatus: () => ({ drained: true, activeTurnAgents: [], parkedAdmissions: 0, gatedRequests: 0, backgroundScripts: 0 }),
    getQueueDepth: () => 0,
    onTrace: (listener: (event: unknown) => void) => { listeners.push(listener); return () => {}; },
    stop: async () => {},
  },
} as unknown as AppContext, [], process.env.STOPPED_READING_MS ? { stoppedReadingMs: Number(process.env.STOPPED_READING_MS) } : {});
