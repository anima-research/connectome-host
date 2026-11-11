// Lifecycle-only fake: no framework start, native keyed API or provider work.
import { runHeadless } from '../src/headless.js';
import type { AppContext } from '../src/index.js';
import { Server } from 'node:net';
import { existsSync, readFileSync, readdirSync, readlinkSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.DATA_DIR!;
const mode = process.argv[2];
let releaseListen: (() => void) | undefined;
const controls = new Set<Server>();
{
  const listen = Server.prototype.listen;
  Server.prototype.listen = function (this: Server, ...args: any[]) {
    const path = String(args[0]);
    const control = path.includes('/.bind-');
    if (control) controls.add(this);
    if (mode !== 'normal' && (mode === 'interactive-window' ? !control : control) && typeof args.at(-1) === 'function') {
      const callback = args.at(-1);
      args[args.length - 1] = function (this: Server, ...callbackArgs: any[]) {
        releaseListen = () => callback.apply(this, callbackArgs);
        if (mode === 'replaced-claim') {
          renameSync(join(dir, 'q', 's'), join(dir, 'q', 'retired-s'));
          renameSync(join(dir, 'q', 'owner.json'), join(dir, 'q', 'retired-owner'));
          writeFileSync(join(dir, 'q', 's'), 'unknown endpoint');
          writeFileSync(join(dir, 'q', 'owner.json'), 'unknown claim');
        }
        writeFileSync(join(dir, 'held'), 'yes');
      };
    }
    return listen.apply(this, args as Parameters<typeof listen>);
  } as typeof listen;
}
const snapshot = () => ({
  socket: existsSync(join(dir, 'q', 's')),
  claim: existsSync(join(dir, 'q', 'owner.json')),
  listening: [...controls].some(server => server.listening),
  aliases: existsSync(join(dir, 'q')) ? readdirSync(join(dir, 'q')).filter(name => name.startsWith('.bind-')).length : 0,
  // Count only descriptors anchored to this fixture's optional channel.
  controlFDs: readdirSync('/proc/self/fd').filter(fd => {
    try { return readlinkSync('/proc/self/fd/' + fd).startsWith(join(dir, 'q')); }
    catch { return false; }
  }).length,
});
let stopCalls = 0;
await runHeadless({
  recipe: { name: 'Control startup fixture', agent: { name: 'fixture' } }, agentName: 'fixture',
  framework: {
    getAllAgents: () => [{ name: 'fixture', state: { status: 'idle' } }],
    getHostModeStatus: () => ({ drained: true, activeTurnAgents: [], parkedAdmissions: 0, gatedRequests: 0, backgroundScripts: 0 }),
    getQueueDepth: () => 0, getAllModules: () => [], onTrace: () => () => {},
    async stop() {
      stopCalls++;
      const before = snapshot();
      releaseListen?.(); // Deliberately late: may not resurrect optional startup.
      await new Promise<void>(resolve => setImmediate(resolve));
      await new Promise<void>(resolve => setImmediate(resolve));
      writeFileSync(join(dir, 'stopped.json'), JSON.stringify({ stopCalls, before, after: snapshot() }));
      if (mode === 'replaced-claim') {
        writeFileSync(join(dir, 'preserved.json'), JSON.stringify({
          socket: readFileSync(join(dir, 'q', 's'), 'utf8'),
          claim: readFileSync(join(dir, 'q', 'owner.json'), 'utf8'),
        }));
      }
    },
  },
} as unknown as AppContext);
