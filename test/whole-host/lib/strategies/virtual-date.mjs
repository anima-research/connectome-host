import { connect } from 'node:net';
import { lineReader } from './control.mjs';

const RealDate = globalThis.Date;
const epoch = /^\d+$/.test(process.env.FIXTURE_EPOCH_MS ?? '') ? Number(process.env.FIXTURE_EPOCH_MS) : NaN;
if (!Number.isSafeInteger(epoch)) {
  throw new Error(`the strategy fixture's Date preload needs FIXTURE_EPOCH_MS, a time in milliseconds (got ${JSON.stringify(process.env.FIXTURE_EPOCH_MS)})`);
}
let now = epoch;

function VirtualDate(...args) {
  if (!new.target) return new RealDate(now).toString();
  return Reflect.construct(RealDate, args.length === 0 ? [now] : args, new.target);
}
VirtualDate.prototype = RealDate.prototype;
VirtualDate.now = () => now;
VirtualDate.parse = RealDate.parse;
VirtualDate.UTC = RealDate.UTC;
Object.defineProperty(VirtualDate, 'name', { value: 'Date' });
Object.defineProperty(RealDate.prototype, 'constructor', { value: VirtualDate, writable: true, configurable: true, enumerable: false });
globalThis.Date = VirtualDate;

const path = process.env.FIXTURE_CONTROL;
if (path) {
  const sock = connect(path, () => sock.write(`${JSON.stringify({ type: 'hello', peer: 'clock', pid: process.pid })}\n`));
  sock.unref();
  sock.on('error', (e) => console.error(`[fixture-clock] control socket ${path}: ${e.message}`));
  lineReader(sock, (msg) => {
    if (msg.op !== 'advance') return;
    let reply;
    if (!Number.isFinite(msg.at)) reply = { error: { code: -32602, message: `at must be a time in milliseconds (got ${JSON.stringify(msg.at)})` } };
    else if (msg.at < now) reply = { error: { code: -32602, message: `the clock doesn't go back: asked for ${msg.at}, and it reads ${now}` } };
    else { now = msg.at; reply = { result: { at: now } }; }
    sock.write(`${JSON.stringify({ id: msg.id, ...reply })}\n`);
  });
}
