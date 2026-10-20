// endHeadlessLog before runHeadless has opened a log: a fatal error that
// comes that early still exits, rather than waiting on a log that isn't there.
import { test, expect } from 'bun:test';
import { endHeadlessLog } from '../src/headless.ts';

test('with no log open, endHeadlessLog resolves at once', async () => {
  // At once: before a timer of no delay set before the call fires, which
  // any wait inside it, even one of no delay, would follow.
  const timer = new Promise((resolve) => setTimeout(() => resolve('timer'), 0));
  const first = await Promise.race([endHeadlessLog().then(() => 'resolved'), timer]);
  expect(first).toBe('resolved');
});
