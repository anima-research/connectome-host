import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listenQuarantineSocket } from '../src/quarantine-socket.js';

for (const before of [true, false]) {
  test(`optional listener cancellation ${before ? 'before' : 'immediately after'} bind leaves no own reservation`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'q-cancel-'));
    const abort = new AbortController();
    try {
      if (before) abort.abort();
      const starting = listenQuarantineSocket(dir, { signal: abort.signal, ready: {}, log: () => {}, handle: async () => ({}) });
      abort.abort();
      await expect(starting).rejects.toThrow();
      expect(existsSync(join(dir, 'q/s'))).toBe(false);
      expect(existsSync(join(dir, 'q/owner.json'))).toBe(false);
      expect(before ? existsSync(join(dir, 'q')) : readdirSync(join(dir, 'q')).length > 0).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
