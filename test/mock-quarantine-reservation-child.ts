// Fake listener only. Parent releases both separately spawned processes together.
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [dir, role] = process.argv.slice(2);
writeFileSync(join(dir, `${role}-started`), String(process.pid));
while (!existsSync(join(dir, 'go'))) await Bun.sleep(5);
if (role === 'pause-claim') {
  const fs = await import('node:fs');
  const { mock } = await import('bun:test');
  const original = fs.openSync;
  mock.module('node:fs', () => ({ ...fs, openSync(path: string, ...args: any[]) {
    const fd = (original as any)(path, ...args);
    if (String(path).endsWith('/owner.json')) {
      writeFileSync(join(dir, 'reserved'), 'yes');
      // Models process death after successful O_EXCL but before claim write/bind.
      while (true) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
    return fd;
  } }));
}
const { listenQuarantineSocket } = await import('../src/quarantine-socket.js');
try {
  const control = await listenQuarantineSocket(dir, {
    ready: { pid: process.pid }, log: () => {}, handle: async () => ({ status: role }),
  });
  writeFileSync(join(dir, `${role}-ready`), 'yes');
  process.on('SIGTERM', () => control.close());
} catch (error) {
  writeFileSync(join(dir, `${role}-error`), String(error));
  process.exitCode = 2;
}
