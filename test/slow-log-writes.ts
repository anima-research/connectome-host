// A slow or stuck disk for headless.log: every fs.WriteStream write lands
// `ms` late, or never when `ms` is Infinity. The shutdown mock calls it, and
// the fatal smoke case preloads this file into a real host (bun --preload)
// with SLOW_LOG_WRITES_MS set.
import { WriteStream } from 'node:fs';

export function slowLogWrites(ms: number): void {
  const proto = WriteStream.prototype as unknown as Record<'_write' | '_writev', ((...args: unknown[]) => void) | undefined>;
  for (const key of ['_write', '_writev'] as const) {
    const write = proto[key];
    if (write) {
      proto[key] = ms === Infinity
        ? function () { /* never calls back */ }
        : function (this: unknown, ...args: unknown[]) { setTimeout(() => write.apply(this, args), ms); };
    }
  }
}

if (process.env.SLOW_LOG_WRITES_MS) slowLogWrites(Number(process.env.SLOW_LOG_WRITES_MS));
