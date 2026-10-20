import { runHeadless } from '../src/headless.ts';
import type { AppContext } from '../src/index.ts';
import { WriteStream, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Server, connect, type Socket } from 'node:net';
import { once } from 'node:events';
import { slowLogWrites } from './slow-log-writes.ts';

const mode = process.argv[2];
if (!['healthy', 'failure', 'delayed-failure', 'ready-window', 'slow-log-failure', 'late-write-failure', 'stuck-log'].includes(mode)) throw new Error('Unknown shutdown fixture mode');
// A slow disk: each write to headless.log lands 100 ms after it's made.
// A stuck one: no write ever finishes.
if (mode === 'slow-log-failure' || mode === 'late-write-failure') slowLogWrites(100);
if (mode === 'stuck-log') slowLogWrites(Infinity);
// Each write's callback records the error it was given, or null, in a file
// named for the write, and, for a write made before the log ends, whether
// headless.log held its line when the callback ran; the mock notes that it
// was answered.
const answered: Array<Promise<void>> = [];
const recordCallback = (file: string, line?: string) => {
  let answer!: () => void;
  answered.push(new Promise<void>((resolve) => { answer = resolve; }));
  return (err?: Error | null) => {
    const landed = line === undefined ? {} : { landed: readFileSync(join(process.env.DATA_DIR!, 'headless.log'), 'utf8').includes(line) };
    writeFileSync(join(process.env.DATA_DIR!, file), JSON.stringify({ error: err ? String((err as NodeJS.ErrnoException).code ?? err) : null, ...landed }));
    answer();
  };
};
// A stdout write in each form a callback can come in (second, after an
// undefined encoding, after a named one) and a stderr write, each with a
// callback.
const writes = (when: 'before' | 'after') => {
  const checked = (line: string) => (when === 'before' ? line : undefined);
  const second = `a line written ${when} the log ended, its callback second\n`;
  process.stdout.write(second, recordCallback(`callback-${when}-second.json`, checked(second)));
  const undefinedEncoding = `a line written ${when} the log ended, after an undefined encoding\n`;
  process.stdout.write(undefinedEncoding, undefined, recordCallback(`callback-${when}-undefined.json`, checked(undefinedEncoding)));
  const utf8 = `a line written ${when} the log ended, after utf8\n`;
  process.stdout.write(utf8, 'utf8', recordCallback(`callback-${when}-utf8.json`, checked(utf8)));
  const stderrLine = `a stderr line written ${when} the log ended\n`;
  process.stderr.write(stderrLine, recordCallback(`callback-${when}-stderr.json`, checked(stderrLine)));
};
// The late writes are made as the shutdown ends headless.log's stream, while
// the slow disk still holds what was written before: stdout writes in each
// callback form, a stderr write, and a client's line, which the host logs as
// malformed through its own log(). The end's callback waits until every late
// write's callback has been answered, which comes once its write to the
// process's stderr has completed, and until the host's log line for the
// client has been written there too, through the write runHeadless saves
// before its redirect (the one wrapped here). So all of it is on stderr
// before the exit; if any of it never is, the exit waits out the 2 s limit
// and the test finds it missing.
let lateClient: Socket | undefined;
if (mode === 'late-write-failure') {
  let clientLineLogged!: () => void;
  const logged = new Promise<void>((resolve) => { clientLineLogged = resolve; });
  const stderrWrite = process.stderr.write.bind(process.stderr) as (...args: unknown[]) => boolean;
  process.stderr.write = ((chunk: unknown, encodingOrCb?: unknown, cb?: unknown) => {
    if (!String(chunk).includes('a client line after the log ended')) return stderrWrite(chunk, encodingOrCb, cb);
    const given = (typeof encodingOrCb === 'function' ? encodingOrCb : cb) as ((err?: Error | null) => void) | undefined;
    return stderrWrite(chunk, typeof encodingOrCb === 'function' ? undefined : encodingOrCb, (err?: Error | null) => {
      given?.(err);
      clientLineLogged();
    });
  }) as typeof process.stderr.write;
  const end = WriteStream.prototype.end;
  WriteStream.prototype.end = function (this: WriteStream, ...args: unknown[]) {
    if (!String(this.path).endsWith('headless.log')) return end.apply(this, args as Parameters<typeof end>);
    const done = typeof args.at(-1) === 'function' ? args.pop() as (err?: Error | null) => void : undefined;
    const result = end.apply(this, [...args, (err?: Error | null) => {
      void Promise.all([logged, ...answered]).then(() => done?.(err));
    }] as Parameters<typeof end>);
    writes('after');
    lateClient?.write('a client line after the log ended\n');
    return result;
  } as typeof end;
}
// Hold the actual listen callback until shutdown has entered framework.stop.
// The server can accept a client and send ready while that callback is held.
const order: string[] = [];
let releaseListen: (() => void) | undefined;
if (mode === 'ready-window') {
  const listen = Server.prototype.listen;
  Server.prototype.listen = function (this: Server, ...args: any[]) {
    const callback = args.at(-1);
    if (typeof callback === 'function') {
      args[args.length - 1] = function (this: Server, ...callbackArgs: any[]) {
        const receiver = this;
        releaseListen = () => {
          callback.apply(receiver, callbackArgs);
          order.push('listen-callback');
        };
      };
    }
    return listen.apply(this, args as Parameters<typeof listen>);
  } as typeof listen;
}
let stopCalls = 0;
await runHeadless({
  recipe: { name: 'Shutdown test', agent: { name: 'fixture' } },
  agentName: 'fixture',
  framework: {
    getAllAgents: () => [{ name: 'fixture', state: { status: 'idle' } }],
    onTrace: () => () => {},
    async stop() {
      stopCalls++;
      if (mode === 'ready-window') {
        order.push('stop-entered');
        if (!releaseListen) throw new Error('Listen callback was not held');
        releaseListen();
        // Let runHeadless finish its post-listen startup continuation before cleanup.
        await new Promise<void>(resolve => setImmediate(resolve));
        order.push('stop-returning');
        writeFileSync(join(process.env.DATA_DIR!, 'stop-order.json'), JSON.stringify(order));
      }
      if (mode === 'delayed-failure') await new Promise(resolve => setTimeout(resolve, 100));
      writeFileSync(join(process.env.DATA_DIR!, 'stop-calls.json'), JSON.stringify({ stopCalls }));
      // The writes before the log ends, and the client whose line comes once
      // it has: the host has accepted it once its first event arrives, so
      // the server's close at the shutdown can't drop it.
      if (mode === 'late-write-failure') {
        writes('before');
        lateClient = connect(join(process.env.DATA_DIR!, 'ipc.sock'));
        await once(lateClient, 'data');
      }
      if (mode.endsWith('failure')) throw new Error('injected framework stop failure');
    },
  },
} as unknown as AppContext);
