import { Server } from 'node:net';

const listen = Server.prototype.listen;
Server.prototype.listen = function (this: Server, ...args: unknown[]) {
  if (typeof args[0] !== 'string') return listen.apply(this, args as Parameters<typeof listen>);
  setTimeout(() => listen.apply(this, args as Parameters<typeof listen>), 1_000);
  return this;
} as typeof listen;
